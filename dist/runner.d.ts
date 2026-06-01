import type { createOpencodeClient } from "@opencode-ai/sdk";
import type { WorkflowSpec, RunResult } from "./types.js";
export type SDKClient = ReturnType<typeof createOpencodeClient>;
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
}
export declare function runWorkflow(spec: WorkflowSpec, config: RunnerConfig): Promise<RunResult>;
