import type { RunResult, WorkflowSpec, WorkflowListItem } from "./types.js";
export declare function generateReport(result: RunResult): string;
export declare function generateDryRunReport(spec: WorkflowSpec, totalTasks: number): string;
export declare function generateListOutput(workflows: WorkflowListItem[]): string;
export declare function generateTimeline(result: RunResult): string[];
export declare function formatElapsed(ms: number): string;
