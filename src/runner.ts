import type { createOpencodeClient } from "@opencode-ai/sdk"
import type { Part, TextPart } from "@opencode-ai/sdk"
import type {
  WorkflowSpec,
  Phase,
  Task,
  TaskResult,
  PhaseResult,
  RunResult,
  TaskStatus,
  WorkflowProgress,
} from "./types.js"
import { generateRunId, saveRun, saveSpec } from "./persistence.js"
import { countTasks, validateOptions } from "./spec-parser.js"

export type SDKClient = ReturnType<typeof createOpencodeClient>

export interface RunnerConfig {
  client: SDKClient
  directory: string
  worktree: string
  sessionID: string
  concurrency?: number
  maxAgents?: number
  defaultAgent?: string
  defaultModel?: string
  abort?: AbortSignal
  onProgress?: (progress: WorkflowProgress) => void | Promise<void>
}

const DISABLED_TOOLS = {
  workflow_run: false,
  workflow_list: false,
  workflow_run_saved: false,
  workflow_show: false,
}

function parseModel(model: string | undefined): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined
  const slash = model.indexOf("/")
  if (slash <= 0 || slash === model.length - 1) return undefined
  return {
    providerID: model.slice(0, slash),
    modelID: model.slice(slash + 1),
  }
}

function extractText(parts: Part[]): string {
  return parts
    .filter((p): p is TextPart => p.type === "text" && !p.synthetic && !p.ignored)
    .map((p) => p.text)
    .join("\n")
    .trim()
}

function extractNativeTaskOutput(parts: Part[]): { output: string; sessionId?: string } {
  const toolPart = [...parts].reverse().find((p: any) => p.type === "tool" && p.tool === "task") as any
  const output = toolPart?.state?.output
  const sessionId = toolPart?.state?.metadata?.sessionId
  if (typeof output !== "string") return { output: "", sessionId }

  const match = output.match(/<task_result>\s*([\s\S]*?)\s*<\/task_result>/)
  return {
    output: (match?.[1] ?? output).trim(),
    sessionId,
  }
}

async function runTask(
  client: SDKClient,
  task: Task,
  directory: string,
  parentID: string,
  defaultAgent: string | undefined,
  defaultModel: string | undefined,
  phaseContext: string,
  abort: AbortSignal,
  onProgress?: (task: Task, status: TaskStatus, sessionId: string) => void | Promise<void>,
): Promise<TaskResult> {
  const start = Date.now()
  const agent = task.agent ?? defaultAgent ?? "general"
  const model = task.model ?? defaultModel
  let sessionId = ""

  try {
    if (abort.aborted) {
      return {
        taskId: task.id,
        sessionId,
        status: "skipped",
        output: "",
        elapsedMs: 0,
      }
    }

    await onProgress?.(task, "running", "")

    const session = await client.session.create({
      body: { parentID, title: task.description },
      query: { directory },
    })

    sessionId = session.data!.id
    await onProgress?.(task, "running", sessionId)

    let fullPrompt = task.prompt
    if (phaseContext) {
      fullPrompt = `${phaseContext}\n\n---\n\n${task.prompt}`
    }

    let response
    try {
      response = await client.session.prompt({
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
            } as any,
          ],
        },
      })
    } catch {
      response = await client.session.prompt({
        path: { id: sessionId },
        query: { directory },
        body: {
          agent,
          model: parseModel(model),
          tools: DISABLED_TOOLS,
          parts: [{ type: "text", text: fullPrompt }],
        },
      })
    }

    const elapsed = Date.now() - start
    const parts = response.data!.parts
    const nativeTask = extractNativeTaskOutput(parts)
    const output = nativeTask.output || extractText(parts)

    const info = response.data!.info
    const failed = info.error !== undefined

    const result: TaskResult = {
      taskId: task.id,
      sessionId: nativeTask.sessionId ?? sessionId,
      status: failed ? "failed" : "completed",
      output,
      elapsedMs: elapsed,
      error: failed ? (info.error as any)?.data?.message ?? "Task failed" : undefined,
    }
    await onProgress?.(task, result.status, sessionId)
    return result
  } catch (err) {
    const result: TaskResult = {
      taskId: task.id,
      sessionId,
      status: "failed",
      output: "",
      elapsedMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    }
    await onProgress?.(task, "failed", sessionId)
    return result
  }
}

async function runSynthesis(
  client: SDKClient,
  phase: Phase,
  taskResults: TaskResult[],
  directory: string,
  parentID: string,
  defaultAgent: string | undefined,
  defaultModel: string | undefined,
  abort: AbortSignal,
): Promise<{ output: string; sessionId: string; elapsedMs: number }> {
  const start = Date.now()
  const resultsText = taskResults
    .map((tr) => `### ${tr.taskId}\n${tr.output || "(no output)"}`)
    .join("\n\n---\n\n")

  const prompt = `${phase.synthesisPrompt}\n\n## Task Results\n\n${resultsText}`

  const session = await client.session.create({
    body: { parentID, title: `Synthesis: ${phase.title}` },
    query: { directory },
  })

  const sessionId = session.data!.id

  const response = await client.session.prompt({
    path: { id: sessionId },
    query: { directory },
    body: {
      agent: defaultAgent,
      model: parseModel(defaultModel),
      tools: DISABLED_TOOLS,
      parts: [{ type: "text", text: prompt }],
    },
  })

  const elapsed = Date.now() - start
  const output = extractText(response.data!.parts)

  return { output, sessionId, elapsedMs: elapsed }
}

async function executeParallelTasks(
  client: SDKClient,
  tasks: Task[],
  directory: string,
  parentID: string,
  defaultAgent: string | undefined,
  defaultModel: string | undefined,
  phaseContext: string,
  concurrency: number,
  abort: AbortSignal,
  onTaskProgress?: (task: Task, status: TaskStatus, sessionId: string) => void | Promise<void>,
): Promise<TaskResult[]> {
  const results: TaskResult[] = []
  const pending = [...tasks]

  async function runNext(): Promise<void> {
    while (pending.length > 0) {
      if (abort.aborted) break
      const task = pending.shift()!
      const result = await runTask(client, task, directory, parentID, defaultAgent, defaultModel, phaseContext, abort, onTaskProgress)
      results.push(result)
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => runNext())
  await Promise.all(workers)

  return results
}

async function executePhase(
  client: SDKClient,
  phase: Phase,
  directory: string,
  parentID: string,
  defaultAgent: string | undefined,
  defaultModel: string | undefined,
  phaseContext: string,
  concurrency: number,
  abort: AbortSignal,
  onTaskProgress?: (task: Task, status: TaskStatus, sessionId: string) => void | Promise<void>,
  onSynthesisProgress?: (status: "running" | "completed") => void | Promise<void>,
): Promise<PhaseResult> {
  const start = Date.now()
  const strategy = phase.strategy ?? "parallel"

  let taskResults: TaskResult[]

  if (strategy === "sequential") {
    taskResults = []
    for (const task of phase.tasks) {
      if (abort.aborted) {
        taskResults.push({
          taskId: task.id,
          sessionId: "",
          status: "skipped",
          output: "",
          elapsedMs: 0,
        })
        continue
      }
      const result = await runTask(client, task, directory, parentID, defaultAgent, defaultModel, phaseContext, abort, onTaskProgress)
      taskResults.push(result)
      if (result.output) {
        phaseContext = `${phaseContext}\n\n## Previous Task Output (${task.id})\n${result.output}`
      }
    }
  } else {
    taskResults = await executeParallelTasks(
      client,
      phase.tasks,
      directory,
      parentID,
      defaultAgent,
      defaultModel,
      phaseContext,
      concurrency,
      abort,
      onTaskProgress,
    )
  }

  let synthesisOutput: string | undefined
  let synthesisSessionId: string | undefined

  if (phase.synthesisPrompt && !abort.aborted) {
    await onSynthesisProgress?.("running")
    const syn = await runSynthesis(
      client,
      phase,
      taskResults,
      directory,
      parentID,
      defaultAgent,
      defaultModel,
      abort,
    )
    synthesisOutput = syn.output
    synthesisSessionId = syn.sessionId
    await onSynthesisProgress?.("completed")
  }

  const elapsed = Date.now() - start
  const failedCount = taskResults.filter((t) => t.status === "failed").length
  const completedCount = taskResults.filter((t) => t.status === "completed").length

  let status: "completed" | "failed" | "partial"
  if (failedCount === 0) status = "completed"
  else if (completedCount === 0) status = "failed"
  else status = "partial"

  return {
    phaseId: phase.id,
    title: phase.title,
    strategy,
    taskResults,
    synthesisOutput,
    synthesisSessionId,
    status,
    elapsedMs: elapsed,
  }
}

function buildPhaseContext(previousPhases: PhaseResult[]): string {
  if (previousPhases.length === 0) return ""

  const parts: string[] = ["# Previous Phase Summaries"]

  for (const pr of previousPhases) {
    parts.push(`\n## ${pr.title}`)
    if (pr.synthesisOutput) {
      parts.push(pr.synthesisOutput)
    } else {
      for (const tr of pr.taskResults) {
        if (tr.output) {
          parts.push(`### ${tr.taskId}\n${tr.output.slice(0, 1000)}`)
        }
      }
    }
  }

  return parts.join("\n")
}

export async function runWorkflow(spec: WorkflowSpec, config: RunnerConfig): Promise<RunResult> {
  const { client, directory, worktree, sessionID, defaultAgent, defaultModel } = config
  const { concurrency, maxAgents } = validateOptions(config.concurrency, config.maxAgents)

  const totalTasks = countTasks(spec)
  if (totalTasks > maxAgents) {
    throw new Error(`Workflow requires ${totalTasks} agent calls but maxAgents is ${maxAgents}`)
  }

  const runId = generateRunId()
  const startedAt = Date.now()
  const abort = config.abort ?? new AbortController().signal

  const phaseResults: PhaseResult[] = []
  const taskTotal = spec.phases.reduce((sum, phase) => sum + phase.tasks.length, 0)
  const taskStatuses = new Map<string, TaskStatus>()

  function taskKey(phase: Phase, task: Task) {
    return `${phase.id}/${task.id}`
  }

  function progressCounts() {
    let taskCompleted = 0
    let taskRunning = 0
    let taskFailed = 0
    let taskSkipped = 0

    for (const status of taskStatuses.values()) {
      if (status === "completed") taskCompleted += 1
      else if (status === "running") taskRunning += 1
      else if (status === "failed") taskFailed += 1
      else if (status === "skipped") taskSkipped += 1
    }

    return { taskCompleted, taskRunning, taskFailed, taskSkipped }
  }

  const result: RunResult = {
    runId,
    spec,
    phaseResults,
    status: "running",
    elapsedMs: 0,
    startedAt,
  }

  async function publish(message: string, patch: Partial<WorkflowProgress> = {}) {
    const counts = progressCounts()
    const progress: WorkflowProgress = {
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
      updatedAt: Date.now(),
    }
    result.elapsedMs = Date.now() - startedAt
    result.progress = progress
    await saveRun(worktree, result)
    await config.onProgress?.(progress)
  }

  await publish(`Starting workflow "${spec.name}"`)

  for (let i = 0; i < spec.phases.length; i += 1) {
    const phase = spec.phases[i]
    await publish(`Phase ${i + 1}/${spec.phases.length}: ${phase.title}`, {
      phaseIndex: i + 1,
      currentPhaseId: phase.id,
      currentPhaseTitle: phase.title,
    })
    const phaseContext = buildPhaseContext(phaseResults)
    const result = await executePhase(
      client,
      phase,
      directory,
      sessionID,
      defaultAgent,
      defaultModel,
      phaseContext,
      concurrency,
      abort,
      async (task, status) => {
        taskStatuses.set(taskKey(phase, task), status)
        const verb = status === "running" ? "running" : status === "completed" ? "completed" : status === "failed" ? "failed" : "skipped"
        await publish(`Task ${verb}: ${task.description}`, {
          phaseIndex: i + 1,
          currentPhaseId: phase.id,
          currentPhaseTitle: phase.title,
          currentTaskId: task.id,
          currentTaskDescription: task.description,
        })
      },
      async (status) => {
        await publish(`Synthesis for ${phase.title} ${status}`, {
          phaseIndex: i + 1,
          currentPhaseId: phase.id,
          currentPhaseTitle: phase.title,
        })
      },
    )
    phaseResults.push(result)
    await publish(`Phase ${i + 1}/${spec.phases.length} finished: ${phase.title} (${result.status})`, {
      phaseIndex: i + 1,
      currentPhaseId: phase.id,
      currentPhaseTitle: phase.title,
    })
  }

  const elapsed = Date.now() - startedAt
  const failedPhases = phaseResults.filter((p) => p.status === "failed").length
  const completedPhases = phaseResults.filter((p) => p.status === "completed").length

  let status: "completed" | "failed" | "partial"
  if (completedPhases === phaseResults.length) status = "completed"
  else if (failedPhases === phaseResults.length) status = "failed"
  else status = "partial"

  result.status = status
  result.elapsedMs = elapsed
  result.finishedAt = Date.now()

  await saveRun(worktree, result)
  await publish(`Workflow ${status}: ${spec.name}`)
  return result
}
