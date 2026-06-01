# opencode-dynamic-workflows

Dynamic multi-agent workflows for [OpenCode](https://opencode.ai), implemented as a shareable OpenCode plugin.

This plugin brings a Claude Code-style dynamic workflow pattern to OpenCode: a main agent can design a workflow, then the plugin runs bounded worker sessions in parallel or sequential phases, collects their outputs, optionally synthesizes each phase, and returns a concise report.

The implementation intentionally uses a safe JSON DSL instead of executing arbitrary model-generated JavaScript.

## Features

- `workflow_run` tool for running JSON-defined multi-agent workflows
- `workflow_list`, `workflow_show`, and `workflow_run_saved` tools for saved workflows
- Automatic `/workflow` command injection
- Automatic `/deep-research` command injection
- Parallel and sequential workflow phases
- Optional phase synthesis workers
- Worker recursion protection by disabling workflow tools inside child sessions
- Concurrency and total-agent limits
- Run history persisted to `.opencode/workflows/runs/`
- Saved workflow specs persisted to `.opencode/workflows/`

## Requirements

- OpenCode 1.15 or newer
- Bun or npm for local development
- At least one configured OpenCode model provider

## Quick Install

After publishing to npm, add the package name to your OpenCode config:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-dynamic-workflows"]
}
```

Restart OpenCode after changing the config.

## Install From GitHub

Clone the repository somewhere stable:

```bash
git clone https://github.com/vogtsw/opencode-dynamic-workflows.git
cd opencode-dynamic-workflows
bun install
bun run build
```

Then reference the local path in `opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["/absolute/path/to/opencode-dynamic-workflows"]
}
```

On Windows, use an escaped absolute path:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["D:\\test\\mygithub\\opencode-dynamic-workflows"]
}
```

You can also install it with OpenCode's plugin installer:

```bash
opencode plugin /absolute/path/to/opencode-dynamic-workflows --global --force
```

## Share As A Tarball

Build and pack the plugin:

```bash
bun install
bun run build
npm pack
```

This creates a file like:

```text
opencode-dynamic-workflows-1.0.0.tgz
```

Send that `.tgz` file to another user. They can unpack it or install it into a stable directory, then reference that directory from `opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["/absolute/path/to/opencode-dynamic-workflows"]
}
```

## Publish To npm

Before publishing:

```bash
bun install
bun run build
bun test
npm pack --dry-run
```

Then publish:

```bash
npm publish
```

After publishing, other users can install it by adding this to their OpenCode config:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-dynamic-workflows"]
}
```

## Verify Installation

Check that OpenCode loaded the plugin:

```bash
opencode debug config
```

You should see:

```jsonc
{
  "command": {
    "workflow": {},
    "deep-research": {}
  }
}
```

Check that the workflow tools are available to an agent:

```bash
opencode debug agent build
```

You should see these tools:

```text
workflow_run
workflow_list
workflow_run_saved
workflow_show
```

Run a dry-run smoke test:

```bash
opencode run --model provider/model "Call the workflow_run tool once with dryRun=true and a one-task workflow spec."
```

If the plugin is working, the tool output includes:

```text
# Dry Run:
```

## Commands

### `/workflow <task>`

Asks the active model to design a workflow spec and call `workflow_run`.

Example:

```text
/workflow audit this repository for risky file writes and missing tests
```

### `/deep-research <question>`

Asks the active model to split a research question into multiple investigation angles, run them as a workflow, and synthesize the findings.

Example:

```text
/deep-research what is the best migration path from library A to library B in this codebase?
```

## Tools

### `workflow_run`

Runs a workflow from a JSON spec.

| Argument | Type | Description |
| --- | --- | --- |
| `goal` | string | Workflow goal |
| `spec` | string | JSON workflow spec. If omitted, a default workflow is generated from `goal`. |
| `concurrency` | number | Max concurrent worker sessions. Default `4`, max `16`. |
| `maxAgents` | number | Max total worker and synthesis sessions. Default `100`, max `1000`. |
| `saveAs` | string | Save the spec for later reuse under this name. |
| `dryRun` | boolean | Validate and print the plan without running workers. |
| `agent` | string | Default OpenCode agent for worker sessions. |
| `model` | string | Default model in `provider/model` format. |

### `workflow_list`

Lists saved workflow specs and recent run records.

### `workflow_show`

Shows a saved workflow spec.

### `workflow_run_saved`

Loads a saved workflow by name and runs it.

## Workflow Spec DSL

```json
{
  "name": "audit-security",
  "goal": "Audit the project for security vulnerabilities",
  "phases": [
    {
      "id": "scan",
      "title": "Parallel Scan",
      "strategy": "parallel",
      "tasks": [
        {
          "id": "secrets",
          "description": "Scan for leaked secrets",
          "prompt": "Scan all files for hardcoded API keys and credentials."
        },
        {
          "id": "deps",
          "description": "Audit dependencies",
          "prompt": "Check dependencies for known security concerns."
        }
      ],
      "synthesisPrompt": "Combine the findings, rank them by severity, and note conflicts."
    },
    {
      "id": "remediate",
      "title": "Sequential Remediation",
      "strategy": "sequential",
      "tasks": [
        {
          "id": "plan",
          "description": "Create fix plan",
          "prompt": "Based on the scan results, create a prioritized remediation plan."
        },
        {
          "id": "apply",
          "description": "Apply fixes",
          "prompt": "Implement the remediation plan from the previous step."
        }
      ]
    }
  ]
}
```

### Top-Level Fields

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | Yes | Workflow name. Also used when saving specs. |
| `goal` | string | Yes | Human-readable workflow goal. |
| `phases` | array | Yes | Ordered list of workflow phases. |

### Phase Fields

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | Yes | Unique phase ID. |
| `title` | string | No | Human-readable phase title. Defaults to `id`. |
| `strategy` | `parallel` or `sequential` | No | Execution strategy. Defaults to `parallel`. |
| `tasks` | array | Yes | Tasks in this phase. |
| `synthesisPrompt` | string | No | Optional prompt for an extra synthesis worker after phase tasks finish. |

### Task Fields

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | Yes | Unique task ID. |
| `description` | string | No | Short task description. Defaults to `id`. |
| `prompt` | string | Yes | Worker prompt. Make this self-contained. |
| `agent` | string | No | OpenCode agent override for this task. |
| `model` | string | No | Model override in `provider/model` format. |

## Persistence

Saved workflow specs:

```text
.opencode/workflows/<name>.json
```

Run records:

```text
.opencode/workflows/runs/<run-id>.json
```

The path is relative to the OpenCode worktree used by the current session.

## Safety Model

- The plugin does not execute arbitrary model-generated JavaScript.
- The workflow language is JSON only.
- Worker sessions get workflow tools disabled to reduce accidental recursion.
- `concurrency` is clamped to `1..16`.
- `maxAgents` is clamped to `1..1000`.
- Saved workflow names are sanitized before writing files.
- Task failures are captured in the report instead of crashing the whole run when possible.

## Development

Install dependencies:

```bash
bun install
```

Build:

```bash
bun run build
```

Test:

```bash
bun test
```

Package dry run:

```bash
npm pack --dry-run
```

## Project Layout

```text
src/
  commands.ts      Injects /workflow and /deep-research commands
  index.ts         OpenCode plugin entrypoint
  persistence.ts   Saved specs and run records
  report.ts        Markdown report rendering
  runner.ts        Worker-session orchestration
  spec-parser.ts   JSON DSL validation and normalization
  tools.ts         OpenCode tool definitions
  types.ts         Shared TypeScript types
tests/
  *.test.ts        Unit tests
dist/
  *.js             Built plugin JavaScript used by OpenCode
```

## License

MIT
