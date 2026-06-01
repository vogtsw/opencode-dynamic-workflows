import { generateRunId, saveRun } from "./persistence.js";
import { countTasks, validateOptions } from "./spec-parser.js";
const DISABLED_TOOLS = {
    workflow_run: false,
    workflow_list: false,
    workflow_run_saved: false,
    workflow_show: false,
};
function parseModel(model) {
    if (!model)
        return undefined;
    const slash = model.indexOf("/");
    if (slash <= 0 || slash === model.length - 1)
        return undefined;
    return {
        providerID: model.slice(0, slash),
        modelID: model.slice(slash + 1),
    };
}
function extractText(parts) {
    return parts
        .filter((p) => p.type === "text" && !p.synthetic && !p.ignored)
        .map((p) => p.text)
        .join("\n")
        .trim();
}
async function runTask(client, task, directory, parentID, defaultAgent, defaultModel, phaseContext, abort) {
    const start = Date.now();
    const agent = task.agent ?? defaultAgent;
    const model = task.model ?? defaultModel;
    let sessionId = "";
    try {
        if (abort.aborted) {
            return {
                taskId: task.id,
                sessionId,
                status: "skipped",
                output: "",
                elapsedMs: 0,
            };
        }
        const session = await client.session.create({
            body: { parentID, title: task.description },
            query: { directory },
        });
        sessionId = session.data.id;
        let fullPrompt = task.prompt;
        if (phaseContext) {
            fullPrompt = `${phaseContext}\n\n---\n\n${task.prompt}`;
        }
        const response = await client.session.prompt({
            path: { id: sessionId },
            query: { directory },
            body: {
                agent,
                model: parseModel(model),
                tools: DISABLED_TOOLS,
                parts: [{ type: "text", text: fullPrompt }],
            },
        });
        const elapsed = Date.now() - start;
        const parts = response.data.parts;
        const output = extractText(parts);
        const info = response.data.info;
        const failed = info.error !== undefined;
        return {
            taskId: task.id,
            sessionId,
            status: failed ? "failed" : "completed",
            output,
            elapsedMs: elapsed,
            error: failed ? info.error?.data?.message ?? "Task failed" : undefined,
        };
    }
    catch (err) {
        return {
            taskId: task.id,
            sessionId,
            status: "failed",
            output: "",
            elapsedMs: Date.now() - start,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}
async function runSynthesis(client, phase, taskResults, directory, parentID, defaultAgent, defaultModel, abort) {
    const start = Date.now();
    const resultsText = taskResults
        .map((tr) => `### ${tr.taskId}\n${tr.output || "(no output)"}`)
        .join("\n\n---\n\n");
    const prompt = `${phase.synthesisPrompt}\n\n## Task Results\n\n${resultsText}`;
    const session = await client.session.create({
        body: { parentID, title: `Synthesis: ${phase.title}` },
        query: { directory },
    });
    const sessionId = session.data.id;
    const response = await client.session.prompt({
        path: { id: sessionId },
        query: { directory },
        body: {
            agent: defaultAgent,
            model: parseModel(defaultModel),
            tools: DISABLED_TOOLS,
            parts: [{ type: "text", text: prompt }],
        },
    });
    const elapsed = Date.now() - start;
    const output = extractText(response.data.parts);
    return { output, sessionId, elapsedMs: elapsed };
}
async function executeParallelTasks(client, tasks, directory, parentID, defaultAgent, defaultModel, phaseContext, concurrency, abort) {
    const results = [];
    const pending = [...tasks];
    async function runNext() {
        while (pending.length > 0) {
            if (abort.aborted)
                break;
            const task = pending.shift();
            const result = await runTask(client, task, directory, parentID, defaultAgent, defaultModel, phaseContext, abort);
            results.push(result);
        }
    }
    const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => runNext());
    await Promise.all(workers);
    return results;
}
async function executePhase(client, phase, directory, parentID, defaultAgent, defaultModel, phaseContext, concurrency, abort) {
    const start = Date.now();
    const strategy = phase.strategy ?? "parallel";
    let taskResults;
    if (strategy === "sequential") {
        taskResults = [];
        for (const task of phase.tasks) {
            if (abort.aborted) {
                taskResults.push({
                    taskId: task.id,
                    sessionId: "",
                    status: "skipped",
                    output: "",
                    elapsedMs: 0,
                });
                continue;
            }
            const result = await runTask(client, task, directory, parentID, defaultAgent, defaultModel, phaseContext, abort);
            taskResults.push(result);
            if (result.output) {
                phaseContext = `${phaseContext}\n\n## Previous Task Output (${task.id})\n${result.output}`;
            }
        }
    }
    else {
        taskResults = await executeParallelTasks(client, phase.tasks, directory, parentID, defaultAgent, defaultModel, phaseContext, concurrency, abort);
    }
    let synthesisOutput;
    let synthesisSessionId;
    if (phase.synthesisPrompt && !abort.aborted) {
        const syn = await runSynthesis(client, phase, taskResults, directory, parentID, defaultAgent, defaultModel, abort);
        synthesisOutput = syn.output;
        synthesisSessionId = syn.sessionId;
    }
    const elapsed = Date.now() - start;
    const failedCount = taskResults.filter((t) => t.status === "failed").length;
    const completedCount = taskResults.filter((t) => t.status === "completed").length;
    let status;
    if (failedCount === 0)
        status = "completed";
    else if (completedCount === 0)
        status = "failed";
    else
        status = "partial";
    return {
        phaseId: phase.id,
        title: phase.title,
        strategy,
        taskResults,
        synthesisOutput,
        synthesisSessionId,
        status,
        elapsedMs: elapsed,
    };
}
function buildPhaseContext(previousPhases) {
    if (previousPhases.length === 0)
        return "";
    const parts = ["# Previous Phase Summaries"];
    for (const pr of previousPhases) {
        parts.push(`\n## ${pr.title}`);
        if (pr.synthesisOutput) {
            parts.push(pr.synthesisOutput);
        }
        else {
            for (const tr of pr.taskResults) {
                if (tr.output) {
                    parts.push(`### ${tr.taskId}\n${tr.output.slice(0, 1000)}`);
                }
            }
        }
    }
    return parts.join("\n");
}
export async function runWorkflow(spec, config) {
    const { client, directory, worktree, sessionID, defaultAgent, defaultModel } = config;
    const { concurrency, maxAgents } = validateOptions(config.concurrency, config.maxAgents);
    const totalTasks = countTasks(spec);
    if (totalTasks > maxAgents) {
        throw new Error(`Workflow requires ${totalTasks} agent calls but maxAgents is ${maxAgents}`);
    }
    const runId = generateRunId();
    const startedAt = Date.now();
    const abort = config.abort ?? new AbortController().signal;
    const phaseResults = [];
    for (const phase of spec.phases) {
        const phaseContext = buildPhaseContext(phaseResults);
        const result = await executePhase(client, phase, directory, sessionID, defaultAgent, defaultModel, phaseContext, concurrency, abort);
        phaseResults.push(result);
    }
    const elapsed = Date.now() - startedAt;
    const failedPhases = phaseResults.filter((p) => p.status === "failed").length;
    const completedPhases = phaseResults.filter((p) => p.status === "completed").length;
    let status;
    if (completedPhases === phaseResults.length)
        status = "completed";
    else if (failedPhases === phaseResults.length)
        status = "failed";
    else
        status = "partial";
    const result = {
        runId,
        spec,
        phaseResults,
        status,
        elapsedMs: elapsed,
        startedAt,
        finishedAt: Date.now(),
    };
    await saveRun(worktree, result);
    return result;
}
