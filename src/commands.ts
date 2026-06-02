import type { Config } from "@opencode-ai/plugin"

export function injectCommands(config: Config): void {
  config.command ??= {}

  if (!config.command["workflow"]) {
    config.command["workflow"] = {
      description: "Run a multi-agent dynamic workflow from a JSON DSL",
      template: `Create a JSON workflow specification to accomplish the following task. Use the workflow DSL with phases (each containing parallel or sequential tasks) and optional synthesis prompts.

The task: $ARGUMENTS

After designing the spec, call the workflow_run tool with:
- goal: a concise goal string
- spec: the JSON workflow specification

The spec MUST use this exact schema:
\`\`\`json
{
  "name": "short-workflow-name",
  "goal": "the user goal",
  "phases": [
    {
      "id": "phase_id",
      "title": "Phase title",
      "strategy": "parallel",
      "tasks": [
        {
          "id": "task_id",
          "description": "Short task description",
          "prompt": "A self-contained worker prompt"
        }
      ],
      "synthesisPrompt": "Optional prompt to combine this phase's task outputs"
    }
  ]
}
\`\`\`

Guidelines for the spec:
- Use "parallel" strategy for independent research/analysis tasks
- Use "sequential" strategy when tasks depend on each other
- Add synthesisPrompt to phases that need their results combined
- Each task needs a clear, self-contained prompt
- Total tasks should be reasonable (3-10)`,
    }
  }

  if (!config.command["deep-research"]) {
    config.command["deep-research"] = {
      description: "Deep research a question using parallel subagent workers with cross-checking synthesis",
      template: `Research the following question thoroughly using a multi-agent workflow. Design a workflow spec that:

1. Splits the question into independent research angles (parallel phase)
2. Assigns each angle to a separate subagent for deep investigation
3. Synthesizes findings with cross-checking
4. Optionally runs a second verification phase

The question: $ARGUMENTS

Design and call workflow_run with a spec that has at least:
- A parallel research phase with 2-5 task angles
- A synthesis prompt that cross-checks findings and resolves contradictions
- Optionally a sequential verification phase

The spec MUST use this exact JSON DSL:
\`\`\`json
{
  "name": "deep-research-topic",
  "goal": "research question",
  "phases": [
    {
      "id": "parallel_research",
      "title": "Parallel Research",
      "strategy": "parallel",
      "tasks": [
        {
          "id": "angle_one",
          "description": "Research angle one",
          "prompt": "Self-contained instructions for this worker"
        }
      ],
      "synthesisPrompt": "Cross-check all findings, resolve contradictions, and summarize."
    },
    {
      "id": "verification",
      "title": "Verification",
      "strategy": "sequential",
      "tasks": [
        {
          "id": "verify_findings",
          "description": "Verify the synthesis",
          "prompt": "Check the previous synthesis for gaps and edge cases."
        }
      ]
    }
  ]
}
\`\`\`

Use \`id\` for phase/task identifiers and \`strategy\` for phase execution. Do not use \`type\` as the strategy field.

Do NOT rely on WebSearch being available - tasks should use available tools only.`,
    }
  }
}
