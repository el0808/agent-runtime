# Decisions

## 2026-10-27 — Phase 0

- 工作目录确定为 `/Users/el0808/Desktop/agent`；原先的 `Documents/ChatGPT/agent` 是空 Git 仓库，不作为项目目录。
- 采用 Node ESM、TypeScript strict、pnpm workspace、Vitest 和 ESLint flat config。
- `packages/protocol` 作为最低层共享契约包，先只放错误码和结构化日志；后续包通过它共享稳定类型。
- Phase 0 不实现 Runner、数据库、模型调用、同步或桌宠逻辑。
- `progress.md` 和 `decisions.md` 原本缺失，初始化时创建并持续更新。
- pnpm 11 默认阻止依赖构建脚本；Vitest 依赖的 `esbuild` 需要构建，因此在 `pnpm-workspace.yaml` 仅允许 `esbuild`，不开放全部依赖脚本。
- CI 使用 Node 24 和固定 pnpm 11.25.0，执行与本地相同的五项验证命令。
- README 以中文写明项目边界、当前 Phase、目录、启动命令、文档入口和路线图，避免把未实现的后续能力误认为已完成。

## 2026-10-27 — Phase 1

- 使用 Node.js 24 内置 `node:sqlite` 的 `DatabaseSync`，避免在本地和 CI 引入原生 SQLite 编译依赖；运行要求固定为 Node 24+。
- 事件表是任务状态的事实来源；`tasks.state_json` 是事务内同步更新的最新快照，用于快速读取，回放始终读取事件流。
- `eventId` 是全局幂等键。相同事件重复提交返回原事件；同一 ID 对应不同任务、类型或 payload 时拒绝并抛出 `IDEMPOTENCY_CONFLICT`。
- 每次账本变更使用 `BEGIN IMMEDIATE`，状态校验、事件写入、检查点写入和任务快照更新一起提交；非法转换会完整回滚。
- 检查点保存事件序号和任务状态快照；恢复通过追加 `checkpoint.restored` 事件完成，因此恢复动作可回放、可审计。
- `completed` 和 `cancelled` 是终止状态；失败任务可通过 `task.resumed` 或检查点恢复重新进入 `running`。

## 2026-10-27 — Phase 2

- Provider 采用 `ModelProvider.chat(request, signal)` 的异步流接口，统一产生 `delta`、`tool_call` 和 `completed` 事件；真实厂商适配器留在接口之外，当前用 `FakeProvider` 做离线验证。
- 模型、工具和 session 过程全部写入 `RuntimeEvent`，TaskLedger 快照只保留可回放的工具调用状态；消息历史保存在单次 Runner 会话内，避免任务间串状态。
- `ToolRegistry` 以名称注册定义和输入校验，执行结果统一分为 succeeded、failed、timed_out、cancelled；工具收到独立 AbortSignal，超时或取消不会把异常传播到进程级。
- 内置工具限定为工作区内 UTF-8 文件读写和固定的 `pnpm test`，路径越界直接拒绝，避免 Phase 2 引入任意 shell 执行权限。
- ReAct Runner 使用工具调用后追加 tool message，再请求下一轮模型；达到最大轮数会记录失败事件。暂停和取消由 Runner 控制器触发，恢复通过追加 `task.resumed` 后重新运行。
