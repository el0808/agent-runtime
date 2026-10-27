# 本地优先的可验证 Agent Runtime + Harness + 2D 桌宠

## 1. 总体目标

构建一个 TypeScript + Node.js 的 Agent Runtime，具备：

- 多种 Runner 自动选择；
- 长任务持续执行；
- 任务检查点、恢复、暂停、撤销和补偿；
- 可查看、可编辑的多级记忆；
- 主动上下文压缩；
- Jev 快速决策和模型路由；
- 统一对话与执行事件；
- 跨设备同步；
- Electron + Live2D 2D 桌宠界面；
- 结果验证、证据记录和安全审批。

第一版采用：

- **本地桌面优先**；
- **Open Yachiyo 通过适配器或进程边界接入**；
- **Jev 作为可替换的决策服务**；
- **SQLite + 本地文件作为初始存储**；
- 后续再增加 PostgreSQL 和云同步。

## 2. 总体项目框架

```text
apps/
  runtime/          Agent 核心运行时
  gateway/          HTTP、WebSocket、JSON-RPC 接口
  desktop-pet/      Electron + Live2D 桌宠
  cli/              命令行客户端

packages/
  protocol/         统一事件和 API 类型
  task-ledger/      任务状态、事件日志、检查点
  runner/           各类 Runner
  policy/           权限、审批、安全规则
  tools/            工具注册和执行
  verifier/         结果验证
  memory/           多级记忆与压缩
  routing/          Runner Router 和 Jev Adapter
  sync/             跨设备同步
  pet-adapter/      Runtime 状态到桌宠动作的映射

storage/
  runtime.db        SQLite 任务账本和事件索引
  artifacts/        文件、补丁、报告、日志
  checkpoints/      检查点和恢复数据
```

核心数据流：

```text
用户输入
  ↓
Task Classifier
  ↓
Policy Engine
  ↓
Runner Router
  ↓
Jev Decision Layer
  ↓
Runner
  ↓
Tools / Memory / Verifier
  ↓
Checkpoint + Event Store
  ↓
Web / CLI / Desktop Pet / Sync
```

核心原则：

- Agent 负责理解、规划和生成；
- Harness 负责状态、权限、执行、恢复和验证；
- Jev 负责有限选项的快速判断；
- Open Yachiyo 负责桌宠展示；
- 所有重要动作都必须产生事件和证据。

## 3. Agent 与 Harness 的总体框架

### Agent 层

Agent 负责：

- 理解用户目标；
- 生成任务计划；
- 选择或请求工具；
- 处理复杂异常；
- 生成代码、文本和结构化结果；
- 根据验证结果调整计划。

### Harness 层

Harness 负责：

- 保存任务状态；
- 管理 Runner；
- 执行权限和审批；
- 创建检查点；
- 调度工具；
- 重试和恢复；
- 检查结果；
- 记录事件；
- 控制模型成本；
- 同步任务状态。

### Runner 类型

```text
Direct/ReAct
  简单问答、少量工具调用

Planner-Executor-Verifier
  多步骤代码、文件和数据任务

State Graph
  固定流程、分支、审批和重试

Multi-Agent
  需要多个专业角色并行协作

Background Runner
  长时间、定时、无人值守任务

Transactional Runner
  修改外部状态、需要检查点和补偿操作
```

Runner 必须支持统一接口：

```ts
interface Runner {
  run(taskId: string): AsyncIterable<RuntimeEvent>;
  pause(taskId: string): Promise<void>;
  resume(taskId: string): Promise<void>;
  cancel(taskId: string): Promise<void>;
  rollback(taskId: string): Promise<void>;
}
```

## 4. 可以复用的开源项目

| 项目 | 复用内容 | 集成方式 |
|---|---|---|
| [Pi](https://github.com/badlogic/pi-mono) | 多模型接口、Agent Loop、Tool Calling、流式输出、Session/State、扩展机制 | 参考 `pi-ai` 和 `pi-agent-core`，通过 Provider/Runner Adapter 接入 |
| [Open Yachiyo](https://github.com/sdyzjx/open-yachiyo) | Electron、Live2D、Pixi、桌宠动作、对话气泡、语音口型同步、桌面打包 | 独立 Desktop Pet Adapter，通过 WebSocket/JSON-RPC 接收 RuntimeEvent |
| [JevAgentHarness](https://github.com/JevAgentHarness/JevAgentHarness) | Jev 路由、快速/强模型分流、置信度阈值、Shadow Mode、路由日志、Benchmark 结构 | 复用协议和设计思想，不让 Jev 直接拥有权限 |
| [LangGraph](https://github.com/langchain-ai/langgraphjs) | State Graph、条件边、节点状态和图式任务 | 可作为 State Graph Runner 的参考；MVP 不强制依赖 |
| [Temporal](https://github.com/temporalio/sdk-typescript) | 长任务 Worker、定时、重试、持久化工作流 | 后期云端或生产版采用，MVP 先用 SQLite 状态机 |
| [Letta](https://github.com/letta-ai/letta) | 长期记忆、记忆块、Agent 持久化 | 参考记忆组织方式，不直接采用其记忆作为唯一真相 |
| [Mem0](https://github.com/mem0ai/mem0) | 事实提取、向量检索和记忆存储 | 作为可选检索后端，增加版本、来源和冲突处理 |
| SQLite/Drizzle | 本地任务账本、事件索引、检查点 | 直接使用 |
| PostgreSQL/pgvector | 云端同步、向量检索和多设备数据 | 第二阶段接入 |

Open Yachiyo 的代码、Live2D 模型、声音和贴图需要分别检查许可证；不能因为仓库公开就默认所有资源都能商业复制。

## 5. 必须自行改进的差异化能力

### 任务账本

每个任务必须保存：

```text
目标
当前状态
Runner 类型
已完成步骤
待完成步骤
工具调用
文件和产物
验证结果
错误记录
检查点
回滚信息
```

### 多 Runner 动态升级

```text
简单任务       → ReAct
步骤变多       → Planner
出现固定分支   → State Graph
产生外部副作用 → Transactional Runner
连续失败       → 强模型 + Verifier
长时间执行     → Background Runner
```

### 可验证执行

验证器必须能读取：

- 测试结果；
- 命令退出码；
- 文件 diff；
- API 响应；
- 数据库状态；
- 部署健康检查；
- 任务目标和最终产物。

Agent 不能只根据自己的文字回复宣布任务完成。

### 可恢复和可撤销

外部副作用前建立检查点：

```text
文件覆盖
数据库迁移
部署
发送消息
删除数据
创建云资源
```

撤销使用补偿动作，而不是只依赖模型重新操作。

### 记忆与上下文压缩

记忆范围：

```text
全局
项目
任务
会话
临时上下文
```

每条记忆应有：

```text
来源
时间
置信度
作用域
版本
过期时间
冲突状态
```

上下文压缩需要：

- 主动触发；
- 保存原始事件；
- 生成任务摘要；
- 保留关键约束；
- 保留未解决问题；
- 压缩后允许恢复原始记录。

### Jev 决策层

Jev 负责：

```text
routine / hard
tool choice
continue / stop
approve / review / block
retry / escalate
runner selection
```

安全规则必须由确定性代码执行。Jev 只能提供判断信号，不能单独授权删除、支付、部署或数据迁移。

### 跨设备同步

同步对象：

```text
对话
任务状态
事件日志
记忆
检查点
工具结果
验证结果
桌宠状态
```

采用事件 ID、版本号和幂等写入，避免重复执行工具。

## 6. Benchmark 方案

### 对比组

固定相同任务、模型、工具、权限和超时，比较：

```text
A. 强模型全程执行
B. 快速模型全程执行
C. 你的 Runtime，不使用 Jev
D. 你的 Runtime + Jev
E. 你的 Runtime + Jev + Verifier
F. 你的 Runtime + Jev + Verifier + Recovery
```

### 公开数据集

- [Terminal-Bench](https://www.tbench.ai/)：代码和终端任务；
- [τ-bench](https://github.com/sierra-research/tau-bench)：工具调用和用户交互；
- [BFCL](https://gorilla.cs.berkeley.edu/leaderboard.html)：函数调用；
- [AndroidWorld](https://github.com/google-research/android_world)：设备操作；
- [LongMemEval](https://github.com/xiaowu0162/LongMemEval)：长期记忆。

### 自建长任务数据集

建立 `LongTask-RR`，覆盖：

```text
多文件修改
多轮工具调用
审批节点
网络断开
模型超时
工具失败
进程崩溃
中途换设备
上下文压缩
部分撤销
完整恢复
```

每类至少 30 个任务，关键任务重复 3～5 次，并报告置信区间。

### 主要指标

| 指标 | MVP 目标 | 发布目标 |
|---|---:|---:|
| 任务成功率 | 不低于强模型基线 3 个百分点 | 不低于基线 1 个百分点 |
| 每个成功任务成本 | 降低 20% | 降低 35%～50% |
| 总耗时 | 降低 10% | 降低 20%～30% |
| Jev 路由延迟 P95 | <300ms | <150ms |
| 失败恢复成功率 | ≥85% | ≥95% |
| 断点续跑成功率 | ≥90% | ≥98% |
| 撤销残留副作用 | <3% | <1% |
| 高风险误授权 | 0 次 | 0 次 |
| 压缩后 token 减少 | 30%～40% | 50%～70% |
| 压缩后成功率损失 | ≤3 个百分点 | ≤1 个百分点 |
| 记忆检索准确率 | ≥85% | ≥92% |
| 同步事件丢失 | 0 | 0 |
| 跨设备恢复成功率 | ≥95% | ≥99% |
| 桌宠事件响应 P95 | <500ms | <200ms |

首要指标应是：

```text
每个成功完成任务的总成本
每个成功完成任务的总耗时
```

不能只统计“模型调用次数”，因为失败重试和恢复失败会提高真实成本。

## 7. Codex 执行 Todo List

### Phase 0：项目初始化

- [x] 创建 TypeScript + Node.js Monorepo；
- [x] 配置 pnpm、TypeScript、ESLint、Vitest；
- [x] 定义包结构；
- [x] 建立统一错误码和日志格式；
- [x] 编写 ARCHITECTURE.md；
- [x] 建立 Git 分支和 CI。

### Phase 1：协议和事件账本

- [x] 定义 `RuntimeEvent`；
- [x] 定义 `TaskProfile`；
- [x] 定义 `Runner` 接口；
- [x] 定义 `ToolCall`、`Checkpoint`、`VerificationResult`；
- [x] 实现 SQLite 事件表；
- [x] 实现任务状态机；
- [x] 实现事件回放。

验收：进程重启后可以读取任务状态和完整事件。

### Phase 2：Agent Core

- [x] 接入 Pi 风格的多模型 Provider；
- [x] 实现工具注册和工具调用；
- [x] 实现基础 ReAct Runner；
- [x] 实现流式模型输出；
- [x] 实现会话和任务隔离；
- [x] 实现工具超时、重试和取消。

验收：可以完成简单文件读取、修改和测试任务。

### Phase 3：Runner Router

- [x] 实现任务特征提取；
- [x] 实现规则路由；
- [x] 实现 Planner-Executor-Verifier；
- [x] 实现 State Graph Runner；
- [x] 实现 Background Runner；
- [x] 实现 Runner 动态升级；
- [x] 保存每次路由决策和证据。

验收：同一任务能根据复杂度选择不同 Runner。

### Phase 4：安全、验证和恢复

- [x] 实现工具权限策略；
- [x] 实现人工审批节点；
- [x] 实现确定性风险检查；
- [x] 实现 Verifier；
- [x] 实现检查点；
- [x] 实现暂停和继续；
- [x] 实现失败恢复；
- [x] 实现撤销和补偿动作。

验收：注入进程崩溃、网络失败和工具失败后可以继续任务。

### Phase 5：Jev 集成

- [x] 定义 `DecisionProvider` 接口；
- [x] 实现 `RulesDecisionProvider`；
- [x] 实现 `JevDecisionProvider`；
- [x] 实现 Shadow Mode；
- [x] 实现置信度阈值；
- [x] 低置信度自动回退强模型；
- [x] 记录 Jev 延迟、概率、路由和结果；
- [x] 禁止 Jev 单独通过高风险操作。

验收：Jev 不可用时系统仍能自动回退到强模型。

### Phase 6：记忆和压缩

- [x] 实现全局、项目、任务、会话记忆；
- [x] 实现记忆来源和版本；
- [x] 实现搜索和编辑；
- [x] 实现冲突记忆处理；
- [x] 实现主动上下文压缩；
- [x] 保存压缩前后的摘要；
- [x] 实现压缩质量评估。

验收：压缩后任务仍能继续，用户可以查看和恢复原始记录。

### Phase 7：桌宠接入

- [x] 建立 `PetAdapter`；
- [x] 定义桌宠状态机；
- [x] 接入 Open Yachiyo 的 Electron/Live2D 展示层；
- [x] 映射思考、执行、审批、成功、失败、睡眠状态；
- [x] 接入流式气泡；
- [x] 接入语音和口型同步；
- [x] 实现断线重连；
- [x] 桌宠不直接调用 LLM。

验收：Runtime 事件能稳定驱动桌宠状态，桌宠重启不影响任务。

### Phase 8：跨设备同步

- [x] 实现事件 ID 和幂等写入；
- [x] 实现本地导出和导入；
- [x] 实现同步服务；
- [x] 实现设备认证；
- [x] 实现冲突检测；
- [x] 实现另一台设备继续任务；
- [x] 同步记忆和检查点。

验收：在设备 B 上可以查看并恢复设备 A 的任务。

### Phase 9：Benchmark 和发布

- [x] 实现统一 Benchmark Runner；
- [x] 接入公开任务集；
- [x] 建立 `LongTask-RR`；
- [x] 运行 A～F 六组对照实验；
- [x] 做 Jev、Verifier、压缩、恢复的消融实验；
- [x] 记录成本、token、延迟、成功率；
- [x] 生成报告和可复现实验配置；
- [x] 完成安全审计；
- [x] 完成桌宠资源授权审查；
- [x] 发布 Demo、架构文档和 Benchmark 报告。

## 8. 最终验收标准

项目达到以下条件后，才认为第一版完成：

1. 能完成普通工具任务；
2. 能自动选择不同 Runner；
3. 能在失败和崩溃后恢复；
4. 能验证最终结果；
5. 能撤销至少三类外部副作用；
6. 能主动压缩上下文；
7. 用户能查看和编辑记忆；
8. Jev 故障时能安全回退；
9. 桌宠只作为展示层工作；
10. 另一台设备能继续任务；
11. Benchmark 中成功率接近强模型基线；
12. 每个成功任务的成本和耗时明显下降。

第一阶段不要同时实现所有高级功能。正确顺序是：

```text
协议与账本
→ Agent Core
→ ReAct
→ Planner/Verifier
→ 检查点与恢复
→ Jev 路由
→ 记忆与压缩
→ 桌宠
→ 跨设备同步
→ Benchmark 发布
```

