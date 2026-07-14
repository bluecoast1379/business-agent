# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 风格,版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> 说明:版本条目描述**仓库内容**;某版本是否已发布到 npm registry 以 registry 实际状态为准,本文件不做保证。对外分发前请按 [docs/install.md](./docs/install.md) 的通道与验收清单执行。

## [0.2.0] - 2026-07-14

### Changed

- **运行环境要求提升为 Node >= 22**(Node 18 与 20 已先后 EOL,不再作为支持线):`engines`、`install.sh` 版本闸、README/文档口径同步;CI 矩阵改为 ubuntu 22/24/26 + macos 24 + windows 24。

## [0.1.0] - 2026-07-13

### Added

- **方法论内核 `kit/core/`**:10 个阶段命令契约(`agent-status` / `discover-business` / `map-opportunities` / `plan-roadmap` / `design-agent` / `define-tools` / `scaffold-gateway` / `harden-agent` / `eval-agent` / `operate-agent`),`command-manifest.yaml` 单一事实源,产物模板,知识库(网关架构、工具设计、护栏、分层诊断、巡检、成本模型、渠道),以及「网关十大事故清单」。
- **零依赖 scaffold**:Node 18+ ESM 网关骨架——Anthropic/Mock 双 provider、agent 运行时(tool-call 循环 + 预算折算)、会话存储、成本追踪、定时巡检、HTTP/SSE/webhook 渠道、scope 绑定与写操作确认闸两类护栏、Brewline demo 工具包与 CLI REPL。
- **初始化器与工具链**:`bin/init-workspace.cjs`(幂等初始化 / `--upgrade` 升级 / preserveOnUpgrade 保护 / AGENTS.md 栅栏块),`install.sh` wrapper,四工具 adapter(claude/cursor/copilot 生成项目级入口,codex 经 AGENTS.md)。
- **质量与安全检查**:`check:syntax`、`check:sanitized`(内置通用密钥形态;项目专有词经仓库外 `--extra-banned` denylist 提供)、`check:manifest`、`check:scaffold`(mock 冒烟)、`test:smoke`(init 冒烟),由 `npm run check` 串联。
- **文档与黄金样例**:README / INIT / docs(方法论、scaffold 指南、安全基线、安装、支持矩阵)与 `examples/brewline/` 全流程合成样例。

### Security

- 仓库全部示例基于虚构公司 Brewline 合成;发布前须 `npm run check:sanitized` 零命中(见 [SECURITY.md](./SECURITY.md))。
- scaffold 配置 fail-fast,无任何兜底密钥或默认内部地址;写操作工具一律经确认中心**带外人工审批**(模型无法自我确认);入站 webhook 采用时间戳签名防重放。
