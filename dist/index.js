import { injectCommands } from "./commands.js";
import { createWorkflowRunTool, createWorkflowListTool, createWorkflowRunSavedTool, createWorkflowShowTool, } from "./tools.js";
export { injectCommands } from "./commands.js";
export { normalizeSpec, generateDefaultSpec, validateOptions, countTasks, SpecValidationError } from "./spec-parser.js";
export { saveSpec, loadSpec, listSavedWorkflows, getSavedWorkflow, saveRun, loadRun, listRuns, sanitize } from "./persistence.js";
export { generateReport, generateDryRunReport, generateListOutput } from "./report.js";
export { runWorkflow } from "./runner.js";
export * from "./types.js";
const server = async (ctx) => {
    const opts = {
        client: ctx.client,
        directory: ctx.directory,
        worktree: ctx.worktree,
    };
    return {
        config: async (config) => {
            injectCommands(config);
        },
        tool: {
            workflow_run: createWorkflowRunTool(opts),
            workflow_list: createWorkflowListTool(opts),
            workflow_run_saved: createWorkflowRunSavedTool(opts),
            workflow_show: createWorkflowShowTool(opts),
        },
    };
};
export default { id: "opencode-dynamic-workflows", server };
export { server };
