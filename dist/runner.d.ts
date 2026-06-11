import type { createOpencodeClient } from "@opencode-ai/sdk";
import type { WorkflowSpec, TaskResult, RunResult, WorkflowProgress } from "./types.js";
export type SDKClient = ReturnType<typeof createOpencodeClient>;
export interface ResumeState {
    runId: string;
    startedAt: number;
    completed: Map<string, TaskResult>;
}
export interface RunnerConfig {
    client: SDKClient;
    directory: string;
    worktree: string;
    sessionID: string;
    concurrency?: number;
    maxAgents?: number;
    defaultAgent?: string;
    defaultModel?: string;
    abort?: AbortSignal;
    resume?: ResumeState;
    onProgress?: (progress: WorkflowProgress) => void | Promise<void>;
}
export declare function runWorkflow(spec: WorkflowSpec, config: RunnerConfig): Promise<RunResult>;
