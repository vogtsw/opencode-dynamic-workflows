import { generateRunId, saveRun } from "./persistence.js";
import { countTasks, validateOptions } from "./spec-parser.js";
const DISABLED_TOOLS = {
    workflow_run: false,
    workflow_list: false,
    workflow_run_saved: false,
    workflow_show: false,
    workflow_resume: false,
};
/** Max chars of a single sequential task output carried into the next task's context. */
const SEQ_TASK_CONTEXT_LIMIT = 4000;
/** Max chars of a single task output carried into the next phase's context. */
const PHASE_TASK_CONTEXT_LIMIT = 1000;
/** Max chars of a synthesis output carried into the next phase's context. */
const SYNTHESIS_CONTEXT_LIMIT = 8000;
/** Hard cap on the accumulated context passed to any worker. */
const TOTAL_CONTEXT_LIMIT = 48000;
class TaskTimeoutError extends Error {
    constructor(taskId, timeoutMs) {
        super(`Task "${taskId}" timed out after ${Math.round(timeoutMs / 1000)}s`);
        this.name = "TaskTimeoutError";
    }
}
function withTimeout(promise, timeoutMs, taskId) {
    if (!timeoutMs)
        return promise;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new TaskTimeoutError(taskId, timeoutMs)), timeoutMs);
        promise.then((value) => {
            clearTimeout(timer);
            resolve(value);
        }, (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}
function clip(text, limit) {
    if (text.length <= limit)
        return text;
    return text.slice(0, limit) + "\n... (truncated)";
}
function clipTotalContext(context) {
    if (context.length <= TOTAL_CONTEXT_LIMIT)
        return context;
    const headSize = 8000;
    const tail = context.slice(context.length - (TOTAL_CONTEXT_LIMIT - headSize));
    return `${context.slice(0, headSize)}\n\n... (older context truncated) ...\n\n${tail}`;
}
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
function extractNativeTaskOutput(parts) {
    const toolPart = [...parts].reverse().find((p) => p.type === "tool" && p.tool === "task");
    const status = toolPart?.state?.status;
    const output = toolPart?.state?.output;
    const error = toolPart?.state?.error;
    const sessionId = toolPart?.state?.metadata?.sessionId;
    const failed = status === "error" || typeof error === "string";
    if (typeof output !== "string") {
        return {
            output: "",
            sessionId,
            failed,
            error: typeof error === "string" ? error : failed ? "Native subtask failed" : undefined,
        };
    }
    const match = output.match(/<task_result>\s*([\s\S]*?)\s*<\/task_result>/);
    return {
        output: (match?.[1] ?? output).trim(),
        sessionId,
        failed,
        error: typeof error === "string" ? error : undefined,
    };
}
async function runTaskAttempt(client, task, fullPrompt, agent, model, directory, parentID, abort) {
    const session = await client.session.create({
        body: { parentID, title: task.description },
        query: { directory },
    });
    const sessionId = session.data.id;
    let response;
    try {
        response = await withTimeout(client.session.prompt({
            path: { id: sessionId },
            query: { directory },
            body: {
                agent,
                model: parseModel(model),
                tools: { ...DISABLED_TOOLS, task: false },
                parts: [
                    {
                        type: "subtask",
                        agent,
                        description: task.description,
                        prompt: fullPrompt,
                        ...(model ? { model: parseModel(model) } : {}),
                    },
                ],
            },
        }), task.timeoutMs, task.id);
    }
    catch (err) {
        // Do not re-send the prompt after an abort or timeout: the first request may
        // still be executing and a resend could duplicate side effects.
        if (abort.aborted || err instanceof TaskTimeoutError)
            throw err;
        response = await withTimeout(client.session.prompt({
            path: { id: sessionId },
            query: { directory },
            body: {
                agent,
                model: parseModel(model),
                tools: DISABLED_TOOLS,
                parts: [{ type: "text", text: fullPrompt }],
            },
        }), task.timeoutMs, task.id);
    }
    const parts = response.data.parts;
    const nativeTask = extractNativeTaskOutput(parts);
    const output = nativeTask.output || extractText(parts);
    const info = response.data.info;
    const failed = info.error !== undefined || nativeTask.failed || abort.aborted;
    return {
        output,
        sessionId: nativeTask.sessionId ?? sessionId,
        failed,
        error: failed
            ? info.error?.data?.message ?? nativeTask.error ?? (abort.aborted ? "Task aborted" : "Task failed")
            : undefined,
    };
}
async function runTask(client, task, directory, parentID, defaultAgent, defaultModel, phaseContext, abort, onProgress, cached) {
    if (cached && cached.status === "completed") {
        await onProgress?.(task, "completed", cached.sessionId);
        return { ...cached };
    }
    const startedAt = Date.now();
    const agent = task.agent ?? defaultAgent ?? "general";
    const model = task.model ?? defaultModel;
    const maxAttempts = 1 + (task.retries ?? 0);
    let sessionId = "";
    let lastError;
    if (abort.aborted) {
        return {
            taskId: task.id,
            sessionId,
            status: "skipped",
            output: "",
            elapsedMs: 0,
            startedAt,
            finishedAt: startedAt,
        };
    }
    await onProgress?.(task, "running", "");
    let fullPrompt = task.prompt;
    if (phaseContext) {
        fullPrompt = `${clipTotalContext(phaseContext)}\n\n---\n\n${task.prompt}`;
    }
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            const attemptResult = await runTaskAttempt(client, task, fullPrompt, agent, model, directory, parentID, abort);
            sessionId = attemptResult.sessionId;
            if (!attemptResult.failed) {
                const finishedAt = Date.now();
                const result = {
                    taskId: task.id,
                    sessionId,
                    status: "completed",
                    output: attemptResult.output,
                    elapsedMs: finishedAt - startedAt,
                    startedAt,
                    finishedAt,
                    attempts: attempt,
                };
                await onProgress?.(task, "completed", sessionId);
                return result;
            }
            lastError = attemptResult.error ?? "Task failed";
        }
        catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
        }
        if (abort.aborted)
            break;
    }
    const finishedAt = Date.now();
    const result = {
        taskId: task.id,
        sessionId,
        status: "failed",
        output: "",
        elapsedMs: finishedAt - startedAt,
        startedAt,
        finishedAt,
        attempts: maxAttempts,
        error: lastError ?? (abort.aborted ? "Task aborted" : "Task failed"),
    };
    await onProgress?.(task, "failed", sessionId);
    return result;
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
async function executeParallelTasks(client, tasks, directory, parentID, defaultAgent, defaultModel, phaseContext, concurrency, abort, onTaskProgress, getCached) {
    const results = [];
    const pending = [...tasks];
    async function runNext() {
        while (pending.length > 0) {
            if (abort.aborted)
                break;
            const task = pending.shift();
            const result = await runTask(client, task, directory, parentID, defaultAgent, defaultModel, phaseContext, abort, onTaskProgress, getCached?.(task));
            results.push(result);
        }
    }
    const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => runNext());
    await Promise.all(workers);
    for (const task of pending) {
        const result = {
            taskId: task.id,
            sessionId: "",
            status: "skipped",
            output: "",
            elapsedMs: 0,
            error: abort.aborted ? "Task skipped after workflow abort" : undefined,
        };
        results.push(result);
        await onTaskProgress?.(task, "skipped", "");
    }
    return results;
}
async function executePhase(client, phase, directory, parentID, defaultAgent, defaultModel, phaseContext, concurrency, abort, onTaskProgress, onSynthesisProgress, getCached) {
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
                    error: "Task skipped after workflow abort",
                });
                await onTaskProgress?.(task, "skipped", "");
                continue;
            }
            const result = await runTask(client, task, directory, parentID, defaultAgent, defaultModel, phaseContext, abort, onTaskProgress, getCached?.(task));
            taskResults.push(result);
            if (result.output) {
                phaseContext = clipTotalContext(`${phaseContext}\n\n## Previous Task Output (${task.id})\n${clip(result.output, SEQ_TASK_CONTEXT_LIMIT)}`);
            }
        }
    }
    else {
        taskResults = await executeParallelTasks(client, phase.tasks, directory, parentID, defaultAgent, defaultModel, phaseContext, concurrency, abort, onTaskProgress, getCached);
    }
    let synthesisOutput;
    let synthesisSessionId;
    if (phase.synthesisPrompt && !abort.aborted) {
        await onSynthesisProgress?.("running");
        const syn = await runSynthesis(client, phase, taskResults, directory, parentID, defaultAgent, defaultModel, abort);
        synthesisOutput = syn.output;
        synthesisSessionId = syn.sessionId;
        await onSynthesisProgress?.("completed");
    }
    const elapsed = Date.now() - start;
    const failedCount = taskResults.filter((t) => t.status === "failed").length;
    const completedCount = taskResults.filter((t) => t.status === "completed").length;
    const skippedCount = taskResults.filter((t) => t.status === "skipped").length;
    let status;
    if (taskResults.length === 0 && phase.tasks.length > 0)
        status = "failed";
    else if (failedCount === 0 && skippedCount === 0 && taskResults.length === phase.tasks.length)
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
            parts.push(clip(pr.synthesisOutput, SYNTHESIS_CONTEXT_LIMIT));
        }
        else {
            for (const tr of pr.taskResults) {
                if (tr.output) {
                    parts.push(`### ${tr.taskId}\n${clip(tr.output, PHASE_TASK_CONTEXT_LIMIT)}`);
                }
            }
        }
    }
    return clipTotalContext(parts.join("\n"));
}
export async function runWorkflow(spec, config) {
    const { client, directory, worktree, sessionID, defaultAgent, defaultModel, resume } = config;
    const { concurrency, maxAgents } = validateOptions(config.concurrency, config.maxAgents);
    const totalTasks = countTasks(spec);
    if (totalTasks > maxAgents) {
        throw new Error(`Workflow requires ${totalTasks} agent calls but maxAgents is ${maxAgents}`);
    }
    const runId = resume?.runId ?? generateRunId();
    const startedAt = resume?.startedAt ?? Date.now();
    const executionStartedAt = Date.now();
    const abort = config.abort ?? new AbortController().signal;
    const phaseResults = [];
    const taskTotal = spec.phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
    const taskStatuses = new Map();
    const taskTimes = new Map();
    function taskKey(phase, task) {
        return `${phase.id}/${task.id}`;
    }
    function progressCounts() {
        let taskCompleted = 0;
        let taskRunning = 0;
        let taskFailed = 0;
        let taskSkipped = 0;
        for (const status of taskStatuses.values()) {
            if (status === "completed")
                taskCompleted += 1;
            else if (status === "running")
                taskRunning += 1;
            else if (status === "failed")
                taskFailed += 1;
            else if (status === "skipped")
                taskSkipped += 1;
        }
        return { taskCompleted, taskRunning, taskFailed, taskSkipped };
    }
    function progressTasks() {
        const items = [];
        for (const phase of spec.phases) {
            for (const task of phase.tasks) {
                const key = taskKey(phase, task);
                const timing = taskTimes.get(key);
                items.push({
                    phaseId: phase.id,
                    taskId: task.id,
                    description: task.description,
                    status: taskStatuses.get(key) ?? "pending",
                    startedAt: timing?.startedAt,
                    finishedAt: timing?.finishedAt,
                });
            }
        }
        return items;
    }
    const result = {
        runId,
        spec,
        phaseResults,
        status: "running",
        elapsedMs: 0,
        startedAt,
    };
    async function publish(message, patch = {}) {
        const counts = progressCounts();
        const progress = {
            runId,
            status: result.status,
            message,
            phaseIndex: patch.phaseIndex ?? phaseResults.length,
            phaseTotal: spec.phases.length,
            taskCompleted: counts.taskCompleted,
            taskRunning: counts.taskRunning,
            taskFailed: counts.taskFailed,
            taskSkipped: counts.taskSkipped,
            taskTotal,
            currentPhaseId: patch.currentPhaseId,
            currentPhaseTitle: patch.currentPhaseTitle,
            currentTaskId: patch.currentTaskId,
            currentTaskDescription: patch.currentTaskDescription,
            tasks: progressTasks(),
            updatedAt: Date.now(),
        };
        result.elapsedMs = Date.now() - executionStartedAt;
        result.progress = progress;
        await saveRun(worktree, result);
        try {
            await config.onProgress?.(progress);
        }
        catch {
            // Progress UI updates are best-effort; persisted run state is the source of truth.
        }
    }
    await publish(resume ? `Resuming workflow "${spec.name}"` : `Starting workflow "${spec.name}"`);
    for (let i = 0; i < spec.phases.length; i += 1) {
        const phase = spec.phases[i];
        await publish(`Phase ${i + 1}/${spec.phases.length}: ${phase.title}`, {
            phaseIndex: i + 1,
            currentPhaseId: phase.id,
            currentPhaseTitle: phase.title,
        });
        const phaseContext = buildPhaseContext(phaseResults);
        const phaseResult = await executePhase(client, phase, directory, sessionID, defaultAgent, defaultModel, phaseContext, concurrency, abort, async (task, status) => {
            const key = taskKey(phase, task);
            taskStatuses.set(key, status);
            const timing = taskTimes.get(key) ?? {};
            if (status === "running" && timing.startedAt === undefined)
                timing.startedAt = Date.now();
            if (status !== "running" && status !== "pending")
                timing.finishedAt = Date.now();
            taskTimes.set(key, timing);
            const verb = status === "running" ? "running" : status === "completed" ? "completed" : status === "failed" ? "failed" : "skipped";
            await publish(`Task ${verb}: ${task.description}`, {
                phaseIndex: i + 1,
                currentPhaseId: phase.id,
                currentPhaseTitle: phase.title,
                currentTaskId: task.id,
                currentTaskDescription: task.description,
            });
        }, async (status) => {
            await publish(`Synthesis for ${phase.title} ${status}`, {
                phaseIndex: i + 1,
                currentPhaseId: phase.id,
                currentPhaseTitle: phase.title,
            });
        }, resume ? (task) => resume.completed.get(task.id) : undefined);
        phaseResults.push(phaseResult);
        await publish(`Phase ${i + 1}/${spec.phases.length} finished: ${phase.title} (${phaseResult.status})`, {
            phaseIndex: i + 1,
            currentPhaseId: phase.id,
            currentPhaseTitle: phase.title,
        });
    }
    const elapsed = Date.now() - executionStartedAt;
    const failedPhases = phaseResults.filter((p) => p.status === "failed").length;
    const completedPhases = phaseResults.filter((p) => p.status === "completed").length;
    let status;
    if (completedPhases === phaseResults.length)
        status = "completed";
    else if (failedPhases === phaseResults.length)
        status = "failed";
    else
        status = "partial";
    result.status = status;
    result.elapsedMs = elapsed;
    result.finishedAt = Date.now();
    await saveRun(worktree, result);
    await publish(`Workflow ${status}: ${spec.name}`);
    return result;
}
