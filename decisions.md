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
