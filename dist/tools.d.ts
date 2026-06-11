import type { SDKClient } from "./runner.js";
export interface ToolFactoryOptions {
    client: SDKClient;
    directory: string;
    worktree: string;
}
export declare function createWorkflowRunTool(opts: ToolFactoryOptions): {
    description: string;
    args: {
        goal: import("zod").ZodString;
        spec: import("zod").ZodOptional<import("zod").ZodString>;
        concurrency: import("zod").ZodOptional<import("zod").ZodNumber>;
        maxAgents: import("zod").ZodOptional<import("zod").ZodNumber>;
        saveAs: import("zod").ZodOptional<import("zod").ZodString>;
        dryRun: import("zod").ZodOptional<import("zod").ZodBoolean>;
        agent: import("zod").ZodOptional<import("zod").ZodString>;
        model: import("zod").ZodOptional<import("zod").ZodString>;
    };
    execute(args: {
        goal: string;
        spec?: string | undefined;
        concurrency?: number | undefined;
        maxAgents?: number | undefined;
        saveAs?: string | undefined;
        dryRun?: boolean | undefined;
        agent?: string | undefined;
        model?: string | undefined;
    }, context: import("@opencode-ai/plugin").ToolContext): Promise<import("@opencode-ai/plugin").ToolResult>;
};
export declare function createWorkflowListTool(_opts: ToolFactoryOptions): {
    description: string;
    args: {};
    execute(args: Record<string, never>, context: import("@opencode-ai/plugin").ToolContext): Promise<import("@opencode-ai/plugin").ToolResult>;
};
export declare function createWorkflowRunSavedTool(opts: ToolFactoryOptions): {
    description: string;
    args: {
        name: import("zod").ZodString;
        concurrency: import("zod").ZodOptional<import("zod").ZodNumber>;
        maxAgents: import("zod").ZodOptional<import("zod").ZodNumber>;
        agent: import("zod").ZodOptional<import("zod").ZodString>;
        model: import("zod").ZodOptional<import("zod").ZodString>;
    };
    execute(args: {
        name: string;
        concurrency?: number | undefined;
        maxAgents?: number | undefined;
        agent?: string | undefined;
        model?: string | undefined;
    }, context: import("@opencode-ai/plugin").ToolContext): Promise<import("@opencode-ai/plugin").ToolResult>;
};
export declare function createWorkflowResumeTool(opts: ToolFactoryOptions): {
    description: string;
    args: {
        runId: import("zod").ZodString;
        concurrency: import("zod").ZodOptional<import("zod").ZodNumber>;
        maxAgents: import("zod").ZodOptional<import("zod").ZodNumber>;
        agent: import("zod").ZodOptional<import("zod").ZodString>;
        model: import("zod").ZodOptional<import("zod").ZodString>;
    };
    execute(args: {
        runId: string;
        concurrency?: number | undefined;
        maxAgents?: number | undefined;
        agent?: string | undefined;
        model?: string | undefined;
    }, context: import("@opencode-ai/plugin").ToolContext): Promise<import("@opencode-ai/plugin").ToolResult>;
};
export declare function createWorkflowShowTool(_opts: ToolFactoryOptions): {
    description: string;
    args: {
        name: import("zod").ZodString;
    };
    execute(args: {
        name: string;
    }, context: import("@opencode-ai/plugin").ToolContext): Promise<import("@opencode-ai/plugin").ToolResult>;
};
