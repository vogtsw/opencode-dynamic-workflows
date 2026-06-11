import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { normalizeSpec } from "../src/spec-parser.js"
import { runWorkflow } from "../src/runner.js"
import { loadRun } from "../src/persistence.js"

let roots: string[] = []

afterEach(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true })
  }
  roots = []
})

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "opencode-workflow-test-"))
  roots.push(root)
  return root
}

function createMockClient(
  options: {
    delayMs?: number
    failTask?: string
    nativeTaskError?: string
    failAttempts?: { marker: string; times: number }
    slowMarker?: { marker: string; delayMs: number }
  } = {},
) {
  let nextSession = 0
  let active = 0
  let maxActive = 0
  let markerFailures = 0
  const prompts: Array<any> = []

  const client = {
    session: {
      async create() {
        nextSession += 1
        return { data: { id: `session-${nextSession}` } }
      },
      async prompt(input: any) {
        prompts.push(input)
        active += 1
        maxActive = Math.max(maxActive, active)
        if (options.delayMs) await Bun.sleep(options.delayMs)
        active -= 1

        const text = input.body.parts[0].text ?? input.body.parts[0].prompt

        if (options.slowMarker && text.includes(options.slowMarker.marker)) {
          await Bun.sleep(options.slowMarker.delayMs)
        }

        if (options.failAttempts && text.includes(options.failAttempts.marker)) {
          markerFailures += 1
          if (markerFailures <= options.failAttempts.times) {
            return {
              data: {
                info: { error: { data: { message: `transient failure ${markerFailures}` } } },
                parts: [],
              },
            }
          }
        }

        if (options.failTask && text.includes(options.failTask)) {
          throw new Error(`boom ${options.failTask}`)
        }

        if (options.nativeTaskError && text.includes(options.nativeTaskError)) {
          return {
            data: {
              info: {},
              parts: [
                {
                  id: `part-${prompts.length}`,
                  sessionID: input.path.id,
                  messageID: `message-${prompts.length}`,
                  type: "tool",
                  tool: "task",
                  state: {
                    status: "error",
                    error: `cancelled ${options.nativeTaskError}`,
                    metadata: { sessionId: `native-${input.path.id}` },
                  },
                },
              ],
            },
          }
        }

        return {
          data: {
            info: {},
            parts: [
              {
                id: `part-${prompts.length}`,
                sessionID: input.path.id,
                messageID: `message-${prompts.length}`,
                type: "text",
                text: `output from ${input.path.id}`,
              },
            ],
          },
        }
      },
    },
  }

  return { client: client as any, prompts, getMaxActive: () => maxActive }
}

function promptText(input: any): string {
  return input.body.parts[0].text ?? input.body.parts[0].prompt
}

describe("runWorkflow", () => {
  it("runs parallel tasks with the configured concurrency cap", async () => {
    const spec = normalizeSpec({
      name: "parallel-test",
      goal: "test parallelism",
      phases: [
        {
          id: "p1",
          strategy: "parallel",
          tasks: [
            { id: "t1", prompt: "task 1" },
            { id: "t2", prompt: "task 2" },
            { id: "t3", prompt: "task 3" },
            { id: "t4", prompt: "task 4" },
          ],
        },
      ],
    })
    const root = await tempRoot()
    const { client, getMaxActive } = createMockClient({ delayMs: 20 })

    const result = await runWorkflow(spec, {
      client,
      directory: root,
      worktree: root,
      sessionID: "parent",
      concurrency: 2,
    })

    expect(result.status).toBe("completed")
    expect(result.phaseResults[0].taskResults).toHaveLength(4)
    expect(getMaxActive()).toBeLessThanOrEqual(2)
  })

  it("passes previous task output into later sequential tasks", async () => {
    const spec = normalizeSpec({
      name: "sequential-test",
      goal: "test sequential context",
      phases: [
        {
          id: "p1",
          strategy: "sequential",
          tasks: [
            { id: "t1", prompt: "first task" },
            { id: "t2", prompt: "second task" },
          ],
        },
      ],
    })
    const root = await tempRoot()
    const { client, prompts } = createMockClient()

    await runWorkflow(spec, {
      client,
      directory: root,
      worktree: root,
      sessionID: "parent",
    })

    expect(promptText(prompts[0])).toBe("first task")
    expect(promptText(prompts[1])).toContain("Previous Task Output (t1)")
    expect(promptText(prompts[1])).toContain("output from session-1")
  })

  it("uses native subtask parts and disables workflow tools in child worker prompts", async () => {
    const spec = normalizeSpec({
      name: "tool-disable-test",
      goal: "avoid recursion",
      phases: [{ id: "p1", tasks: [{ id: "t1", prompt: "do it" }] }],
    })
    const root = await tempRoot()
    const { client, prompts } = createMockClient()

    await runWorkflow(spec, {
      client,
      directory: root,
      worktree: root,
      sessionID: "parent",
    })

    expect(prompts[0].body.parts[0].type).toBe("subtask")
    expect(prompts[0].body.tools.workflow_run).toBe(false)
    expect(prompts[0].body.tools.workflow_run_saved).toBe(false)
    expect(prompts[0].body.tools.task).toBe(false)
  })

  it("records failed tasks without aborting the whole run", async () => {
    const spec = normalizeSpec({
      name: "failure-test",
      goal: "capture failures",
      phases: [
        {
          id: "p1",
          tasks: [
            { id: "ok", prompt: "ok task" },
            { id: "bad", prompt: "please fail-marker" },
          ],
        },
      ],
    })
    const root = await tempRoot()
    const { client } = createMockClient({ failTask: "fail-marker" })

    const result = await runWorkflow(spec, {
      client,
      directory: root,
      worktree: root,
      sessionID: "parent",
    })

    expect(result.status).toBe("partial")
    const failed = result.phaseResults[0].taskResults.find((task) => task.taskId === "bad")
    expect(failed?.status).toBe("failed")
    expect(failed?.error).toContain("boom fail-marker")
  })

  it("marks native subtask tool errors as failed", async () => {
    const spec = normalizeSpec({
      name: "native-failure-test",
      goal: "capture native task failure",
      phases: [
        {
          id: "p1",
          tasks: [{ id: "bad", prompt: "please native-fail-marker" }],
        },
      ],
    })
    const root = await tempRoot()
    const { client } = createMockClient({ nativeTaskError: "native-fail-marker" })

    const result = await runWorkflow(spec, {
      client,
      directory: root,
      worktree: root,
      sessionID: "parent",
    })

    expect(result.status).toBe("failed")
    expect(result.phaseResults[0].taskResults[0].status).toBe("failed")
    expect(result.phaseResults[0].taskResults[0].sessionId).toBe("native-session-1")
    expect(result.phaseResults[0].taskResults[0].error).toContain("cancelled native-fail-marker")
    expect(result.progress?.status).toBe("failed")
  })

  it("publishes progress and persists a running run record", async () => {
    const spec = normalizeSpec({
      name: "progress-test",
      goal: "test progress",
      phases: [
        {
          id: "p1",
          tasks: [{ id: "t1", prompt: "task 1" }],
        },
      ],
    })
    const root = await tempRoot()
    const { client } = createMockClient({ delayMs: 20 })
    const progress: Array<any> = []
    let sawRunningRecord = false

    const result = await runWorkflow(spec, {
      client,
      directory: root,
      worktree: root,
      sessionID: "parent",
      onProgress: async (event) => {
        progress.push(event)
        const saved = await loadRun(root, event.runId)
        if (saved?.status === "running") sawRunningRecord = true
      },
    })

    expect(result.status).toBe("completed")
    expect(progress.some((event) => event.message.includes("Starting workflow"))).toBe(true)
    expect(progress.some((event) => event.currentTaskId === "t1" && event.message.includes("completed"))).toBe(true)
    expect(progress.some((event) => event.currentTaskId === "t1" && event.taskRunning === 1)).toBe(true)
    expect(result.progress?.taskCompleted).toBe(1)
    expect(result.progress?.taskRunning).toBe(0)
    expect(result.progress?.taskFailed).toBe(0)
    expect(sawRunningRecord).toBe(true)
  })

  it("records startedAt/finishedAt timing on task results and progress items", async () => {
    const spec = normalizeSpec({
      name: "timing-test",
      goal: "test timing",
      phases: [{ id: "p1", tasks: [{ id: "t1", prompt: "task 1" }] }],
    })
    const root = await tempRoot()
    const { client } = createMockClient({ delayMs: 10 })

    const result = await runWorkflow(spec, {
      client,
      directory: root,
      worktree: root,
      sessionID: "parent",
    })

    const tr = result.phaseResults[0].taskResults[0]
    expect(tr.startedAt).toBeGreaterThan(0)
    expect(tr.finishedAt!).toBeGreaterThanOrEqual(tr.startedAt!)
    expect(tr.attempts).toBe(1)

    const item = result.progress?.tasks?.find((t) => t.taskId === "t1")
    expect(item?.status).toBe("completed")
    expect(item?.startedAt).toBeGreaterThan(0)
    expect(item?.finishedAt!).toBeGreaterThanOrEqual(item!.startedAt!)
  })

  it("retries failed tasks up to the configured retries", async () => {
    const spec = normalizeSpec({
      name: "retry-test",
      goal: "test retry",
      phases: [{ id: "p1", tasks: [{ id: "flaky", prompt: "flaky-marker task", retries: 2 }] }],
    })
    const root = await tempRoot()
    const { client } = createMockClient({ failAttempts: { marker: "flaky-marker", times: 2 } })

    const result = await runWorkflow(spec, {
      client,
      directory: root,
      worktree: root,
      sessionID: "parent",
    })

    expect(result.status).toBe("completed")
    const tr = result.phaseResults[0].taskResults[0]
    expect(tr.status).toBe("completed")
    expect(tr.attempts).toBe(3)
  })

  it("fails a task when all retry attempts are exhausted", async () => {
    const spec = normalizeSpec({
      name: "retry-exhausted-test",
      goal: "test retry exhaustion",
      phases: [{ id: "p1", tasks: [{ id: "flaky", prompt: "flaky-marker task", retries: 1 }] }],
    })
    const root = await tempRoot()
    const { client } = createMockClient({ failAttempts: { marker: "flaky-marker", times: 99 } })

    const result = await runWorkflow(spec, {
      client,
      directory: root,
      worktree: root,
      sessionID: "parent",
    })

    const tr = result.phaseResults[0].taskResults[0]
    expect(tr.status).toBe("failed")
    expect(tr.attempts).toBe(2)
    expect(tr.error).toContain("transient failure")
  })

  it("fails a task that exceeds its timeout", async () => {
    // Bypass normalizeSpec so the test can use a sub-second timeout.
    const spec = {
      name: "timeout-test",
      goal: "test timeout",
      phases: [
        {
          id: "p1",
          title: "p1",
          strategy: "sequential" as const,
          tasks: [{ id: "slow", description: "slow task", prompt: "slow-marker task", timeoutMs: 30 }],
        },
      ],
    }
    const root = await tempRoot()
    const { client } = createMockClient({ slowMarker: { marker: "slow-marker", delayMs: 200 } })

    const result = await runWorkflow(spec, {
      client,
      directory: root,
      worktree: root,
      sessionID: "parent",
    })

    const tr = result.phaseResults[0].taskResults[0]
    expect(tr.status).toBe("failed")
    expect(tr.error).toContain("timed out")
  })

  it("resumes a partial run, reusing completed task outputs", async () => {
    const spec = normalizeSpec({
      name: "resume-test",
      goal: "test resume",
      phases: [
        {
          id: "p1",
          strategy: "parallel",
          tasks: [
            { id: "good", prompt: "good task" },
            { id: "bad", prompt: "always-fail-marker task" },
          ],
        },
      ],
    })
    const root = await tempRoot()

    const first = createMockClient({ failAttempts: { marker: "always-fail-marker", times: 99 } })
    const firstRun = await runWorkflow(spec, {
      client: first.client,
      directory: root,
      worktree: root,
      sessionID: "parent",
    })
    expect(firstRun.status).toBe("partial")

    const completed = new Map(
      firstRun.phaseResults
        .flatMap((p) => p.taskResults)
        .filter((t) => t.status === "completed")
        .map((t) => [t.taskId, t] as const),
    )
    expect(completed.has("good")).toBe(true)

    const second = createMockClient()
    const resumed = await runWorkflow(spec, {
      client: second.client,
      directory: root,
      worktree: root,
      sessionID: "parent",
      resume: {
        runId: firstRun.runId,
        startedAt: firstRun.startedAt,
        completed,
      },
    })

    expect(resumed.runId).toBe(firstRun.runId)
    expect(resumed.status).toBe("completed")
    // Only the previously failed task should be re-executed.
    expect(second.prompts).toHaveLength(1)
    expect(promptText(second.prompts[0])).toContain("always-fail-marker")
    const reused = resumed.phaseResults[0].taskResults.find((t) => t.taskId === "good")
    expect(reused?.output).toContain("output from")
  })

  it("truncates oversized sequential context", async () => {
    const spec = normalizeSpec({
      name: "context-clip-test",
      goal: "test context clipping",
      phases: [
        {
          id: "p1",
          strategy: "sequential",
          tasks: [
            { id: "t1", prompt: "first task" },
            { id: "t2", prompt: "second task" },
          ],
        },
      ],
    })
    const root = await tempRoot()

    let nextSession = 0
    const prompts: any[] = []
    const client = {
      session: {
        async create() {
          nextSession += 1
          return { data: { id: `session-${nextSession}` } }
        },
        async prompt(input: any) {
          prompts.push(input)
          return {
            data: {
              info: {},
              parts: [{ type: "text", text: "y".repeat(10000) }],
            },
          }
        },
      },
    } as any

    await runWorkflow(spec, {
      client,
      directory: root,
      worktree: root,
      sessionID: "parent",
    })

    const secondPrompt = prompts[1].body.parts[0].text ?? prompts[1].body.parts[0].prompt
    expect(secondPrompt).toContain("(truncated)")
    expect(secondPrompt.length).toBeLessThan(10000)
  })
})
