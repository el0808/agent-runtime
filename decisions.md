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

## 2026-10-27 — Phase 3

- 任务特征提取只使用 `TaskProfile.goal` 和显式 metadata，输出步骤数、复杂度、固定流程、长任务和外部副作用信号，确保规则路由可重放且不依赖模型。
- 路由决策追加 `route.decided` RuntimeEvent，保存选中的 Runner、理由、证据、置信度和升级来源；Runner 选择不会成为内存中的不可审计分支。
- Phase 3 的 Planner、State Graph 和 Background Runner 先采用统一 Runner 接口和 ReAct 委托实现，Planner 可注入离线计划器，PEV 可注入确定性 Verifier；生产调度、审批和恢复在后续 Phase 扩展。
- 连续失败达到两次时，规则路由将 Direct 升级为 Planner-Executor-Verifier；高复杂度和副作用任务默认进入 PEV，固定流程进入 State Graph，长任务进入 Background。

## 2026-10-27 — Phase 4

- 风险分类采用确定性关键词和工具默认等级：读文件/测试为 low，写文件为 medium，部署/迁移/发送为 high，删除/数据库破坏命令为 critical。critical 直接拒绝，high 和默认 medium 必须人工审批。
- 审批申请和决定都是 RuntimeEvent；即使 Jev 或模型建议 approve，也必须通过 `ToolPermissionPolicy` 和 `ApprovalManager` 的确定性检查。
- 外部副作用前由 `GuardedToolExecutor` 创建 checkpoint，失败恢复通过追加 `recovery.started` 后调用 TaskLedger 的 checkpoint restore，避免覆盖事件历史。
- Verifier 只读取账本和工具证据，输出结构化 `VerificationResult`；完成状态与事件回放一致性是默认检查。
- 补偿采用注册式动作并按逆序执行，当前提供通用的文件恢复、删除恢复和记录恢复接口语义；每个结果写入 `compensation.executed`。

## 2026-10-27 — Phase 5

- DecisionProvider 只返回有限选项、置信度和理由；Rules provider 是安全基线，Jev adapter 只负责可替换的快速建议。
- Jev 使用 AbortSignal、超时和置信度阈值；transport 错误、超时、低置信度或非法选项都回退到强模型 provider，默认强模型为规则 provider。
- Shadow Mode 先保留规则结果为权威，再记录 Jev 非权威结果，便于比较而不改变事件顺序和任务状态。
- approval 且风险为 high/critical 时跳过 Jev 授权，始终采用确定性规则；这条约束位于 DecisionRouter 内，不依赖 prompt。
