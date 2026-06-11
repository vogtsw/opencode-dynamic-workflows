import type { RunResult, PhaseResult, TaskResult, WorkflowSpec, WorkflowListItem } from "./types.js"

export function generateReport(result: RunResult): string {
  const lines: string[] = []
  const { spec, phaseResults, runId, status, elapsedMs, startedAt } = result

  const statusIcon = status === "completed" ? "[ok]" : status === "failed" ? "[fail]" : status === "running" ? "[run]" : "[partial]"
  const elapsed = formatElapsed(elapsedMs)

  lines.push(`# Workflow: ${spec.name}`)
  lines.push("")
  lines.push(`**Goal**: ${spec.goal}`)
  lines.push(`**Status**: ${statusIcon} ${status}`)
  lines.push(`**Elapsed**: ${elapsed}`)
  lines.push(`**Started**: ${new Date(startedAt).toISOString()}`)
  lines.push(`**Run ID**: \`${runId}\``)
  lines.push("")

  lines.push(...generateTimeline(result))

  for (const phase of phaseResults) {
    const pIcon = phase.status === "completed" ? "[ok]" : phase.status === "failed" ? "[fail]" : "[partial]"
    lines.push(`## Phase: ${phase.title} ${pIcon}`)
    lines.push(`**Strategy**: ${phase.strategy} - **Elapsed**: ${formatElapsed(phase.elapsedMs)}`)
    lines.push("")

    if (phase.taskResults.length > 0) {
      lines.push("| Task | Session ID | Status | Elapsed |")
      lines.push("|------|-----------|--------|---------|")

      for (const tr of phase.taskResults) {
        const tIcon =
          tr.status === "completed" ? "[ok]" : tr.status === "failed" ? "[fail]" : tr.status === "running" ? "[run]" : "[skip]"
        const sid = tr.sessionId ? `\`${truncate(tr.sessionId, 12)}\`` : "-"
        const attempts = tr.attempts && tr.attempts > 1 ? ` (x${tr.attempts})` : ""
        lines.push(`| ${tr.taskId} | ${sid} | ${tIcon} ${tr.status}${attempts} | ${formatElapsed(tr.elapsedMs)} |`)
      }
      lines.push("")

      for (const tr of phase.taskResults) {
        if (tr.error) {
          lines.push(`### ${tr.taskId} - Error`)
          lines.push("```")
          lines.push(tr.error)
          lines.push("```")
          lines.push("")
        } else if (tr.output && tr.output.trim()) {
          const preview = tr.output.length > 2000 ? tr.output.slice(0, 2000) + "\n\n... (truncated)" : tr.output
          lines.push(`<details>`)
          lines.push(`<summary>${tr.taskId} - Output</summary>`)
          lines.push("")
          lines.push(preview)
          lines.push("")
          lines.push(`</details>`)
          lines.push("")
        }
      }
    }

    if (phase.synthesisOutput) {
      lines.push("### Synthesis")
      lines.push("")
      lines.push(phase.synthesisOutput)
      lines.push("")
    }
  }

  if (status !== "completed") {
    lines.push("---")
    lines.push(`**Note**: This workflow ended with status \`${status}\`. Some phases or tasks may not have completed successfully.`)
  }

  return lines.join("\n")
}

export function generateDryRunReport(spec: WorkflowSpec, totalTasks: number): string {
  const lines: string[] = []

  lines.push(`# Dry Run: ${spec.name}`)
  lines.push("")
  lines.push(`**Goal**: ${spec.goal}`)
  lines.push(`**Phases**: ${spec.phases.length}`)
  lines.push(`**Total Tasks**: ${totalTasks}`)
  lines.push("")

  for (const phase of spec.phases) {
    lines.push(`## Phase: ${phase.title}`)
    lines.push(`- **ID**: \`${phase.id}\``)
    lines.push(`- **Strategy**: ${phase.strategy}`)
    lines.push(`- **Tasks**: ${phase.tasks.length}`)
    if (phase.synthesisPrompt) lines.push(`- **Synthesis**: yes`)
    lines.push("")

    for (const task of phase.tasks) {
      const model = task.model ?? "(default)"
      const agent = task.agent ?? "(default)"
      lines.push(`- **${task.id}**: ${task.description} [agent: ${agent}, model: ${model}]`)
    }

    lines.push("")
  }

  return lines.join("\n")
}

export function generateListOutput(workflows: WorkflowListItem[]): string {
  if (workflows.length === 0) {
    return "No saved workflows found."
  }

  const lines: string[] = ["# Saved Workflows", ""]

  for (const w of workflows) {
    lines.push(`- **${w.name}** - ${w.goal.slice(0, 80)}`)
    lines.push(`  Phases: ${w.phases}, Tasks: ${w.tasks}, Runs: ${w.runCount}`)
    if (w.lastRunAt) {
      lines.push(`  Last run: ${new Date(w.lastRunAt).toISOString()}`)
    }
    lines.push("")
  }

  return lines.join("\n")
}

export function generateTimeline(result: RunResult): string[] {
  interface Item {
    label: string
    startedAt: number
    finishedAt: number
  }

  const items: Item[] = []
  for (const phase of result.phaseResults) {
    for (const tr of phase.taskResults) {
      if (tr.startedAt && tr.finishedAt && tr.finishedAt > tr.startedAt) {
        items.push({ label: tr.taskId, startedAt: tr.startedAt, finishedAt: tr.finishedAt })
      }
    }
  }

  if (items.length < 2) return []

  const base = Math.min(...items.map((i) => i.startedAt))
  const end = Math.max(...items.map((i) => i.finishedAt))
  const total = Math.max(1, end - base)
  const width = 40
  const labelWidth = Math.min(24, Math.max(...items.map((i) => i.label.length)))

  const lines: string[] = ["## Timeline", "", "```text"]
  for (const item of items) {
    const startCol = Math.min(width - 1, Math.floor(((item.startedAt - base) / total) * width))
    const endCol = Math.max(startCol + 1, Math.min(width, Math.ceil(((item.finishedAt - base) / total) * width)))
    const bar = ".".repeat(startCol) + "#".repeat(endCol - startCol) + ".".repeat(width - endCol)
    const label = item.label.length > labelWidth ? item.label.slice(0, labelWidth - 1) + "~" : item.label.padEnd(labelWidth)
    lines.push(`${label} |${bar}| ${formatElapsed(item.finishedAt - item.startedAt)}`)
  }
  lines.push("```")
  lines.push("")

  return lines
}

export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const mins = Math.floor(ms / 60000)
  const secs = ((ms % 60000) / 1000).toFixed(0)
  return `${mins}m ${secs}s`
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + "..."
}
