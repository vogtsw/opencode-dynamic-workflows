import { describe, it, expect, afterEach } from "bun:test"
import { rm } from "node:fs/promises"
import { sanitize, saveSpec, loadSpec, saveRun, loadRun, generateRunId } from "../src/persistence.js"
import { normalizeSpec, generateDefaultSpec } from "../src/spec-parser.js"
import type { RunResult } from "../src/types.js"

const TEST_WORKTREE = ".opencode/workflows-test"

async function cleanup() {
  try {
    await rm(".opencode", { recursive: true, force: true })
  } catch {
    // ok if doesn't exist
  }
}

describe("sanitize", () => {
  it("replaces path separators and special chars", () => {
    expect(sanitize("hello/world")).toBe("hello_world")
    expect(sanitize("test:file.txt")).toBe("test_file.txt")
    expect(sanitize("path<with>chars")).toBe("path_with_chars")
    expect(sanitize('file"name')).toBe("file_name")
    expect(sanitize("foo|bar")).toBe("foo_bar")
    expect(sanitize("a?b*c")).toBe("a_b_c")
    expect(sanitize("\x00\x01\x1f")).toBe("___")
  })

  it("truncates long names", () => {
    const long = "a".repeat(200)
    const sanitized = sanitize(long)
    expect(sanitized.length).toBeLessThanOrEqual(100)
  })

  it("replaces double dots", () => {
    expect(sanitize("path/../escape")).toBe("path___escape")
  })

  it("keeps valid names unchanged", () => {
    expect(sanitize("my-workflow_v2")).toBe("my-workflow_v2")
    expect(sanitize("research.audit")).toBe("research.audit")
  })
})

describe("saveSpec and loadSpec", () => {
  afterEach(cleanup)

  it("saves and loads a workflow spec", async () => {
    const spec = generateDefaultSpec("test audit")
    const name = await saveSpec(TEST_WORKTREE, spec)
    expect(name).toBe(sanitize(spec.name))

    const loaded = await loadSpec(TEST_WORKTREE, name)
    expect(loaded).not.toBeNull()
    expect(loaded!.name).toBe(spec.name)
    expect(loaded!.goal).toBe(spec.goal)
  })

  it("returns null for non-existent spec", async () => {
    const result = await loadSpec(TEST_WORKTREE, "nonexistent")
    expect(result).toBeNull()
  })

  it("loads spec that was just saved", async () => {
    const spec = normalizeSpec({
      name: "my-custom-workflow",
      goal: "custom goal",
      phases: [{ id: "p1", tasks: [{ id: "t1", prompt: "do it" }] }],
    })
    await saveSpec(TEST_WORKTREE, spec)
    const loaded = await loadSpec(TEST_WORKTREE, "my-custom-workflow")
    expect(loaded).not.toBeNull()
    expect(loaded!.phases).toHaveLength(1)
  })
})

describe("saveRun and loadRun", () => {
  afterEach(cleanup)

  it("saves and loads a run result", async () => {
    const runId = generateRunId()
    const result: RunResult = {
      runId,
      spec: generateDefaultSpec("test"),
      phaseResults: [],
      status: "completed",
      elapsedMs: 100,
      startedAt: Date.now(),
      finishedAt: Date.now(),
    }

    await saveRun(TEST_WORKTREE, result)
    const loaded = await loadRun(TEST_WORKTREE, runId)
    expect(loaded).not.toBeNull()
    expect(loaded!.runId).toBe(runId)
    expect(loaded!.status).toBe("completed")
  })

  it("returns null for non-existent run", async () => {
    const result = await loadRun(TEST_WORKTREE, "nonexistent_run")
    expect(result).toBeNull()
  })
})

describe("generateRunId", () => {
  it("generates unique ids", () => {
    const id1 = generateRunId()
    const id2 = generateRunId()
    expect(id1).not.toBe(id2)
  })

  it("starts with run_ prefix", () => {
    const id = generateRunId()
    expect(id.startsWith("run_")).toBe(true)
  })
})
