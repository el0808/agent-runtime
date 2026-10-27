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

## 2026-10-27 — Phase 6

- 记忆使用独立 SQLite 数据库，记录 scope、scopeId、来源、时间、置信度、版本、过期时间和冲突状态；每次修改写入 memory_versions，原版本永不覆盖。
- 编辑采用 expectedVersion 乐观并发控制，版本过期直接返回冲突；用户可以搜索、更新、删除、恢复历史版本和标记冲突已解决。
- ContextCompressor 默认使用确定性摘要，保留约束句和最近上下文；原始消息完整保留，压缩结果记录 token 估算、减少比例和质量检查。
- 记忆修改和压缩仅在提供 taskId/ledger 时写入 RuntimeEvent，避免全局记忆强行绑定到不存在的任务，同时保证任务范围动作可回放。

## 2026-10-27 — Phase 7

- 桌宠只实现 `PetAdapter` 展示协议，RuntimeEvent 经过 mapper 映射成有限状态；桌宠进程不能访问 Provider、ToolRegistry 或审批 API。
- FakePetAdapter 是默认离线测试实现；Live2DPetAdapter 只依赖可替换 transport，ElectronPetAdapter 通过固定 IPC channel 发送事件，便于接入 Open Yachiyo 而不把它变成核心依赖。
- 流式模型增量直接转成 textDelta，语音和口型同步通过 VoiceAdapter 注入；适配器只转发，不推断任务完成。
- 断线时事件按顺序进入内存队列，连接恢复后 flush；重连失败会按退避间隔继续尝试，任务状态仍由 SQLite 账本独立保存。

## 2026-10-27 — 插入任务：SVG 动画

- 单独 HTML 放在 `artifacts/pelican-bicycle.html`，只用内嵌 SVG 和 CSS keyframes，不引入运行时依赖；该文件与 Agent Runtime 解耦，便于直接在浏览器打开。

## 2026-10-27 — Phase 8

- 同步先采用本地 JSON envelope，字段固定包含 eventId、version、idempotencyKey、deviceId、entityType、entityId、occurredAt、payload 和 cursor；远程服务可实现同一接口。
- 导入先写入 LocalSyncStore 再按 RuntimeEvent sequence 追加 TaskLedger，`task.created` 只在目标设备没有任务时创建，避免重复执行。
- 同版本不同 payload 产生显式冲突，较旧版本丢弃；checkpoint 和工具/验证事件作为独立 entity 传输，设备 B 可在导入后恢复。
- GitHub CI 的 frozen lockfile 失败来自 workspace package 新增依赖未同步锁文件；每次新增包依赖后先运行 `pnpm install --lockfile-only` 并提交 lockfile。

## 2026-10-27 — Phase 9

- Benchmark Runner 采用纯 TypeScript、固定 seed 和可注入 scenario，不把真实 API、Jev 或 Live2D 可用性伪装成测试结果；离线报告明确写明 Fake/Mock 性质。
- LongTask-RR 按 10 类故障/恢复主题程序化生成，每类默认 30 个任务，避免手写样本无法复现；A-F 配置共享同一任务集和指标。
- 报告同时输出 JSON 和 Markdown，指标覆盖成功率、成本、token、延迟、恢复、断点续跑、误授权、撤销残留和压缩减少量；消融组通过配置差异比较 Jev、Verifier 和 Recovery 的作用。
- 发布前检查包含 lockfile frozen install、全量测试、桌宠资源边界和独立 SVG 示例；CI 中 Node 20 action deprecation/Ubuntu 迁移仅为 warning，不影响验证结果。

## 2026-10-28 — 修复轮次

- `ReActRunner` 增加可注入的 `executor`，默认仍是 `tools`。库层保持不强制策略，由 `apps/runtime` 注入 `PolicyToolExecutor`，避免 `@agent/runner` 反向依赖 `@agent/policy`。
- 审批拦截后任务进入 `paused` 而不是继续跑完。此前"工具被拒但任务 completed"会让审批形同虚设；现在必须人工批准后重跑才能继续。
- 审批状态从事件账本派生（`isApproved` 回放 `approval.resolved`，`approvedTools` 汇总已批准工具），不再只存内存 `Map`，进程重启后仍有效。
- `rollback` 恢复最新 checkpoint；补偿动作由 `TransactionalRunner` 在恢复后追加执行。补偿与 checkpoint 的绑定发生在 runner 层，`CompensationRegistry` 保持只管执行。
- `PlannerExecutorVerifierRunner` 默认构造 `DeterministicVerifier`，verifier 不再默认缺席；同时把快照/回放比较改为键序无关的 canonical JSON，修复了误判为 `failed` 的缺陷。
- 计划通过 `runPlan` 真正驱动执行，每步写 `task.step_completed`，`completedSteps` 因此有内容可查。
- 记忆与压缩在 Runner 内部触发：启动时按 goal 召回（上限 5 条），token 超预算时压缩并写 `context.compressed`。压缩器通过结构化接口注入，`@agent/runner` 不依赖 `@agent/memory`。
- Benchmark 改为真实执行：`@agent/benchmark` 只定义配置矩阵与 `BenchmarkRuntime` 接口，`apps/benchmark-runner` 注入真实 `AgentRuntime`。这样包不反向依赖 app，且指标来自事件日志。
- 失败恢复指标与断点续跑指标分开计算，此前两者共用同一个布尔值，等于重复计数。
- A–F 的差异用"是否注入崩溃 + 是否恢复"表达。A–E 全部不恢复，因此在需要恢复的类别上必然失败；这是刻意的对照设计，但导致五组成功率相同，区分度不足的问题已记入 progress.md。
- `benchmarks/` 下的 JSON 配置文件删除：没有任何代码读取它们，保留只会误导。
