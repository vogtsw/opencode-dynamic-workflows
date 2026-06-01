import { mkdir, writeFile, readFile, readdir, stat } from "node:fs/promises";
import { join, normalize } from "node:path";
const WORKFLOWS_DIR = ".opencode/workflows";
const RUNS_DIR = "runs";
function workflowsRoot(worktree) {
    return join(normalize(worktree), WORKFLOWS_DIR);
}
function runsDir(worktree) {
    return join(workflowsRoot(worktree), RUNS_DIR);
}
function specPath(worktree, name) {
    return join(workflowsRoot(worktree), `${sanitize(name)}.json`);
}
function runPath(worktree, runId) {
    return join(runsDir(worktree), `${sanitize(runId)}.json`);
}
export function sanitize(name) {
    const value = name
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
        .replace(/\.\./g, "_")
        .slice(0, 100);
    return value || "workflow";
}
function ensureWorkflowsDir(worktree) {
    return mkdir(workflowsRoot(worktree), { recursive: true }).then(() => workflowsRoot(worktree));
}
async function ensureRunsDir(worktree) {
    const dir = runsDir(worktree);
    await mkdir(dir, { recursive: true });
    return dir;
}
export async function saveSpec(worktree, spec) {
    await ensureWorkflowsDir(worktree);
    const name = sanitize(spec.name || "workflow");
    const filePath = specPath(worktree, name);
    let existing = null;
    try {
        const raw = await readFile(filePath, "utf-8");
        existing = JSON.parse(raw);
    }
    catch {
        // File doesn't exist yet
    }
    const now = Date.now();
    const saved = {
        name,
        spec,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        runCount: (existing?.runCount ?? 0) + 1,
        lastRunAt: now,
    };
    await writeFile(filePath, JSON.stringify(saved, null, 2), "utf-8");
    return name;
}
export async function loadSpec(worktree, name) {
    const filePath = specPath(worktree, name);
    try {
        const raw = await readFile(filePath, "utf-8");
        const saved = JSON.parse(raw);
        return saved.spec;
    }
    catch {
        return null;
    }
}
export async function listSavedWorkflows(worktree) {
    const root = workflowsRoot(worktree);
    let entries;
    try {
        entries = await readdir(root, { withFileTypes: false });
    }
    catch {
        return [];
    }
    const items = [];
    for (const entry of entries) {
        const name = typeof entry === "string" ? entry : entry.name;
        if (!name.endsWith(".json") || name === RUNS_DIR)
            continue;
        const filePath = join(root, name);
        try {
            const st = await stat(filePath);
            if (!st.isFile())
                continue;
            const raw = await readFile(filePath, "utf-8");
            const saved = JSON.parse(raw);
            items.push({
                name: saved.name,
                goal: saved.spec.goal,
                phases: saved.spec.phases.length,
                tasks: saved.spec.phases.reduce((s, p) => s + p.tasks.length, 0),
                createdAt: saved.createdAt,
                runCount: saved.runCount,
                lastRunAt: saved.lastRunAt,
            });
        }
        catch {
            // Skip unreadable files
        }
    }
    items.sort((a, b) => (b.lastRunAt ?? b.createdAt) - (a.lastRunAt ?? a.createdAt));
    return items;
}
export async function getSavedWorkflow(worktree, name) {
    const filePath = specPath(worktree, name);
    try {
        const raw = await readFile(filePath, "utf-8");
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
export async function saveRun(worktree, result) {
    await ensureRunsDir(worktree);
    const filePath = runPath(worktree, result.runId);
    await writeFile(filePath, JSON.stringify(result, null, 2), "utf-8");
}
export async function loadRun(worktree, runId) {
    const filePath = runPath(worktree, runId);
    try {
        const raw = await readFile(filePath, "utf-8");
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
export async function listRuns(worktree) {
    const dir = runsDir(worktree);
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: false });
    }
    catch {
        return [];
    }
    const items = [];
    for (const entry of entries) {
        const name = typeof entry === "string" ? entry : entry.name;
        if (!name.endsWith(".json"))
            continue;
        const runId = name.replace(/\.json$/, "");
        const filePath = join(dir, name);
        try {
            const st = await stat(filePath);
            if (!st.isFile())
                continue;
            const raw = await readFile(filePath, "utf-8");
            const run = JSON.parse(raw);
            items.push({
                runId,
                name: run.spec.name,
                status: run.status,
                startedAt: run.startedAt,
            });
        }
        catch {
            // Skip unreadable files
        }
    }
    items.sort((a, b) => b.startedAt - a.startedAt);
    return items;
}
export function generateRunId() {
    const now = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    return `run_${now}_${rand}`;
}
