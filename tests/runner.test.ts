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

function createMockClient(options: { delayMs?: number; failTask?: string } = {}) {
  let nextSession = 0
  let active = 0
  let maxActive = 0
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
        if (options.failTask && text.includes(options.failTask)) {
          throw new Error(`boom ${options.failTask}`)
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
})
