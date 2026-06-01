import type { WorkflowSpec } from "./types.js";
export declare const DEFAULT_CONCURRENCY = 4;
export declare const MAX_CONCURRENCY = 16;
export declare const DEFAULT_MAX_AGENTS = 100;
export declare const MAX_MAX_AGENTS = 1000;
export declare class SpecValidationError extends Error {
    issues: string[];
    constructor(message: string, issues: string[]);
}
export declare function normalizeSpec(raw: Record<string, unknown>): WorkflowSpec;
export declare function generateDefaultSpec(goal: string): WorkflowSpec;
export declare function validateOptions(concurrency?: number, maxAgents?: number): {
    concurrency: number;
    maxAgents: number;
};
export declare function countTasks(spec: WorkflowSpec): number;
