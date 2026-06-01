import { describe, it, expect } from "bun:test"
import { generateReport, generateDryRunReport, generateListOutput } from "../src/report.js"
import { normalizeSpec, generateDefaultSpec } from "../src/spec-parser.js"
import type { RunResult, WorkflowListItem } from "../src/types.js"

function makeResult(overrides: Partial<RunResult> = {}): RunResult {
  const spec = generateDefaultSpec("test goal")
  return {
    runId: "run_test123",
    spec,
    phaseResults: [
      {
        phaseId: "research",
        title: "Research",
        strategy: "parallel",
        taskResults: [
          {
            taskId: "research_background",
            sessionId: "sess-001",
            status: "completed",
            output: "Found 42 key facts about the topic.",
            elapsedMs: 1500,
          },
          {
            taskId: "research_approaches",
            sessionId: "sess-002",
            status: "completed",
            output: "Identified 3 viable approaches.",
            elapsedMs: 2200,
          },
        ],
        synthesisOutput: "Combined analysis: The key insight is X.",
        synthesisSessionId: "sess-003",
        status: "completed",
        elapsedMs: 5000,
      },
      {
        phaseId: "execute",
        title: "Execute",
        strategy: "sequential",
        taskResults: [
          {
            taskId: "plan_approach",
            sessionId: "sess-004",
            status: "completed",
            output: "Plan: Step 1, Step 2, Step 3.",
            elapsedMs: 3000,
          },
          {
            taskId: "implement",
            sessionId: "sess-005",
            status: "completed",
            output: "Implementation complete.",
            elapsedMs: 8000,
          },
        ],
        status: "completed",
        elapsedMs: 12000,
      },
    ],
    status: "completed",
    elapsedMs: 17000,
    startedAt: Date.now(),
    finishedAt: Date.now(),
    ...overrides,
  }
}

describe("generateReport", () => {
  it("generates markdown with workflow name", () => {
    const result = makeResult()
    const report = generateReport(result)
    expect(report).toContain("# Workflow:")
    expect(report).toContain("test goal")
    expect(report).toContain("run_test123")
  })

  it("includes status information", () => {
    const result = makeResult()
    const report = generateReport(result)
    expect(report).toContain("completed")
  })

  it("includes phase titles", () => {
    const result = makeResult()
    const report = generateReport(result)
    expect(report).toContain("Phase: Research")
    expect(report).toContain("Phase: Execute")
  })

  it("includes session IDs in the table", () => {
    const result = makeResult()
    const report = generateReport(result)
    expect(report).toContain("sess-001")
    expect(report).toContain("sess-005")
  })

  it("shows failed status correctly", () => {
    const result = makeResult({ status: "failed" })
    const report = generateReport(result)
    expect(report).toContain("failed")
  })

  it("includes task outputs in details sections", () => {
    const result = makeResult()
    const report = generateReport(result)
    expect(report).toContain("42 key facts")
    expect(report).toContain("<details>")
  })

  it("includes synthesis output", () => {
    const result = makeResult()
    const report = generateReport(result)
    expect(report).toContain("Combined analysis")
  })

  it("includes error information when task failed", () => {
    const result = makeResult()
    result.phaseResults[0].taskResults[0].status = "failed"
    result.phaseResults[0].taskResults[0].error = "Connection refused"
    const report = generateReport(result)
    expect(report).toContain("Connection refused")
  })

  it("truncates long task outputs in details", () => {
    const result = makeResult()
    result.phaseResults[0].taskResults[0].output = "x".repeat(3000)
    const report = generateReport(result)
    expect(report).toContain("truncated")
  })
})

describe("generateDryRunReport", () => {
  it("generates a dry run plan", () => {
    const spec = generateDefaultSpec("test")
    const report = generateDryRunReport(spec, 3)
    expect(report).toContain("Dry Run")
    expect(report).toContain("test")
    expect(report).toContain("3")
    expect(report).toContain("Strategy")
  })
})

describe("generateListOutput", () => {
  it("returns empty message for no workflows", () => {
    const output = generateListOutput([])
    expect(output).toBe("No saved workflows found.")
  })

  it("lists workflow details", () => {
    const workflows: WorkflowListItem[] = [
      {
        name: "audit",
        goal: "Security audit of the codebase",
        phases: 3,
        tasks: 8,
        createdAt: 1700000000000,
        runCount: 5,
        lastRunAt: 1710000000000,
      },
      {
        name: "migrate",
        goal: "Database migration plan",
        phases: 2,
        tasks: 4,
        createdAt: 1690000000000,
        runCount: 1,
      },
    ]
    const output = generateListOutput(workflows)
    expect(output).toContain("audit")
    expect(output).toContain("Security audit")
    expect(output).toContain("Phases: 3, Tasks: 8")
    expect(output).toContain("migrate")
  })
})
