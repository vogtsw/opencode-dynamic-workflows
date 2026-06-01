import type { WorkflowSpec, Phase, Task } from "./types.js"

export const DEFAULT_CONCURRENCY = 4
export const MAX_CONCURRENCY = 16
export const DEFAULT_MAX_AGENTS = 100
export const MAX_MAX_AGENTS = 1000

export class SpecValidationError extends Error {
  constructor(
    message: string,
    public issues: string[],
  ) {
    super(message)
    this.name = "SpecValidationError"
  }
}

export function normalizeSpec(raw: Record<string, unknown>): WorkflowSpec {
  const issues: string[] = []

  if (!raw || typeof raw !== "object") {
    throw new SpecValidationError("Spec must be a JSON object", ["root is not an object"])
  }

  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : ""
  if (!name) issues.push("name is required and must be a non-empty string")

  const goal = typeof raw.goal === "string" && raw.goal.trim() ? raw.goal.trim() : ""
  if (!goal) issues.push("goal is required and must be a non-empty string")

  let phases: Phase[] = []
  if (Array.isArray(raw.phases)) {
    phases = raw.phases.map((p: unknown, i: number) => normalizePhase(p, i, issues))
  } else {
    issues.push("phases must be an array")
  }

  if (phases.length === 0) {
    issues.push("spec must have at least one phase")
  }

  const taskCount = phases.reduce((sum, p) => sum + p.tasks.length, 0)
  if (taskCount === 0) {
    issues.push("spec must have at least one task across all phases")
  }

  if (issues.length > 0) {
    throw new SpecValidationError(`Invalid workflow spec: ${issues.join("; ")}`, issues)
  }

  const seenIds = new Set<string>()
  for (const p of phases) {
    if (seenIds.has(p.id)) issues.push(`duplicate phase id: ${p.id}`)
    seenIds.add(p.id)
    for (const t of p.tasks) {
      if (seenIds.has(t.id)) issues.push(`duplicate task id: ${t.id}`)
      seenIds.add(t.id)
    }
  }
  if (issues.length > 0) {
    throw new SpecValidationError(`Invalid workflow spec: ${issues.join("; ")}`, issues)
  }

  return { name, goal, phases }
}

function normalizePhase(raw: unknown, index: number, issues: string[]): Phase {
  if (!raw || typeof raw !== "object") {
    const id = `phase_${index}`
    issues.push(`phase at index ${index} must be an object`)
    return { id, title: id, strategy: "parallel", tasks: [] }
  }

  const obj = raw as Record<string, unknown>
  const id = typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : `phase_${index}`
  const title = typeof obj.title === "string" && obj.title.trim() ? obj.title.trim() : id

  let strategy: "parallel" | "sequential" = "parallel"
  if (obj.strategy === "sequential") strategy = "sequential"

  let tasks: Task[] = []
  if (Array.isArray(obj.tasks)) {
    tasks = obj.tasks.map((t: unknown, ti: number) => normalizeTask(t, ti, id, issues))
  } else {
    issues.push(`phase ${id}: tasks must be an array`)
  }

  if (tasks.length === 0) {
    issues.push(`phase ${id}: must have at least one task`)
  }

  let synthesisPrompt: string | undefined
  if (typeof obj.synthesisPrompt === "string" && obj.synthesisPrompt.trim()) {
    synthesisPrompt = obj.synthesisPrompt.trim()
  }

  return { id, title, strategy, tasks, synthesisPrompt }
}

function normalizeTask(raw: unknown, index: number, phaseId: string, issues: string[]): Task {
  if (!raw || typeof raw !== "object") {
    const id = `${phaseId}_task_${index}`
    issues.push(`task at index ${index} in phase ${phaseId} must be an object`)
    return { id, description: id, prompt: "complete the task" }
  }

  const obj = raw as Record<string, unknown>
  const id = typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : `${phaseId}_task_${index}`
  const description = typeof obj.description === "string" && obj.description.trim()
    ? obj.description.trim()
    : id

  if (!obj.prompt || (typeof obj.prompt !== "string" && typeof obj.prompt !== "object")) {
    issues.push(`task ${id}: prompt is required`)
  }
  const prompt = typeof obj.prompt === "string" ? obj.prompt : JSON.stringify(obj.prompt)

  let agent: string | undefined
  if (typeof obj.agent === "string" && obj.agent.trim()) {
    agent = obj.agent.trim()
  }

  let model: string | undefined
  if (typeof obj.model === "string" && obj.model.trim()) {
    model = obj.model.trim()
  }

  return { id, description, prompt, agent, model }
}

export function generateDefaultSpec(goal: string): WorkflowSpec {
  const clean = goal.trim()
  if (!clean) {
    throw new SpecValidationError("Goal must be a non-empty string", ["goal is required"])
  }
  return {
    name: clean.slice(0, 50).replace(/[^a-zA-Z0-9_-]/g, "_"),
    goal: clean,
    phases: [
      {
        id: "research",
        title: "Research",
        strategy: "parallel",
        tasks: [
          {
            id: "research_background",
            description: "Research background and context",
            prompt: `Research the following topic thoroughly. Gather key facts, context, and important background information. Organize findings clearly.\n\nTopic: ${clean}`,
          },
          {
            id: "research_approaches",
            description: "Research approaches and alternatives",
            prompt: `Investigate different approaches, methodologies, and alternatives related to this topic. Compare pros and cons.\n\nTopic: ${clean}`,
          },
        ],
        synthesisPrompt: `Synthesize the research findings above into a comprehensive summary. Identify the most important insights, patterns, and conclusions. Be concise but thorough.`,
      },
      {
        id: "execute",
        title: "Execute",
        strategy: "sequential",
        tasks: [
          {
            id: "plan_approach",
            description: "Plan the approach",
            prompt: `Based on the research, create a detailed plan of action.\n\nGoal: ${clean}`,
          },
          {
            id: "implement",
            description: "Implement the plan",
            prompt: `Execute the plan step by step. Work through each item carefully.\n\nGoal: ${clean}`,
          },
        ],
      },
    ],
  }
}

export function validateOptions(concurrency?: number, maxAgents?: number): { concurrency: number; maxAgents: number } {
  const c = Math.max(1, Math.min(concurrency ?? DEFAULT_CONCURRENCY, MAX_CONCURRENCY))
  const m = Math.max(1, Math.min(maxAgents ?? DEFAULT_MAX_AGENTS, MAX_MAX_AGENTS))
  return { concurrency: c, maxAgents: m }
}

export function countTasks(spec: WorkflowSpec): number {
  let count = 0
  for (const phase of spec.phases) {
    count += phase.tasks.length
    if (phase.synthesisPrompt) count += 1
  }
  return count
}
