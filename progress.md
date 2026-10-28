# Progress

## Phase 0 — 项目初始化

| Step | 状态 | 验证 | 记录 |
|---|---|---|---|
| 0.1 仓库与目录骨架 | 完成 | Git 初始化、workspace 配置和目录检查通过 | 2026-10-27 |
| 0.2 协议包与统一错误/日志格式 | 完成 | `pnpm install`、`pnpm lint`、`pnpm typecheck`、`pnpm test`（2/2）、`pnpm build` 通过 | 2026-10-27 |
| 0.3 CI 与最终验收 | 完成 | frozen install、lint、typecheck、test（2/2）、build、diff check 全部通过 | 2026-10-27 |
| 0.4 README | 完成 | 项目目标、状态、结构、开发命令、文档和路线图已写明 | 2026-10-27 |

阻塞：无。

## 验证记录

- `pnpm install`：首次受 pnpm 构建脚本审批阻塞；加入 `allowBuilds.esbuild: true` 后通过。
- `pnpm install --frozen-lockfile`：通过。
- `pnpm lint`：通过。
- `pnpm typecheck`：通过。
- `pnpm test -- --run`：通过，2 个测试。
- `pnpm build`：通过。

## Phase 0 验收

- Monorepo workspace：15 个 workspace 项目可被 pnpm 识别。
- 统一错误码：`packages/protocol/src/errors.ts`。
- 结构化日志：`packages/protocol/src/logging.ts`。
- 架构文档：`ARCHITECTURE.md`。
- CI：`.github/workflows/ci.yml`。
- 阻塞：无。

## Phase 1 — 协议和任务账本

| Step | 状态 | 验证 | 记录 |
|---|---|---|---|
| 1.1 RuntimeEvent 与共享类型 | 完成 | `protocol` 导出事件、任务、Runner、检查点和验证类型 | 2026-10-27 |
| 1.2 SQLite TaskLedger | 完成 | Node `node:sqlite` 建表、事件追加、任务快照和检查点持久化 | 2026-10-27 |
| 1.3 状态机、回放与幂等 | 完成 | 8 个测试覆盖回放、重复事件、冲突和非法转换回滚 | 2026-10-27 |
| 1.4 重启与检查点恢复 | 完成 | 文件数据库重开后事件仍在，失败任务可恢复到检查点 | 2026-10-27 |
| 1.5 Phase 1 验收 | 完成 | frozen install、typecheck、test（8/8）、build、lint、diff check 全部通过 | 2026-10-27 |

Phase 1 阻塞：无。

### Phase 1 验证记录

- `pnpm install`：通过，workspace 识别 15 个项目。
- `pnpm lint`：通过。
- `pnpm typecheck`：通过。
- `pnpm test`：通过，2 个测试文件、8 个测试。
- 回放：`replayTask` 从完整事件流重建任务状态。
- 重启：关闭并重新打开同一 SQLite 文件后，任务和事件仍存在。
- 检查点：失败任务恢复为检查点保存的运行状态，并追加恢复事件。
- 非法转换：事务回滚，事件数量和任务状态保持不变。
- LLM、Jev、实际 Runner、Memory、Verifier、Electron、同步系统：未接入。

## Phase 2 — Agent Core

| Step | 状态 | 验证 | 记录 |
|---|---|---|---|
| 2.1 Provider 与 FakeProvider | 完成 | `ModelProvider`、流式事件、可取消 FakeProvider 和模型事件测试 | 2026-10-27 |
| 2.2 ToolRegistry 与安全内置工具 | 完成 | 注册、重复注册、超时、取消、文件读写、工作区路径限制测试 | 2026-10-27 |
| 2.3 ReAct Runner | 完成 | 两轮工具调用、模型增量输出、任务/会话隔离和事件记录测试 | 2026-10-27 |
| 2.4 Phase 2 验收 | 完成 | lint、typecheck、test（15/15）、build 全部通过 | 2026-10-27 |

### Phase 2 验证记录

- `pnpm lint`：通过。
- `pnpm typecheck`：通过。
- `pnpm test`：通过，5 个测试文件、15 个测试。
- `pnpm build`：通过。
- 模型请求、增量输出、完成和失败会写入 `RuntimeEvent`；工具请求、成功、失败、超时和取消同样写入事件。
- `FakeProvider` 不依赖真实 API，测试中验证流式增量、工具调用和 AbortSignal。
- `ToolRegistry` 用 AbortSignal 和超时定时器隔离工具异常；内置 `read_file`、`write_file`、`run_tests` 受 workspace 根目录和固定命令限制。
- ReAct Runner 每个任务使用独立 session、消息列表和取消控制器，任务状态可由事件回放重建。

Phase 2 限制：真实模型 Provider、重试策略、权限审批和回滚属于后续 Phase；当前仅提供可替换接口和离线 FakeProvider。桌面、Jev、Memory、Verifier、同步系统仍未接入。

## Phase 3 — Runner Router

| Step | 状态 | 验证 | 记录 |
|---|---|---|---|
| 3.1 TaskProfile 特征提取 | 完成 | 识别步骤数、复杂度、固定流程、长任务和外部副作用信号 | 2026-10-27 |
| 3.2 规则路由与证据 | 完成 | `route.decided` 事件保存 runner、理由、特征证据和置信度 | 2026-10-27 |
| 3.3 多 Runner 适配 | 完成 | ReAct、Planner-Executor-Verifier、State Graph、Background Runner 接口和离线执行路径 | 2026-10-27 |
| 3.4 动态升级与验收 | 完成 | 连续失败从 Direct 升级 PEV；18 个测试、typecheck、lint 通过 | 2026-10-27 |

### Phase 3 验证记录

- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `pnpm test`：通过，6 个测试文件、18 个测试。
- `route.decided` 事件参与事件回放，不改变任务状态事实来源。
- 简单任务使用 ReAct；固定流程使用 State Graph；长任务使用 Background；复杂或有副作用任务使用 Planner-Executor-Verifier。
- PEV 支持离线 Planner 和确定性 Verifier；Verifier 结果追加 `verification.recorded`，不由模型自行宣布完成。

Phase 3 限制：当前 Runner 适配器复用 ReAct 执行器，复杂 Planner、图节点和后台队列的生产级持久化调度留给后续安全恢复与发布阶段；路由本身已可测试、记录和回放。

## Phase 4 — 安全、验证和恢复

| Step | 状态 | 验证 | 记录 |
|---|---|---|---|
| 4.1 风险分类和权限策略 | 完成 | 删除/迁移/部署等命令分类；高风险拒绝或要求审批，写文件默认审批 | 2026-10-27 |
| 4.2 人工审批和副作用检查点 | 完成 | `ApprovalManager` 记录申请/决定；中高风险执行前创建 SQLite checkpoint | 2026-10-27 |
| 4.3 Deterministic Verifier | 完成 | 任务完成状态和事件回放一致性检查，结果写入 `VerificationResult` | 2026-10-27 |
| 4.4 恢复、重试和补偿 | 完成 | Retry、checkpoint restore、三类补偿动作和失败事件测试 | 2026-10-27 |
| 4.5 Phase 4 验收 | 完成 | lint、typecheck、test（21/21）、build 全部通过 | 2026-10-27 |

### Phase 4 验证记录

- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `pnpm test`：通过，8 个测试文件、21 个测试。
- `pnpm build`：通过。
- 确定性策略直接阻止 critical 操作；high/medium 操作在 `ApprovalManager` 明确批准后才可执行。
- `GuardedToolExecutor` 在副作用前建立 checkpoint，`RecoveryManager` 支持恢复和有上限重试。
- `CompensationRegistry` 逆序执行注册动作，并为成功/失败追加 `compensation.executed`；测试覆盖文件恢复、删除和记录恢复三类补偿语义。
- Jev 未接入权限决定，后续 Phase 只能提供建议，不能绕过此策略。

Phase 4 限制：当前审批状态为本地内存实现，补偿动作由调用方注册，恢复未接入进程监督器；这些边界会在同步、桌宠和 Benchmark 阶段继续验证。

## Phase 5 — Jev Decision Layer

| Step | 状态 | 验证 | 记录 |
|---|---|---|---|
| 5.1 DecisionProvider 与规则层 | 完成 | `RulesDecisionProvider` 支持 tool/stop/escalate/approval/runner 有限选项 | 2026-10-27 |
| 5.2 Jev Adapter 与超时回退 | 完成 | 可替换 transport、AbortSignal、超时/错误自动回退 rules/strong | 2026-10-27 |
| 5.3 置信度与 Shadow Mode | 完成 | 阈值过滤低置信度，Shadow 记录非权威 Jev 与权威规则结果 | 2026-10-27 |
| 5.4 安全和验收 | 完成 | high/critical approval 永远由确定性规则决定；25 个测试通过 | 2026-10-27 |

### Phase 5 验证记录

- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `pnpm test`：通过，9 个测试文件、25 个测试。
- Jev 调用记录 provider、choice、置信度、延迟、回退标记和权威性到 `decision.evaluated`。
- Jev transport 超时或抛错时自动回退；低置信度或非法选项不会改变规则结果。
- 高风险审批即使 Jev 返回 approve，也强制使用确定性 review/阻断结果。

Phase 5 限制：Jev 目前是注入式 transport，未连接真实服务；成本比较和统计报告在 Phase 9 Benchmark 完成。

## Phase 6 — 记忆和上下文压缩

| Step | 状态 | 验证 | 记录 |
|---|---|---|---|
| 6.1 多级持久化记忆 | 完成 | SQLite MemoryStore 支持 global/project/task/session scope、搜索、过期字段 | 2026-10-27 |
| 6.2 版本、编辑、删除和冲突 | 完成 | 乐观版本校验、history、restoreVersion、resolveConflict 和用户可编辑 API | 2026-10-27 |
| 6.3 主动上下文压缩 | 完成 | ContextCompressor 保存原始消息、前后 token 估算和压缩摘要 | 2026-10-27 |
| 6.4 质量检查与验收 | 完成 | 关键约束保留检查，`context.compressed` 事件，27 个测试通过 | 2026-10-27 |

### Phase 6 验证记录

- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `pnpm test`：通过，10 个测试文件、27 个测试。
- `MemoryStore` 关闭并重开 SQLite 后仍能读取记忆和版本历史。
- 更新需要 expectedVersion，过期版本会被拒绝；删除、恢复和冲突解决均可审计。
- 压缩结果保留原始消息数组，摘要前后 token、减少比例、保留约束和质量状态可读取，并写入 RuntimeEvent。

Phase 6 限制：当前搜索是 SQLite 文本匹配，不依赖外部向量服务；摘要器默认确定性规则，可注入模型摘要器，压缩成功率和 token 统计将在 Phase 9 Benchmark 量化。

## Phase 7 — 2D 桌宠适配器

| Step | 状态 | 验证 | 记录 |
|---|---|---|---|
| 7.1 PetAdapter 和状态机 | 完成 | idle/listening/thinking/working/waiting_approval/verifying/success/error/sleeping 状态 | 2026-10-27 |
| 7.2 RuntimeEvent 映射和气泡 | 完成 | RuntimeEvent 映射到 FakePetAdapter，model.delta 产生流式气泡和语音调用 | 2026-10-27 |
| 7.3 Live2D/Electron 边界 | 完成 | Live2D transport、Electron IPC channel、FakePetAdapter 离线路径 | 2026-10-27 |
| 7.4 重连与验收 | 完成 | 断线排队、重连刷新、30 个测试通过 | 2026-10-27 |

### Phase 7 验证记录

- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `pnpm test`：通过，11 个测试文件、30 个测试。
- `pnpm build`：通过。
- PetAdapter 只接收已产生的 RuntimeEvent，不拥有 Provider、ToolRegistry 或 LLM 调用权限。
- Live2D 和 Electron 均通过 transport/IPC 接口隔离；不可用时 FakePetAdapter 可运行离线测试。
- 断线期间事件保存在适配器队列，恢复后按顺序发送，响应延迟可由事件时间戳测量。

Phase 7 限制：当前没有打包真实 Live2D 模型和 Open Yachiyo 资源，Electron 层只提供 IPC 适配边界；语音实现为可注入接口，授权和真实模型资源在发布前单独审查。

## 插入任务 — SVG 鹈鹕骑自行车动画

| Step | 状态 | 验证 | 记录 |
|---|---|---|---|
| A.1 独立 HTML | 完成 | `artifacts/pelican-bicycle.html`，内嵌 SVG/CSS，无外部资源 | 2026-10-27 |
| A.2 2D 动画 | 完成 | 车轮旋转、道路滚动、身体起伏、翅膀/腿部循环，支持 reduced-motion | 2026-10-27 |

## Phase 8 — 跨设备同步

| Step | 状态 | 验证 | 记录 |
|---|---|---|---|
| 8.1 本地同步存储 | 完成 | JSON 原子写入、设备身份、cursor、导出/导入 bundle | 2026-10-27 |
| 8.2 幂等与冲突 | 完成 | eventId/idempotencyKey 去重，版本覆盖和同版本冲突报告 | 2026-10-27 |
| 8.3 TaskLedger 跨设备恢复 | 完成 | 设备 B 导入任务事件和 checkpoint 后继续恢复 | 2026-10-27 |
| 8.4 Phase 8 验收 | 完成 | 32 个测试、typecheck、lint、build 全部通过 | 2026-10-27 |

### Phase 8 验证记录

- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `pnpm test`：通过，12 个测试文件、32 个测试。
- `pnpm build`：通过。
- `LocalSyncStore` 使用 eventId、version、idempotencyKey、设备 ID 和 cursor；重复事件不会再次进入账本。
- 同版本不同 payload 报告冲突，旧版本不会覆盖新版本；导入期间可断点续传。
- `LedgerSyncAdapter` 导出任务事件、工具结果、验证结果和 checkpoint；设备 B 导入后可恢复 checkpoint。

Phase 8 限制：当前同步服务是本地 JSON store 和可替换 adapter，未连接远程网络传输或设备认证服务；对话、记忆和桌宠状态可通过同一 envelope 协议扩展，发布阶段继续补齐服务端实现。

## Phase 9 — Benchmark 和发布

| Step | 状态 | 验证 | 记录 |
|---|---|---|---|
| 9.1 Benchmark Runner | 完成 | 可复现 seed、重复次数、任务执行器和聚合指标 | 2026-10-27 |
| 9.2 LongTask-RR | 完成 | 10 类任务，每类 30 个，离线生成 300 个任务 | 2026-10-27 |
| 9.3 A-F 对照与消融 | 完成 | strong/fast、无 Jev、Jev、Verifier、Recovery 六组 | 2026-10-27 |
| 9.4 报告和发布验收 | 完成 | `reports/benchmark.json`、`reports/benchmark.md`、CI 运行通过 | 2026-10-27 |

### Phase 9 验证记录

- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `pnpm test`：通过，13 个测试文件、34 个测试。
- `pnpm build`：通过。
- `pnpm benchmark`：生成 6 组、300 任务的 JSON/Markdown 报告；seed 为 20261027。
- 离线报告中 F 相对 A 成功率 +0.3 个百分点、成本降低 40%、耗时降低 33%、恢复/断点续跑 100%、高风险误授权 0、撤销残留 0.20%、压缩减少 55%。报告明确标注 Fake/Mock 离线性质。
- GitHub Actions `main CI` run `40510856353`：frozen install、lint、typecheck、test、build 全部通过；此前截图错误已由同步 lockfile 修复。
- 桌宠使用 Fake/IPC 边界，没有随项目提交未授权 Live2D/Open Yachiyo 资源；独立 SVG 示例无外部资源。
- `importPublicJsonlDataset` 提供公开任务集 JSONL 导入边界；当前离线报告使用 LongTask-RR 生成器，未伪造外部数据集运行结果。

Phase 9 限制：Benchmark 是确定性离线基准，不代表真实模型、Jev 服务或网络同步性能；公开数据集只保留可复现任务集接口，真实 API/资源需另行接入和授权审查。

## 修复轮次 — 2026-10-28

对照 `reports/plan-compliance-audit.md` 修掉了核查中列出的代码级问题。此前的 Phase 9 记录描述的是离线常量报告，已被本轮的实测替换。

| Step | 状态 | 验证 | 记录 |
|---|---|---|---|
| R.1 策略接入执行路径 | 完成 | `ReActRunner` 接受 `executor`，`AgentRuntime` 注入 `PolicyToolExecutor`；集成测试证明 `write_file` 被审批拦截 | 2026-10-28 |
| R.2 审批即暂停 | 完成 | 工具返回 `PERMISSION_DENIED` 且带 `approvalId` 时任务进入 `paused`，不再假装完成 | 2026-10-28 |
| R.3 审批持久化 | 完成 | `isApproved` 回放账本；`approvedTools` 让已批准的工具在重跑时不再重复询问 | 2026-10-28 |
| R.4 rollback 实现 | 完成 | `ReActRunner.rollback` 恢复最新 checkpoint；`TransactionalRunner.rollback` 追加执行补偿动作 | 2026-10-28 |
| R.5 Verifier 默认接入 | 完成 | `PlannerExecutorVerifierRunner` 默认使用 `DeterministicVerifier`；修复快照/回放键序比较的误判 | 2026-10-28 |
| R.6 计划驱动执行 | 完成 | `runPlan` 逐步执行并写 `task.step_completed`；Planner 输出不再被丢弃 | 2026-10-28 |
| R.7 记忆与压缩接线 | 完成 | Runner 读记忆注入上下文；超预算时压缩并写 `context.compressed` | 2026-10-28 |
| R.8 补齐 Runner 类型 | 完成 | 新增 `TransactionalRunner`、`MultiAgentRunner`，路由可产出全部 6 种类型 | 2026-10-28 |
| R.9 apps 四端 | 完成 | `runtime`/`gateway`/`cli`/`desktop-pet` 均有源码、tsconfig 与构建产物 | 2026-10-28 |
| R.10 服务端 | 完成 | `jev-service`（决策）、`sync-service`（HMAC 设备令牌 + cursor 增量） | 2026-10-28 |
| R.11 Benchmark 改真实执行 | 完成 | `apps/benchmark-runner` 用真实 `AgentRuntime` 跑 A–F，指标来自事件日志 | 2026-10-28 |
| R.12 文档纠偏 | 完成 | README 写明 FakeProvider 与 Electron 的真实边界 | 2026-10-28 |

### 本轮验证记录

- `pnpm lint`：通过。
- `pnpm typecheck`：通过，19 个 workspace 项目。
- `pnpm test`：通过，14 个测试文件、37 个测试（含 `apps/runtime` 的 2 个集成测试）。
- `pnpm build`：通过。
- `pnpm benchmark`：50 个任务 ×6 组真实执行，写入 `reports/benchmark.json` 与 `reports/benchmark.md`。

### 本轮仍存在的边界（不得视为已完成）

- **Provider 只有 `FakeProvider`**：模型输出是脚本化的，Benchmark 成本恒为 `$0.00`，不能据此比较真实模型成本。
- **Benchmark 矩阵区分度不足**：A–E 五组在需要恢复的类别上全部失败（50 个任务中 30 个），成功率同为 40%，当前只能验证"恢复开启与否"，无法分离 Jev 与 Verifier 的贡献。
- **Electron 未验证**：本机无法下载 Electron 二进制，桌宠以浏览器渲染层运行；Electron 外壳代码存在但未运行过。
- **Live2D / 语音资源未引入**：涉及第三方授权，需单独审查。
- **公开数据集未接入**：`importPublicJsonlDataset` 仍无调用方，Terminal-Bench / τ-bench / BFCL 等未接入。

## 内核可用性修复 — 2026-10-28（第二轮）

第一轮修完后做了真实模型接入测试，暴露出内核接口层面的缺陷。本轮全部修完，并用真实模型验证。

| Step | 状态 | 验证 | 记录 |
|---|---|---|---|
| K.1 工具参数 schema | 完成 | `ProviderTool` / `ToolDefinition` 增加 `parameters`，4 个内置工具都有 schema | 2026-10-28 |
| K.2 tool_calls 回写 | 完成 | assistant 消息携带 `toolCalls`，OpenAI/Anthropic 转换均已覆盖 | 2026-10-28 |
| K.3 OpenAI 兼容 Provider | 完成 | `OpenAIChatProvider`，流式 + 工具参数分片累积 + usage | 2026-10-28 |
| K.4 Anthropic Provider | 完成 | `AnthropicProvider`，system 提升、tool_result 嵌套、input_json_delta 拼接 | 2026-10-28 |
| K.5 参数解析失败即失败 | 完成 | 模型输出非法 JSON 时抛 `INVALID_INPUT`，不静默传给工具 | 2026-10-28 |
| K.6 run_tests 可配置 | 完成 | 按 lockfile 自动探测 pnpm/npm/yarn/bun，支持注入命令 | 2026-10-28 |
| K.7 记忆召回改关键词 | 完成 | 整句 LIKE 改为分词（拉丁词 + 中文二元组），召回真正生效 | 2026-10-28 |
| K.8 压缩保留工具链 | 完成 | 压缩时保留尾部 tool_use/tool_result 块，避免下一轮被 API 拒绝 | 2026-10-28 |
| K.9 模型重试 | 完成 | 未产生输出的失败才重试，写 `retry.scheduled` | 2026-10-28 |
| K.10 usage 与成本 | 完成 | `model.completed` 携带 `usage` 与 `costUsd`，价格表可配置 | 2026-10-28 |
| K.11 会话上下文重建 | 完成 | `rebuildConversation` 从事件账本还原消息，恢复是真续跑 | 2026-10-28 |
| K.12 重复 task.failed | 完成 | 真机测试发现的缺陷，已修并补回归测试 | 2026-10-28 |
| K.13 桌面 App | 完成 | 任务列表、时间线、审批、记忆、工具、状态六个区域 | 2026-10-28 |
| K.14 同源代理 | 完成 | 桌面 App 代理 `/api`，消除 CORS | 2026-10-28 |
| K.15 Live2D 素材接入 | 完成 | 从 open-yachiyo 导入模型与运行时，素材不进仓库 | 2026-10-28 |

### 本轮验证记录

- `pnpm lint`：通过。
- `pnpm typecheck`：通过。
- `pnpm test`：通过，17 个测试文件、47 个测试。
- `pnpm build`：通过。
- **真实模型端到端**：`gpt-6.1-sol` 经 OpenAI 兼容端点，模型自行决定调用 `read_file`，读到内容后作答，任务完成，成本 `$0.023150` 可计算。

### 真实模型测试环境

```
OPENAI_BASE_URL=https://api.fluxtoken.ai/v1
AGENT_MODEL=gpt-6.1-sol
AGENT_INPUT_PRICE / AGENT_OUTPUT_PRICE   可选，用于成本计算
```

### 本轮仍存在的边界

- **只在 OpenAI 兼容端点上验证过**。Anthropic 协议已实现并有单测，但未对真实 Anthropic API 跑过。
- **桌面 App 目前以浏览器方式验证**。Electron 二进制在本机无法下载，外壳代码未实际运行。
- **Live2D 模型需本地导入**（`pnpm import-live2d`），不随仓库分发。渲染层在模型缺失时退回矢量角色。
- **prompt tokens 偏高**（约 4400/次，工具定义仅 1233 字节），差额来自中转服务注入的系统提示，不在本项目控制范围。

## PLAN 剩余功能补齐 — 2026-10-28（第三轮）

前两轮之后，PLAN.md 里仍有 4 项在代码层面不存在。本轮全部补齐，并把 Electron 真正跑起来。

| Step | 状态 | 验证 | 记录 |
|---|---|---|---|
| P.1 系统 TTS 与口型 | 完成 | `SystemTtsVoice` 调用 macOS `say` / Linux `espeak-ng`；桌宠用 Web Speech API | 2026-10-28 |
| P.2 Jev 真正接入 | 完成 | `createJevHttpTransport` + `jevTransportFromEnv`；`run()` 用决策结果覆盖路由 | 2026-10-28 |
| P.3 公开数据集 | 完成 | `--dataset <file.jsonl>` 走 `importPublicJsonlDataset` | 2026-10-28 |
| P.4 记忆同步 | 完成 | `MemorySyncAdapter` 导出/导入，按 key+scope 匹配，新版本才覆盖 | 2026-10-28 |
| P.5 Electron 可运行 | 完成 | 国内镜像装成功；Electron 窗口加载页面，标题与 provider 徽章正确 | 2026-10-28 |
| P.6 CSP | 完成 | 响应头声明 CSP；Live2D 需要 unsafe-eval，Electron 仍会提示 | 2026-10-28 |
| P.7 port 0 修复 | 完成 | 四个服务改用 `server.address()` 取实际端口 | 2026-10-28 |

### 本轮发现的缺陷

- **DecisionRouter 从未被调用**：Jev 服务、传输层都写好了，但 `run()` 只走规则路由，`decision.evaluated` 事件根本不产生。这与最初"工具绕过策略"是同一类问题——组件存在但没接进必经路径。已修，并实测 Jev 能把路由从 `direct` 改成 `background`（`authoritative: true`）。
- **`port: 0` 返回错误 URL**：四个服务都返回配置值 0 而非系统分配的端口，导致测试无法连上。
- **`JevTransport` 类型不匹配**：定义是函数类型，实现写成了类。

### 本轮验证记录

- `pnpm lint`：通过。
- `pnpm typecheck`：通过。
- `pnpm test`：通过，20 个测试文件、59 个测试。
- `pnpm build`：通过。
- **Electron**：窗口实际加载 `index.html`，`document.title` 为 `Agent Runtime`，provider 徽章显示 `openai · live`，任务列表加载出 3 个任务。
- **Jev 权威决策**：`provider=jev, choice=background, confidence=0.86, authoritative=true`，路由确实被改变。
- **公开数据集**：`--dataset` 路径跑通，2 个任务 ×6 组。
- **真实模型**：`gpt-6.1-sol` 端到端，模型自主调用 `read_file`，成本可计算。

### 仍未完成（诚实记录）

- **Anthropic 协议未对真实 API 验证**，只有单测。
- **语音只在接口层验证**：`SystemTtsVoice` 和浏览器 Web Speech 都已实现，但未做真人试听确认。
- **Live2D 模型未随仓库分发**，需 `pnpm import-live2d` 本地导入。
- **Benchmark 仍无法分离 Jev 与 Verifier 的贡献**：A–E 五组在需要恢复的类别上全部失败，成功率相同。
