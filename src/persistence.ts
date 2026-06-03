import { mkdir, writeFile, readFile, readdir, stat } from "node:fs/promises"
import { join, normalize } from "node:path"
import type { WorkflowSpec, RunResult, SavedWorkflow, WorkflowListItem } from "./types.js"

const WORKFLOWS_DIR = ".opencode/workflows"
const RUNS_DIR = "runs"

function workflowsRoot(worktree: string): string {
  return join(normalize(worktree), WORKFLOWS_DIR)
}

function runsDir(worktree: string): string {
  return join(workflowsRoot(worktree), RUNS_DIR)
}

function specPath(worktree: string, name: string): string {
  return join(workflowsRoot(worktree), `${sanitize(name)}.json`)
}

function runPath(worktree: string, runId: string): string {
  return join(runsDir(worktree), `${sanitize(runId)}.json`)
}

export function sanitize(name: string): string {
  const value = name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\.\./g, "_")
    .slice(0, 100)
  return value || "workflow"
}

function ensureWorkflowsDir(worktree: string): Promise<string> {
  return mkdir(workflowsRoot(worktree), { recursive: true }).then(() => workflowsRoot(worktree))
}

async function ensureRunsDir(worktree: string): Promise<string> {
  const dir = runsDir(worktree)
  await mkdir(dir, { recursive: true })
  return dir
}

export async function saveSpec(worktree: string, spec: WorkflowSpec): Promise<string> {
  await ensureWorkflowsDir(worktree)
  const name = sanitize(spec.name || "workflow")
  const filePath = specPath(worktree, name)

  let existing: SavedWorkflow | null = null
  try {
    const raw = await readFile(filePath, "utf-8")
    existing = JSON.parse(raw) as SavedWorkflow
  } catch {
    // File doesn't exist yet
  }

  const now = Date.now()
  const saved: SavedWorkflow = {
    name,
    spec,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    runCount: (existing?.runCount ?? 0) + 1,
    lastRunAt: now,
  }

  await writeFile(filePath, JSON.stringify(saved, null, 2), "utf-8")
  return name
}

export async function loadSpec(worktree: string, name: string): Promise<WorkflowSpec | null> {
  const filePath = specPath(worktree, name)
  try {
    const raw = await readFile(filePath, "utf-8")
    const saved = JSON.parse(raw) as SavedWorkflow
    return saved.spec
  } catch {
    return null
  }
}

export async function listSavedWorkflows(worktree: string): Promise<WorkflowListItem[]> {
  const root = workflowsRoot(worktree)
  let entries: { name: string }[]
  try {
    entries = await readdir(root, { withFileTypes: false }) as any
  } catch {
    return []
  }

  const items: WorkflowListItem[] = []
  for (const entry of entries) {
    const name = typeof entry === "string" ? entry : entry.name
    if (!name.endsWith(".json") || name === RUNS_DIR) continue
    const filePath = join(root, name)
    try {
      const st = await stat(filePath)
      if (!st.isFile()) continue
      const raw = await readFile(filePath, "utf-8")
      const saved = JSON.parse(raw) as SavedWorkflow
      items.push({
        name: saved.name,
        goal: saved.spec.goal,
        phases: saved.spec.phases.length,
        tasks: saved.spec.phases.reduce((s, p) => s + p.tasks.length, 0),
        createdAt: saved.createdAt,
        runCount: saved.runCount,
        lastRunAt: saved.lastRunAt,
      })
    } catch {
      // Skip unreadable files
    }
  }

  items.sort((a, b) => (b.lastRunAt ?? b.createdAt) - (a.lastRunAt ?? a.createdAt))
  return items
}

export async function getSavedWorkflow(worktree: string, name: string): Promise<SavedWorkflow | null> {
  const filePath = specPath(worktree, name)
  try {
    const raw = await readFile(filePath, "utf-8")
    return JSON.parse(raw) as SavedWorkflow
  } catch {
    return null
  }
}

export async function saveRun(worktree: string, result: RunResult): Promise<void> {
  await ensureRunsDir(worktree)
  const filePath = runPath(worktree, result.runId)
  await writeFile(filePath, JSON.stringify(result, null, 2), "utf-8")
}

export async function loadRun(worktree: string, runId: string): Promise<RunResult | null> {
  const filePath = runPath(worktree, runId)
  try {
    const raw = await readFile(filePath, "utf-8")
    return JSON.parse(raw) as RunResult
  } catch {
    return null
  }
}

export async function listRuns(worktree: string): Promise<{ runId: string; name: string; status: string; startedAt: number; progress?: string }[]> {
  const dir = runsDir(worktree)
  let entries: { name: string }[]
  try {
    entries = await readdir(dir, { withFileTypes: false }) as any
  } catch {
    return []
  }

  const items: { runId: string; name: string; status: string; startedAt: number; progress?: string }[] = []
  for (const entry of entries) {
    const name = typeof entry === "string" ? entry : entry.name
    if (!name.endsWith(".json")) continue
    const runId = name.replace(/\.json$/, "")
    const filePath = join(dir, name)
    try {
      const st = await stat(filePath)
      if (!st.isFile()) continue
      const raw = await readFile(filePath, "utf-8")
      const run = JSON.parse(raw) as RunResult
      items.push({
        runId,
        name: run.spec.name,
        status: run.status,
        startedAt: run.startedAt,
        progress: run.progress
          ? `${run.progress.message} (${(run.progress.taskCompleted ?? 0) + (run.progress.taskFailed ?? 0) + (run.progress.taskSkipped ?? 0)}/${run.progress.taskTotal} done, ${run.progress.taskRunning ?? 0} running, ${run.progress.taskFailed ?? 0} failed)`
          : undefined,
      })
    } catch {
      // Skip unreadable files
    }
  }

  items.sort((a, b) => b.startedAt - a.startedAt)
  return items
}

export function generateRunId(): string {
  const now = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 8)
  return `run_${now}_${rand}`
}
