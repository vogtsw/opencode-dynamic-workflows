import { tool } from "@opencode-ai/plugin"
import type { SDKClient, RunnerConfig } from "./runner.js"
import { runWorkflow } from "./runner.js"
import { normalizeSpec, generateDefaultSpec, countTasks, validateOptions } from "./spec-parser.js"
import { saveSpec, loadSpec, listSavedWorkflows, getSavedWorkflow, listRuns } from "./persistence.js"
import { generateReport, generateDryRunReport, generateListOutput } from "./report.js"
import type { WorkflowProgress, WorkflowSpec } from "./types.js"

export interface ToolFactoryOptions {
  client: SDKClient
  directory: string
  worktree: string
}

function progressTitle(progress: WorkflowProgress): string {
  const done = progress.taskCompleted + progress.taskFailed + progress.taskSkipped
  const failed = progress.taskFailed > 0 ? `, ${progress.taskFailed} failed` : ""
  const running = progress.taskRunning > 0 ? `, ${progress.taskRunning} running` : ""
  const taskPart = progress.taskTotal > 0 ? `${done}/${progress.taskTotal} done${running}${failed}` : progress.status
  return `Workflow ${taskPart}: ${progress.message}`
}

function progressMetadata(progress: WorkflowProgress) {
  const done = progress.taskCompleted + progress.taskFailed + progress.taskSkipped
  return {
    runId: progress.runId,
    status: progress.status,
    message: progress.message,
    progress: progress.taskTotal > 0 ? `${done}/${progress.taskTotal}` : progress.status,
    completed: progress.taskCompleted,
    running: progress.taskRunning,
    failed: progress.taskFailed,
    skipped: progress.taskSkipped,
    total: progress.taskTotal,
    phase: `${progress.phaseIndex}/${progress.phaseTotal}`,
    currentPhaseId: progress.currentPhaseId,
    currentPhaseTitle: progress.currentPhaseTitle,
    currentTaskId: progress.currentTaskId,
    currentTaskDescription: progress.currentTaskDescription,
    updatedAt: new Date(progress.updatedAt).toISOString(),
  }
}

function shouldToast(progress: WorkflowProgress): boolean {
  if (progress.status !== "running") return true
  if (/^Phase \d+\/\d+:/.test(progress.message)) return true
  return /^Task (completed|failed|skipped):/.test(progress.message)
}

async function notifyProgress(client: SDKClient, context: any, progress: WorkflowProgress): Promise<void> {
  const title = progressTitle(progress)
  context.metadata({
    title,
    metadata: progressMetadata(progress),
  })

  if (!shouldToast(progress)) return

  try {
    await client.tui.showToast({
      query: { directory: context.directory },
      body: {
        title: "Workflow progress",
        message: title,
        variant: progress.status === "failed" ? "error" : progress.status === "completed" ? "success" : "info",
        duration: 2500,
      },
    })
  } catch {
    // TUI notifications are best-effort; headless `opencode run` may not have a visible TUI.
  }
}

function finalTitle(progress: WorkflowProgress | undefined): string | undefined {
  if (!progress) return undefined
  return progressTitle(progress)
}

export function createWorkflowRunTool(opts: ToolFactoryOptions) {
  const { client } = opts

  return tool({
    description:
      "Run a multi-agent workflow. Orchestrates parallel/sequential phases of subagent tasks using a JSON DSL. Good for audits, migrations, research, and adversarial checking. Returns a markdown report.",
    args: {
      goal: tool.schema.string().describe("The goal of the workflow"),
      spec: tool.schema
        .string()
        .optional()
        .describe("JSON workflow specification. If omitted, a default spec is generated from the goal."),
      concurrency: tool.schema.number().optional().describe("Max concurrent worker sessions. Default 4, max 16."),
      maxAgents: tool.schema.number().optional().describe("Max total agent sessions across the run. Default 100, max 1000."),
      saveAs: tool.schema
        .string()
        .optional()
        .describe("If provided, saves the workflow spec under this name for reuse via workflow_run_saved."),
      dryRun: tool.schema.boolean().optional().describe("If true, validates the spec and returns a plan without executing any tasks."),
      agent: tool.schema.string().optional().describe("Default OpenCode agent for worker sessions."),
      model: tool.schema.string().optional().describe("Default provider/model for worker sessions (e.g. anthropic/claude-sonnet-4-6)."),
    },
    async execute(args, context) {
      const { goal, spec: specJson, concurrency, maxAgents, saveAs, dryRun, agent, model } = args

      let spec: WorkflowSpec
      if (specJson && specJson.trim()) {
        try {
          const raw = JSON.parse(specJson)
          spec = normalizeSpec(raw)
        } catch (err: any) {
          if (err.name === "SpecValidationError") {
            return `**Validation Error**: ${err.message}\n\nIssues:\n${err.issues.map((i: string) => `- ${i}`).join("\n")}`
          }
          return `**Parse Error**: Failed to parse spec JSON: ${err.message}`
        }
      } else {
        spec = generateDefaultSpec(goal)
      }

      if (saveAs) spec = { ...spec, name: saveAs }

      const totalTasks = countTasks(spec)
      const { concurrency: c, maxAgents: m } = validateOptions(concurrency, maxAgents)

      if (totalTasks > m) {
        return `**Error**: Workflow requires ${totalTasks} agent calls but maxAgents is ${m}. Increase maxAgents or reduce the number of tasks.`
      }

      if (dryRun) {
        return generateDryRunReport(spec, totalTasks)
      }

      const runnerConfig: RunnerConfig = {
        client,
        directory: context.directory,
        worktree: context.worktree,
        sessionID: context.sessionID,
        concurrency: c,
        maxAgents: m,
        defaultAgent: agent ?? context.agent,
        defaultModel: model,
        abort: context.abort,
        onProgress: (progress) => notifyProgress(client, context, progress),
      }

      const result = await runWorkflow(spec, runnerConfig)

      if (saveAs) {
        await saveSpec(context.worktree, spec)
      }

      return {
        title: finalTitle(result.progress),
        output: generateReport(result),
        metadata: result.progress ? progressMetadata(result.progress) : undefined,
      }
    },
  })
}

export function createWorkflowListTool(_opts: ToolFactoryOptions) {
  return tool({
    description: "List saved workflow specs and recent runs.",
    args: {},
    async execute(_args, context) {
      const workflows = await listSavedWorkflows(context.worktree)
      let output = generateListOutput(workflows)

      const runs = await listRuns(context.worktree)
      if (runs.length > 0) {
        output += "\n## Recent Runs\n\n"
        for (const run of runs.slice(0, 10)) {
          const icon = run.status === "completed" ? "[ok]" : run.status === "failed" ? "[fail]" : run.status === "running" ? "[run]" : "[partial]"
          output += `- ${icon} **${run.name}** - \`${run.runId}\` - ${new Date(run.startedAt).toISOString()}\n`
          if (run.status === "running" && run.progress) {
            output += `  Progress: ${run.progress}\n`
          }
        }
      }

      return output
    },
  })
}

export function createWorkflowRunSavedTool(opts: ToolFactoryOptions) {
  const { client } = opts

  return tool({
    description: "Load and run a previously saved workflow spec by name.",
    args: {
      name: tool.schema.string().describe("Name of the saved workflow to run"),
      concurrency: tool.schema.number().optional().describe("Max concurrent worker sessions. Default 4, max 16."),
      maxAgents: tool.schema.number().optional().describe("Max total agent sessions across the run. Default 100, max 1000."),
      agent: tool.schema.string().optional().describe("Default OpenCode agent for worker sessions."),
      model: tool.schema.string().optional().describe("Default provider/model for worker sessions."),
    },
    async execute(args, context) {
      const { name, concurrency, maxAgents, agent, model } = args

      const spec = await loadSpec(context.worktree, name)
      if (!spec) {
        return `**Error**: No saved workflow found with name "${name}". Use workflow_list to see available workflows.`
      }

      const totalTasks = countTasks(spec)
      const { concurrency: c, maxAgents: m } = validateOptions(concurrency, maxAgents)

      if (totalTasks > m) {
        return `**Error**: Workflow requires ${totalTasks} agent calls but maxAgents is ${m}.`
      }

      const runnerConfig: RunnerConfig = {
        client,
        directory: context.directory,
        worktree: context.worktree,
        sessionID: context.sessionID,
        concurrency: c,
        maxAgents: m,
        defaultAgent: agent ?? context.agent,
        defaultModel: model,
        abort: context.abort,
        onProgress: (progress) => notifyProgress(client, context, progress),
      }

      const result = await runWorkflow(spec, runnerConfig)
      await saveSpec(context.worktree, spec)

      return {
        title: finalTitle(result.progress),
        output: generateReport(result),
        metadata: result.progress ? progressMetadata(result.progress) : undefined,
      }
    },
  })
}

export function createWorkflowShowTool(_opts: ToolFactoryOptions) {
  return tool({
    description: "Show the spec for a saved workflow, including recent run history if available.",
    args: {
      name: tool.schema.string().describe("Name of the saved workflow to show"),
    },
    async execute(args, context) {
      const { name } = args

      const saved = await getSavedWorkflow(context.worktree, name)
      if (!saved) {
        return `**Error**: No saved workflow found with name "${name}". Use workflow_list to see available workflows.`
      }

      const { spec, createdAt, updatedAt, runCount, lastRunAt } = saved

      let output = `# Workflow: ${spec.name}\n\n`
      output += `**Goal**: ${spec.goal}\n`
      output += `**Created**: ${new Date(createdAt).toISOString()}\n`
      output += `**Updated**: ${new Date(updatedAt).toISOString()}\n`
      output += `**Run Count**: ${runCount}\n`
      if (lastRunAt) output += `**Last Run**: ${new Date(lastRunAt).toISOString()}\n`
      output += "\n"

      for (const phase of spec.phases) {
        output += `## Phase: ${phase.title}\n`
        output += `- ID: \`${phase.id}\`\n`
        output += `- Strategy: ${phase.strategy ?? "parallel"}\n`
        output += `- Tasks: ${phase.tasks.length}\n`
        if (phase.synthesisPrompt) output += "- Has synthesis prompt\n"
        output += "\n"
        for (const task of phase.tasks) {
          output += `### ${task.id}: ${task.description}\n`
          output += `\`\`\`\n${task.prompt.slice(0, 500)}${task.prompt.length > 500 ? "..." : ""}\n\`\`\`\n\n`
        }
      }

      output += "## Spec JSON\n\n```json\n" + JSON.stringify(spec, null, 2) + "\n```\n"

      return output
    },
  })
}
