import type { WorkflowSpec, RunResult, SavedWorkflow, WorkflowListItem } from "./types.js";
export declare function sanitize(name: string): string;
export declare function saveSpec(worktree: string, spec: WorkflowSpec): Promise<string>;
export declare function loadSpec(worktree: string, name: string): Promise<WorkflowSpec | null>;
export declare function listSavedWorkflows(worktree: string): Promise<WorkflowListItem[]>;
export declare function getSavedWorkflow(worktree: string, name: string): Promise<SavedWorkflow | null>;
export declare function saveRun(worktree: string, result: RunResult): Promise<void>;
export declare function loadRun(worktree: string, runId: string): Promise<RunResult | null>;
export declare function listRuns(worktree: string): Promise<{
    runId: string;
    name: string;
    status: string;
    startedAt: number;
    progress?: string;
}[]>;
export declare function generateRunId(): string;
