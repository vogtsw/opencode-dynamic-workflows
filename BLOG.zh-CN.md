# 给 OpenCode 加上动态工作流：让一个任务自动拆成多 Agent 协作

写代码时，很多任务并不是“问一句、答一句”就能解决的。

比如：

- 审查一个仓库有没有安全风险
- 把一套旧 API 迁移到新 API
- 对一个技术方案做多角度调研
- 让多个子任务并行探索，再把结果汇总成可执行计划
- 先做诊断，再做修复，再做验证

这些任务天然就像一个小型项目。它们需要拆分、并发、汇总、复核，而不是把所有上下文都塞进一个主对话里。

这就是动态工作流要解决的问题。

## 什么是动态工作流

动态工作流是一种让 AI 自动编排多步骤、多 Agent 任务的机制。

普通对话模式里，模型通常在同一个上下文里一步步完成任务。上下文会越来越长，中间结果会和主任务混在一起，复杂任务很容易变得混乱。

动态工作流则把任务拆成一个可执行计划：

1. 主 Agent 根据目标生成 workflow spec
2. workflow runtime 读取 spec
3. runtime 启动多个 worker session
4. worker session 分别完成独立任务
5. runtime 收集结果
6. 必要时启动 synthesis worker 做阶段总结
7. 最后返回一份结构化报告

可以把它理解成：主 Agent 负责“想清楚怎么组织任务”，workflow runtime 负责“稳定地执行这个组织方式”。

## 它有什么好处

### 1. 并行处理复杂任务

很多任务可以天然并行。

例如做代码审计时，可以同时让不同 worker 检查：

- 密钥泄露
- 权限边界
- 依赖风险
- 文件写入风险
- 测试缺口

这些检查彼此独立，用动态工作流可以同时跑，而不是让一个模型顺序地慢慢看。

### 2. 主上下文更干净

worker 的中间探索不会污染主对话。

主对话只需要看到最终报告、阶段摘要和关键结论。复杂任务里的搜索过程、失败尝试、临时判断都可以留在子 session 里。

这会让长任务更容易继续，也更容易复盘。

### 3. 更适合多阶段任务

动态工作流不仅能并行，也能顺序执行。

例如：

1. 并行调研现状
2. 汇总调研结果
3. 生成迁移计划
4. 执行迁移
5. 验证改动

每个阶段都可以拿到前一阶段的总结，而不是让模型凭记忆继续。

### 4. 更容易复用

一个 workflow spec 可以保存下来。

例如你可以保存：

- `security-audit`
- `migration-review`
- `deep-research`
- `release-check`

下次遇到类似任务，直接运行保存过的 workflow，不需要重新设计整个流程。

### 5. 风险更可控

这个 OpenCode 插件没有执行模型生成的任意 JavaScript，而是使用 JSON DSL。

也就是说，模型只能描述：

- 有哪些 phase
- 每个 phase 是 parallel 还是 sequential
- 每个 task 的 prompt 是什么
- 是否需要 synthesis

真正的执行由插件 runtime 控制。并发数、总 agent 数、保存路径、递归调用都有限制。

## 这个项目是怎么实现的

项目地址：

```text
https://github.com/vogtsw/opencode-dynamic-workflows
```

这个项目实现为一个 OpenCode 插件，而不是修改 OpenCode 源码。

插件注册了四个工具：

- `workflow_run`
- `workflow_list`
- `workflow_show`
- `workflow_run_saved`

同时通过 OpenCode 的 config hook 注入两个命令：

- `/workflow`
- `/deep-research`

核心执行流程在 `src/runner.ts`：

1. 解析 JSON workflow spec
2. 校验 phase/task 结构
3. 根据 `parallel` 或 `sequential` 策略运行 task
4. 为每个 task 创建一个 OpenCode child session
5. 调用 `client.session.prompt()` 让 worker 执行任务
6. 收集 worker 的文本输出
7. 如果 phase 配置了 `synthesisPrompt`，再启动一个 synthesis session
8. 生成 Markdown 报告
9. 把 run 记录写入 `.opencode/workflows/runs/`

一个最小的 workflow spec 长这样：

```json
{
  "name": "verify-real-worker",
  "goal": "verify real worker execution",
  "phases": [
    {
      "id": "check",
      "title": "Check",
      "strategy": "sequential",
      "tasks": [
        {
          "id": "worker",
          "description": "Worker smoke test",
          "prompt": "Reply with exactly this sentence: WORKFLOW_WORKER_OK"
        }
      ]
    }
  ]
}
```

如果运行成功，插件会返回类似：

```text
# Workflow: verify-real-worker

Status: [ok] completed

| Task | Session ID | Status | Elapsed |
|------|-----------|--------|---------|
| worker | `ses_...` | [ok] completed | 3.7s |

WORKFLOW_WORKER_OK
```

## 和 Claude Code Dynamic Workflows 的区别

Claude Code 的 Dynamic Workflows 更接近“模型生成 JavaScript 编排脚本，然后由 runtime 执行脚本”。

这个 OpenCode 插件选择了更保守的实现方式：

- 不执行任意 JS
- 使用 JSON DSL
- runtime 只解释固定字段
- worker 才拥有具体工具能力
- workflow 自身只负责调度

这样牺牲了一部分灵活性，但换来了更简单的分享方式和更明确的安全边界。

## OpenCode 里怎么使用

### 1. 安装插件

克隆项目：

```bash
git clone https://github.com/vogtsw/opencode-dynamic-workflows.git
cd opencode-dynamic-workflows
bun install
bun run build
```

然后在 OpenCode 配置里添加插件路径：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["/absolute/path/to/opencode-dynamic-workflows"]
}
```

Windows 示例：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["D:\\test\\mygithub\\opencode-dynamic-workflows"]
}
```

也可以用 OpenCode 插件命令安装：

```bash
opencode plugin /absolute/path/to/opencode-dynamic-workflows --global --force
```

### 2. 验证插件是否加载

查看配置：

```bash
opencode debug config
```

查看 agent 工具：

```bash
opencode debug agent build
```

你应该能看到：

```text
workflow_run
workflow_list
workflow_show
workflow_run_saved
```

### 3. 使用 `/workflow`

在 OpenCode 里输入：

```text
/workflow audit this repository for risky file writes and missing tests
```

模型会先设计一个 workflow spec，然后调用 `workflow_run`。

### 4. 使用 `/deep-research`

```text
/deep-research compare the best migration path from library A to library B in this repo
```

这个命令会更偏向并行调研和交叉验证。

### 5. 直接让模型调用工具

也可以直接要求模型调用 `workflow_run`：

```text
Call workflow_run with dryRun=true and create a 3-task parallel workflow to inspect this repo.
```

如果想真实执行 worker，把 `dryRun` 设为 `false`。

## 适合哪些场景

动态工作流尤其适合：

- 代码审计
- 大规模重构前调研
- 多文件迁移
- 发布前检查
- 架构方案比较
- 复杂 bug 的多假设排查
- 文档、测试、实现分阶段生成

不太适合：

- 很简单的一问一答
- 只改一个小文件
- 需要用户频繁中途确认的任务

当前版本的 workflow 运行中不会暂停等待用户输入，所以更适合边界清楚、可以自动跑完的任务。

## 小结

动态工作流的价值不在于“让 AI 看起来更复杂”，而在于把复杂任务的组织方式显式化。

它让模型不只是回答问题，而是可以：

- 拆任务
- 分派 worker
- 并行探索
- 汇总判断
- 保存流程
- 复用流程

对 OpenCode 来说，这个插件提供了一种轻量、安全、可分享的多 Agent 编排方式。它没有修改 OpenCode 本体，只通过插件机制扩展能力，因此很适合作为团队内部工作流模板或开源插件继续迭代。
