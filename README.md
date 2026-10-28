# Agent Runtime

本项目是一个本地优先、可验证、可恢复的 Agent Runtime + Harness，目标是让长任务具备明确的状态、权限、检查点、验证和恢复能力，并为 Electron + Live2D 桌宠提供稳定的展示层接口。

Phase 0–9 的代码已全部落地并通过 `lint`、`typecheck`、59 个测试和 `build`。系统装配为可运行的多个入口：`apps/app`（macOS 桌面应用，主要入口）、`apps/runtime`（装配根）、`apps/gateway`（HTTP/SSE/JSON-RPC）、`apps/cli`（命令行客户端）、`apps/desktop-pet`（Canvas 桌宠），另有 `apps/jev-service`、`apps/sync-service`、`apps/benchmark-runner` 三个可选服务。

已接入的部分：

- **真实模型**：`OpenAIChatProvider` 与 `AnthropicProvider` 走流式协议，支持工具调用、图片输入、用量与成本统计。通过 `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` 与环境变量配置，密钥不入库。
- **Electron 桌面应用**可用，界面为浅色，工具调用、审批、上下文用量与记忆都在界面上可见。

仍有明确边界的部分：

- **`apps/jev-service` 不是真正的 Jev**。它是一个自建的打分服务，复用 Jev 的传输协议形状；Jev 本身闭源，本项目没有引入它。
- **Live2D 模型与语音资源未内置**，桌宠以 Canvas 渲染层运行，素材需单独授权。

## 目标

- 根据任务复杂度选择合适的 Runner。
- 保存任务状态、事件、检查点、工具结果和验证证据。
- 在进程崩溃、工具失败或网络异常后恢复任务。
- 对外部副作用执行权限检查、审批、验证和补偿。
- 让桌宠只负责展示 Runtime 状态，不直接拥有模型或工具权限。

## 当前状态

已完成 Phase 0：

- pnpm workspace，包含 4 个应用入口和 11 个领域包边界。
- TypeScript strict、Node ESM、ESLint、Vitest。
- `@agent/protocol` 共享包，包含稳定错误码和 JSON 结构化日志。
- 架构、进度和决策记录。
- GitHub Actions CI：安装、lint、类型检查、测试和构建。

已完成 Phase 1：

- `@agent/protocol` 定义 `RuntimeEvent`、`TaskProfile`、`RunnerType`、`Checkpoint`、`VerificationResult` 和 `Runner`。
- `@agent/task-ledger` 使用 Node.js 内置 `node:sqlite` 持久化任务、事件和检查点。
- 事件追加使用 `eventId` 幂等；状态变化在 `BEGIN IMMEDIATE` 事务内校验和写入。
- 任务状态可以从完整事件流回放；进程重启后可以继续读取任务、事件和检查点。
- 非法状态转换会被拒绝并回滚，不接入 LLM、Jev、实际 Runner、Memory、Verifier、Electron 或同步系统。

已完成 Phase 2：

- `@agent/runner` 提供可替换的 `ModelProvider`、`FakeProvider` 和最小 ReAct Runner。
- `@agent/tools` 提供 ToolRegistry、AbortSignal 超时/取消，以及受工作区限制的文件读写和固定测试工具。
- 模型增量、工具调用、失败、超时、取消和 session 生命周期均写入 RuntimeEvent；每个任务使用独立 session 和消息历史。

已完成 Phase 3：

- `@agent/routing` 根据任务目标和 metadata 提取复杂度、步骤、固定流程、长任务及副作用特征。
- 规则路由支持 ReAct、Planner-Executor-Verifier、State Graph 和 Background，并在连续失败时动态升级。
- 每次路由追加 `route.decided` 事件，记录理由、证据、置信度和升级来源；PEV 可接入确定性离线 Verifier。

已完成 Phase 4：

- `@agent/policy` 提供命令风险分类、工具权限、人工审批和副作用前 checkpoint。
- `@agent/verifier` 提供完成状态与事件回放一致性的确定性验证器。
- `RecoveryManager` 支持 checkpoint 恢复和有限重试，`CompensationRegistry` 支持逆序补偿并记录结果；高风险授权不依赖模型或 Jev。

已完成 Phase 5：

- `@agent/routing` 提供 `DecisionProvider`、规则决策、注入式 Jev Adapter、超时/错误回退、置信度阈值和 Shadow Mode。
- 每次决策追加 `decision.evaluated`，记录 provider、选择、置信度、延迟、回退和权威性。
- high/critical 审批始终由确定性规则处理，Jev 不能单独授权高风险动作。

已完成 Phase 6：

- `@agent/memory` 提供 SQLite 多级记忆、来源/置信度/版本/过期时间、搜索编辑删除、历史恢复和冲突处理。
- `ContextCompressor` 主动生成摘要并保留原始消息，验证关键约束，记录压缩前后 token 和 `context.compressed` 事件。

已完成 Phase 7：

- `@agent/pet-adapter` 定义九种桌宠状态和 RuntimeEvent 映射，支持流式气泡与可注入语音/口型接口。
- 提供 FakePetAdapter、Live2DPetAdapter 和 Electron IPC 适配器；断线事件排队并自动重连，桌宠不直接调用 LLM。

已完成 Phase 8：

- `@agent/sync` 提供设备身份、本地 JSON 导出/导入、cursor、version、idempotencyKey 和冲突检测。
- `LedgerSyncAdapter` 可同步任务事件、工具/验证结果和 checkpoint，并在另一份 TaskLedger 上幂等恢复。

附加示例：

- [pelican-bicycle.html](./artifacts/pelican-bicycle.html)：独立 SVG 鹈鹕骑自行车 2D 动画。

已完成 Phase 9：

- `@agent/benchmark` 定义 A–F 六组配置与 LongTask-RR 生成器；`apps/benchmark-runner` 用真实 `AgentRuntime` 执行它们，指标从事件日志算出，不是常量。
- `reports/benchmark.json` 与 `reports/benchmark.md` 保存成功率（含 Wilson 95% 置信区间）、token、延迟、恢复、断点续跑、误授权、撤销残留和压缩指标；运行 `pnpm benchmark` 可重新生成。
- 当前矩阵只能区分“是否启用恢复”：A–E 五组在需要恢复的类别上全部失败，因此成功率相同。Jev、Verifier 的差异需要更细的任务集才能体现，见 `reports/plan-compliance-audit.md`。
- Jev 决策服务与同步服务已作为独立进程实现（`apps/jev-service`、`apps/sync-service`），可直接运行；真实模型 API、Live2D 模型与语音资源仍是可替换边界，未接入。
- 安全边界和发布限制见 [SECURITY_AUDIT.md](./SECURITY_AUDIT.md) 与 [RELEASE_NOTES.md](./RELEASE_NOTES.md)。

## 目录结构

```text
apps/
  runtime/          装配根：把全部领域包接成可运行的 AgentRuntime
  gateway/          HTTP + SSE + JSON-RPC 2.0 控制面
  cli/              命令行客户端（通过 gateway 调用）
  desktop-pet/      Canvas 桌宠渲染层（Electron 为可选壳）
  jev-service/      决策服务端（确定性评分，可被真实模型替换）
  sync-service/     同步服务端（HMAC 设备令牌 + cursor 增量）
  benchmark-runner/ 用真实 Runtime 跑 A–F 对照并生成报告

packages/
  protocol/         共享事件、错误码和日志类型
  task-ledger/      SQLite 任务状态、事件日志和检查点
  runner/           Runner 接口和实现
  policy/           权限、审批和安全规则
  tools/            工具注册和执行
  verifier/         确定性结果验证
  memory/           多级记忆和上下文压缩
  routing/          Runner 和决策路由
  sync/             本地导入导出和跨设备同步
  pet-adapter/      Runtime 事件到桌宠状态的映射
  benchmark/        A–F 配置矩阵、LongTask-RR 与报告渲染

storage/
  runtime.db        任务账本
  memory.db         多级记忆
  sync.json         本地同步记录
  device.json       设备身份
```

依赖方向从 `protocol` 开始向上：领域包可以依赖共享协议，应用可以依赖领域包；共享协议不依赖应用或外部服务。`packages/benchmark` 不依赖 `apps/runtime`——它通过 `BenchmarkRuntime` 接口接收，由 `apps/benchmark-runner` 注入真实实例，避免包反向依赖应用。

## 快速开始

要求：Node.js 24+、pnpm 11.25.0。账本使用 Node.js 24 内置的 `node:sqlite`，不需要额外原生 SQLite 依赖。

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

启动桌面应用（主要的开发与使用方式）：

```bash
pnpm --filter @agent/app build
pnpm --filter @agent/app start
```

首次打开后按 `⌘,` 设置 Provider、模型与 API Key。Key 存入 macOS Keychain，不写入仓库。工作目录也在同一面板里选择，agent 的文件与命令工具以它为根。

启动控制面与桌宠（两个终端，可选，用于 HTTP 接口与桌宠展示）：

```bash
node apps/gateway/dist/main.js --port 4317
```

```bash
node apps/desktop-pet/dist/main.js
```

然后：

```bash
node apps/cli/dist/main.js run "读取 README 并总结要点"
```

可选服务：

| 服务 | 启动 | 用途 |
|---|---|---|
| Jev 决策 | `node apps/jev-service/dist/main.js --port 4318` | 通过 `AGENT_JEV_URL=http://127.0.0.1:4318` 接入 |
| 同步 | `node apps/sync-service/dist/main.js --port 4319` | 设备注册与增量同步 |
| Benchmark | `pnpm benchmark` | 真实执行 A–F，写入 `reports/` |

针对真实模型的基准测试（需要 `OPENAI_API_KEY`，报告 `pass@1` 与 `pass^k`，每项由文件系统的真实副作用校验，不采信模型自称成功）：

```bash
export OPENAI_API_KEY=... OPENAI_BASE_URL=https://api.example.com/v1 AGENT_MODEL=your-model
node --experimental-strip-types packages/benchmark/dist/live-run.js --repeats 3
```

常用脚本：

| 命令 | 用途 |
|---|---|
| `pnpm lint` | ESLint 检查 |
| `pnpm typecheck` | TypeScript 项目引用检查 |
| `pnpm test` | Vitest 测试（含 `apps/` 集成测试） |
| `pnpm build` | 构建全部包与应用 |
| `pnpm benchmark` | 真实执行 benchmark 并生成报告 |
| `pnpm test:watch` | 监听模式运行测试 |

## 文档

- [PLAN.md](./PLAN.md)：总体目标、阶段计划和最终验收标准。
- [ARCHITECTURE.md](./ARCHITECTURE.md)：目录边界、依赖方向和 Phase 0 契约。
- [progress.md](./progress.md)：按步骤记录验证结果和阻塞情况。
- [decisions.md](./decisions.md)：重要技术决策及原因。

## 路线图

```text
协议与账本
  → Agent Core
  → ReAct Runner
  → Planner / Verifier
  → 检查点与恢复
  → Jev 路由
  → 记忆与压缩
  → 桌宠接入
  → 跨设备同步
  → Benchmark 与发布
```

外部项目（如 Pi、Open Yachiyo、Jev、LangGraph、Temporal、Letta、Mem0）只会在确认接口和许可证后通过适配器接入，不会在 Phase 0 直接成为核心依赖。
