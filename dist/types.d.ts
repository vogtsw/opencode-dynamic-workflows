export interface WorkflowSpec {
    name: string;
    goal: string;
    phases: Phase[];
}
export interface Phase {
    id: string;
    title: string;
    strategy?: "parallel" | "sequential";
    tasks: Task[];
    synthesisPrompt?: string;
}
export interface Task {
    id: string;
    description: string;
    prompt: string;
    agent?: string;
    model?: string;
}
export type TaskStatus = "pending" | "running" | "completed" | "failed" | "skipped";
export interface TaskResult {
    taskId: string;
    sessionId: string;
    status: TaskStatus;
    output: string;
    elapsedMs: number;
    error?: string;
}
export interface PhaseResult {
    phaseId: string;
    title: string;
    strategy: "parallel" | "sequential";
    taskResults: TaskResult[];
    synthesisOutput?: string;
    synthesisSessionId?: string;
    status: "completed" | "failed" | "partial";
    elapsedMs: number;
}
export interface RunResult {
    runId: string;
    spec: WorkflowSpec;
    phaseResults: PhaseResult[];
    status: "completed" | "failed" | "partial";
    elapsedMs: number;
    startedAt: number;
    finishedAt: number;
}
export interface RunOptions {
    goal: string;
    spec?: string;
    concurrency?: number;
    maxAgents?: number;
    saveAs?: string;
    dryRun?: boolean;
    agent?: string;
    model?: string;
}
export interface SavedWorkflow {
    name: string;
    spec: WorkflowSpec;
    createdAt: number;
    updatedAt: number;
    runCount: number;
    lastRunAt?: number;
}
export interface WorkflowListItem {
    name: string;
    goal: string;
    phases: number;
    tasks: number;
    createdAt: number;
    runCount: number;
    lastRunAt?: number;
}
