# @agent/runtime

装配根。把全部领域包接成一个可运行的 `AgentRuntime`，其它应用只依赖它，不自己拼装。

## 装配了什么

| 领域包 | 在运行时中的角色 |
|---|---|
| `@agent/task-ledger` | SQLite 任务、事件、检查点 |
| `@agent/tools` | 内置工具注册表（`read_file` / `write_file` / `run_tests`） |
| `@agent/policy` | `ToolPermissionPolicy` → `GuardedToolExecutor` → `PolicyToolExecutor` 注入 Runner |
| `@agent/runner` | `ReActRunner`，带记忆召回与上下文压缩 |
| `@agent/routing` | `RunnerRouter`（6 种 Runner）+ `DecisionRouter`（规则 / Jev） |
| `@agent/verifier` | `DeterministicVerifier` |
| `@agent/memory` | `MemoryStore` + `ContextCompressor` |
| `@agent/sync` | 设备身份与账本导入导出 |

## 关键行为

- **工具调用必经策略**：`ReActRunner` 的 `executor` 被设成 `PolicyToolExecutor`，写文件这类高风险操作会先要审批。
- **审批即暂停**：工具被拒且带 `approvalId` 时任务转 `paused`，不会在副作用未执行时宣布成功。
- **审批可跨重启**：`isApproved` / `approvedTools` 从事件账本回放。

## 用法

```ts
import { AgentRuntime, newTaskId } from "@agent/runtime";

const runtime = new AgentRuntime({ config: { workspaceRoot: "/path/to/workspace" } });
const taskId = newTaskId();
runtime.createTask({ taskId, goal: "inspect the repo", runnerType: "direct" });
await runtime.runToCompletion(taskId);
console.log(runtime.getTask(taskId)?.status);
runtime.close();
```

## CLI

```bash
node dist/main.js run "say something short"
node dist/main.js verify <taskId>
```

HTTP 控制面在 `@agent/gateway`，不在这里。

## 配置

`RuntimeConfig` 覆盖 `storageDir`、`workspaceRoot`、审批策略、上下文预算等；`AGENT_STORAGE_DIR`、`AGENT_WORKSPACE_ROOT`、`AGENT_JEV_URL`、`AGENT_AUTO_APPROVE_MEDIUM` 环境变量可覆盖默认值。

## 已知边界

`ModelProvider` 目前只有 `FakeProvider`。接真实模型需要实现 `ModelProvider.chat(request, signal)` 并通过构造函数传入。
