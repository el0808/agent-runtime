# @agent/desktop-pet

桌宠展示层。只消费运行时事件，不拥有模型、工具或审批权限。

## 运行

```bash
node dist/main.js
```

有 Electron 时开一个置顶无边框窗口；没有则退回静态服务，并在终端打印地址：

```text
open http://127.0.0.1:4320/pet.html?gateway=http://127.0.0.1:4317
open http://127.0.0.1:4320/pet.html?demo=1        # 不需要 gateway
```

`demo=1` 会循环播放脚本化状态，用于单独检查渲染。

## 状态

九种状态与 `@agent/pet-adapter` 的 `PetState` 一致：`idle`、`listening`、`thinking`、`working`、`waiting_approval`、`verifying`、`success`、`error`、`sleeping`。

映射规则在渲染层内联了一份（`renderer/pet.html` 的 `mapState`），与包内 `mapper.ts` 保持一致；改一处需同步另一处。

## 渲染

Canvas 2D 矢量角色。口型由 `model.delta` 的到达节奏驱动（长度映射到开口幅度并衰减），不是真实音素分析。审批态会显示脉冲环。

## 边界

- **Electron 二进制未随仓库提供**，本机也无法下载，因此 Electron 路径未实际运行验证；渲染层已用浏览器验证（HTTP 200）。
- **未引入 Live2D 模型与语音资源**：涉及第三方授权，需单独审查。`Live2DPetAdapter` 的 transport 接缝保留在 `@agent/pet-adapter`。
- 事件来源是 gateway 的 `/events` SSE 流；换传输只需替换 `createSseTransport`。
