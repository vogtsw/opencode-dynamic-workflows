import { describe, it, expect } from "bun:test"
import {
  normalizeSpec,
  generateDefaultSpec,
  validateOptions,
  countTasks,
  SpecValidationError,
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
  DEFAULT_MAX_AGENTS,
  MAX_MAX_AGENTS,
} from "../src/spec-parser.js"

describe("normalizeSpec", () => {
  it("parses a valid minimal spec", () => {
    const raw = {
      name: "test-workflow",
      goal: "test something",
      phases: [
        {
          id: "p1",
          title: "Phase 1",
          tasks: [{ id: "t1", description: "do it", prompt: "do the thing" }],
        },
      ],
    }
    const spec = normalizeSpec(raw)
    expect(spec.name).toBe("test-workflow")
    expect(spec.goal).toBe("test something")
    expect(spec.phases).toHaveLength(1)
    expect(spec.phases[0].id).toBe("p1")
    expect(spec.phases[0].strategy).toBe("parallel")
    expect(spec.phases[0].tasks).toHaveLength(1)
    expect(spec.phases[0].tasks[0].id).toBe("t1")
    expect(spec.phases[0].tasks[0].prompt).toBe("do the thing")
  })

  it("defaults missing phase id and title", () => {
    const raw = {
      name: "test",
      goal: "test goal",
      phases: [{ tasks: [{ prompt: "hello" }] }],
    }
    const spec = normalizeSpec(raw)
    expect(spec.phases[0].id).toBe("phase_0")
    expect(spec.phases[0].title).toBe("phase_0")
    expect(spec.phases[0].tasks[0].id).toBe("phase_0_task_0")
  })

  it("defaults strategy to parallel for unknown values", () => {
    const raw = {
      name: "test",
      goal: "test",
      phases: [{ id: "p1", strategy: "unknown", tasks: [{ prompt: "x" }] }],
    }
    const spec = normalizeSpec(raw)
    expect(spec.phases[0].strategy).toBe("parallel")
  })

  it("preserves sequential strategy", () => {
    const raw = {
      name: "test",
      goal: "test",
      phases: [{ id: "p1", strategy: "sequential", tasks: [{ prompt: "x" }] }],
    }
    const spec = normalizeSpec(raw)
    expect(spec.phases[0].strategy).toBe("sequential")
  })

  it("throws on empty name", () => {
    const raw = { name: "", goal: "g", phases: [{ tasks: [{ prompt: "x" }] }] }
    expect(() => normalizeSpec(raw)).toThrow(SpecValidationError)
  })

  it("throws on empty goal", () => {
    const raw = { name: "n", goal: "  ", phases: [{ tasks: [{ prompt: "x" }] }] }
    expect(() => normalizeSpec(raw)).toThrow(SpecValidationError)
  })

  it("throws on non-array phases", () => {
    const raw = { name: "n", goal: "g", phases: "not-array" }
    expect(() => normalizeSpec(raw)).toThrow(SpecValidationError)
  })

  it("throws on empty phases array", () => {
    const raw = { name: "n", goal: "g", phases: [] }
    expect(() => normalizeSpec(raw)).toThrow(SpecValidationError)
  })

  it("throws on missing tasks", () => {
    const raw = { name: "n", goal: "g", phases: [{ id: "p1", tasks: [] }] }
    expect(() => normalizeSpec(raw)).toThrow(SpecValidationError)
  })

  it("throws on duplicate ids", () => {
    const raw = {
      name: "n",
      goal: "g",
      phases: [
        { id: "dup", tasks: [{ id: "t1", prompt: "x" }] },
        { id: "dup", tasks: [{ id: "t2", prompt: "y" }] },
      ],
    }
    expect(() => normalizeSpec(raw)).toThrow(SpecValidationError)
  })

  it("throws on non-object root", () => {
    expect(() => normalizeSpec("not object" as any)).toThrow(SpecValidationError)
  })

  it("handles synthesis prompt", () => {
    const raw = {
      name: "test",
      goal: "test",
      phases: [
        {
          id: "p1",
          tasks: [{ id: "t1", prompt: "x" }],
          synthesisPrompt: "summarize everything",
        },
      ],
    }
    const spec = normalizeSpec(raw)
    expect(spec.phases[0].synthesisPrompt).toBe("summarize everything")
  })

  it("strips whitespace from name and goal", () => {
    const raw = {
      name: "  my workflow  ",
      goal: "  achieve greatness  ",
      phases: [{ tasks: [{ prompt: "x" }] }],
    }
    const spec = normalizeSpec(raw)
    expect(spec.name).toBe("my workflow")
    expect(spec.goal).toBe("achieve greatness")
  })

  it("handles agent and model on tasks", () => {
    const raw = {
      name: "test",
      goal: "test",
      phases: [
        {
          id: "p1",
          tasks: [
            { id: "t1", prompt: "x", agent: "build", model: "anthropic/claude-haiku" },
          ],
        },
      ],
    }
    const spec = normalizeSpec(raw)
    expect(spec.phases[0].tasks[0].agent).toBe("build")
    expect(spec.phases[0].tasks[0].model).toBe("anthropic/claude-haiku")
  })

  it("accepts model-generated aliases for phase and task names", () => {
    const raw = {
      name: "kernelagent-langgraph-analysis",
      goal: "Analyze KernelAgent and map it to LangGraph",
      phases: [
        {
          name: "parallel_research",
          type: "parallel",
          tasks: [
            {
              name: "core_pipeline_flow",
              description: "Trace the core pipeline",
              prompt: "Read the core pipeline files and report the flow.",
            },
          ],
        },
        {
          name: "verification",
          type: "sequential",
          tasks: [
            {
              name: "crosscheck",
              prompt: "Verify the flow analysis.",
            },
          ],
        },
      ],
    }

    const spec = normalizeSpec(raw)
    expect(spec.phases[0].id).toBe("parallel_research")
    expect(spec.phases[0].strategy).toBe("parallel")
    expect(spec.phases[0].tasks[0].id).toBe("core_pipeline_flow")
    expect(spec.phases[1].id).toBe("verification")
    expect(spec.phases[1].strategy).toBe("sequential")
    expect(spec.phases[1].tasks[0].id).toBe("crosscheck")
  })
})

describe("generateDefaultSpec", () => {
  it("generates a spec with research and execute phases", () => {
    const spec = generateDefaultSpec("audit security of the codebase")
    expect(spec.phases).toHaveLength(2)
    expect(spec.phases[0].id).toBe("research")
    expect(spec.phases[0].strategy).toBe("parallel")
    expect(spec.phases[0].tasks).toHaveLength(2)
    expect(spec.phases[0].synthesisPrompt).toBeDefined()
    expect(spec.phases[1].id).toBe("execute")
    expect(spec.phases[1].strategy).toBe("sequential")
    expect(spec.phases[1].tasks).toHaveLength(2)
  })

  it("sanitizes name from goal", () => {
    const spec = generateDefaultSpec("Hello World! This is a test?")
    expect(spec.name).not.toContain(" ")
    expect(spec.name).not.toContain("!")
    expect(spec.name).not.toContain("?")
  })
})

describe("validateOptions", () => {
  it("returns defaults when given undefined", () => {
    const opts = validateOptions(undefined, undefined)
    expect(opts.concurrency).toBe(DEFAULT_CONCURRENCY)
    expect(opts.maxAgents).toBe(DEFAULT_MAX_AGENTS)
  })

  it("clamps concurrency to max", () => {
    const opts = validateOptions(100, undefined)
    expect(opts.concurrency).toBe(MAX_CONCURRENCY)
  })

  it("clamps maxAgents to max", () => {
    const opts = validateOptions(undefined, 5000)
    expect(opts.maxAgents).toBe(MAX_MAX_AGENTS)
  })

  it("clamps to minimum of 1", () => {
    const opts = validateOptions(0, -5)
    expect(opts.concurrency).toBe(1)
    expect(opts.maxAgents).toBe(1)
  })

  it("uses provided values within range", () => {
    const opts = validateOptions(8, 50)
    expect(opts.concurrency).toBe(8)
    expect(opts.maxAgents).toBe(50)
  })
})

describe("task retries and timeoutMs", () => {
  it("parses and clamps retries", () => {
    const spec = normalizeSpec({
      name: "t",
      goal: "g",
      phases: [
        {
          id: "p1",
          tasks: [
            { id: "a", prompt: "x", retries: 2 },
            { id: "b", prompt: "x", retries: 99 },
            { id: "c", prompt: "x", retries: -1 },
            { id: "d", prompt: "x" },
          ],
        },
      ],
    })
    const tasks = spec.phases[0].tasks
    expect(tasks[0].retries).toBe(2)
    expect(tasks[1].retries).toBe(3)
    expect(tasks[2].retries).toBe(0)
    expect(tasks[3].retries).toBeUndefined()
  })

  it("parses and clamps timeoutMs", () => {
    const spec = normalizeSpec({
      name: "t",
      goal: "g",
      phases: [
        {
          id: "p1",
          tasks: [
            { id: "a", prompt: "x", timeoutMs: 60000 },
            { id: "b", prompt: "x", timeoutMs: 1 },
            { id: "c", prompt: "x", timeoutMs: 99999999 },
            { id: "d", prompt: "x" },
          ],
        },
      ],
    })
    const tasks = spec.phases[0].tasks
    expect(tasks[0].timeoutMs).toBe(60000)
    expect(tasks[1].timeoutMs).toBe(5000)
    expect(tasks[2].timeoutMs).toBe(1800000)
    expect(tasks[3].timeoutMs).toBeUndefined()
  })
})

describe("countTasks", () => {
  it("counts tasks without synthesis", () => {
    const spec = generateDefaultSpec("test")
    // 2 tasks in research + 2 in execute = 4, but research has synthesis => +1 = 5
    const count = countTasks(spec)
    expect(count).toBe(5)
  })

  it("counts tasks total", () => {
    const raw = {
      name: "test",
      goal: "test",
      phases: [
        { id: "p1", tasks: [{ prompt: "a" }, { prompt: "b" }, { prompt: "c" }] },
        { id: "p2", tasks: [{ prompt: "d" }], synthesisPrompt: "s" },
      ],
    }
    const spec = normalizeSpec(raw)
    expect(countTasks(spec)).toBe(5) // 3 + 1 + 1 synthesis
  })
})
