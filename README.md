# Business Agent Kit

Business Agent Kit 把「业务 AI agent 从规划到上线」编译成一套可执行的工作流,外加一个可直接运行的网关骨架:10 个阶段命令负责把业务资产盘点、机会评估、路线规划、蓝图设计、工具契约、安全加固、评测与运营固化为可检查的文档产物;零依赖的 scaffold 负责把蓝图落成一个自带鉴权、预算、写操作确认与定时巡检的 Node 网关服务。你不需要先学会某个框架——先回答业务问题,再生成代码。

## 核心能力

| 能力 | 说明 |
| --- | --- |
| 10 个阶段命令 | 从 `discover-business` 到 `operate-agent`,`kit/core/command-manifest.yaml` 是跨工具入口的单一事实源;`scaffold-gateway` 是进入写代码阶段的唯一实现闸门 |
| 零依赖 scaffold | Node 18+ ESM,只用 `node:http` 与全局 `fetch`;自带 Anthropic/Mock 双 provider、会话存储、成本追踪、scope 绑定、写操作确认闸、定时巡检与 demo 工具包 |
| 四工具 adapter | Claude Code / Cursor / GitHub Copilot 生成项目级命令入口,Codex 经根 `AGENTS.md` 栅栏块接入;adapter 只做薄转发,方法论只存在于 `kit/core/` |
| 脱敏检查 | `npm run check:sanitized` 扫描全仓词面与通用密钥形态,支持 `--extra-banned` 挂接仓库外私有 denylist |
| 网关十大事故清单 | 把业务 agent 网关的常见事故(兜底密钥、无鉴权端点、成本追踪未接线、写操作无确认……)沉淀为 `kit/core/checklists/gateway-incidents.md`,`harden-agent` 阶段强制逐项对照 |

## 三层结构

- `kit/core/`:工具无关的方法论内核——10 个命令契约、产物模板、知识库(网关架构 / 工具设计 / 护栏 / 分层诊断 / 巡检 / 成本模型 / 渠道)与事故清单。
- `scaffold/`:运行时骨架——`scaffold-gateway` 命令把它复制为目标工作区的 `agent-gateway/` 并按蓝图定制;骨架本身零依赖、可用 mock provider 直接跑通。
- `kit/adapters/`:多工具入口——每个 adapter 只声明路径与发现方式,执行时统一回读 core 的命令契约。

`examples/brewline/` 是对虚构精品咖啡豆 B2B 供应商 Brewline 走完整流程的黄金样例:全部为合成数据,只用于对照产物结构,不是运行时信任源。

## 快速开始

将本仓库 checkout 到目标工作区**之外**,然后在目标工作区根目录运行:

```bash
node ../business-agent/bin/init-workspace.cjs --target . --tools claude,cursor,copilot
```

也可以使用 wrapper:

```bash
../business-agent/install.sh . --tools claude
```

常用参数:

```bash
# 非交互初始化;待补资料写入 business-agent/INITIALIZATION_QUESTIONS.md
node ../business-agent/bin/init-workspace.cjs --target . --tools claude --yes

# 只预览写入/清理/冲突计划,不落盘
node ../business-agent/bin/init-workspace.cjs --target . --dry-run

# 升级已初始化的工作区;business-profile.yaml 永不被原地覆盖
node ../business-agent/bin/init-workspace.cjs --target . --upgrade
```

`--tools` 支持 `claude,cursor,copilot,codex`(默认 `claude`);传入 `trae`、`kiro`、`codebuddy` 之类暂不支持的工具会直接报错并指向 [支持矩阵](./docs/support-matrix.md)。生成物清单、升级保护规则与接收方验收清单见 [INIT.md](./INIT.md);tarball / Git / registry 三种安装通道见 [docs/install.md](./docs/install.md)。

## 工作流总览

| 顺序 | 命令 | 标题 | 产出(目标工作区侧) |
| --- | --- | --- | --- |
| 0 | `agent-status` | 规划状态总览 | 无(读态汇报) |
| 1 | `discover-business` | 业务资产盘点 | `agents/_portfolio/00-discovery.md` |
| 2 | `map-opportunities` | Agent 机会矩阵 | `agents/_portfolio/01-opportunity-matrix.md` |
| 3 | `plan-roadmap` | 分波路线图与预算 | `agents/_portfolio/02-roadmap.md` |
| 4 | `design-agent` | 单个 Agent 蓝图 | `agents/<slug>/00-blueprint.md` |
| 5 | `define-tools` | 工具契约目录 | `agents/<slug>/01-tool-contracts.yaml` |
| 6 | `scaffold-gateway` | 实例化网关代码 | `agent-gateway/` |
| 7 | `harden-agent` | 安全加固审查 | `agents/<slug>/02-safety-review.md` |
| 8 | `eval-agent` | 评测与验收 | `agents/<slug>/03-eval-plan.md` |
| 9 | `operate-agent` | 运营与巡检 | `agents/<slug>/04-ops-runbook.md` |

建议路径:`discover-business → map-opportunities → plan-roadmap → design-agent → define-tools → scaffold-gateway → harden-agent → eval-agent → operate-agent`,随时用 `agent-status` 查看每个 agent 的阶段与缺口。`scaffold-gateway` 带实现闸门:蓝图(00)与工具契约(01)必须存在,且蓝图中「未决问题」清空之后才允许生成代码。完整方法论叙事见 [docs/methodology.md](./docs/methodology.md),黄金样例见 [examples/brewline/](./examples/brewline/README.md)。

## scaffold 三分钟体验(mock provider)

不需要任何密钥即可跑通全链路。假设已完成初始化,目标工作区里有 `business-agent/scaffold/` 副本(直接在本仓库的 `scaffold/` 目录体验也一样):

```bash
cd business-agent/scaffold
LLM_PROVIDER=mock GATEWAY_AUTH_TOKEN=dev-token PORT=8787 node src/index.js
# stdout 出现 "listening on 8787" 即启动成功
```

另开一个终端:

```bash
# 1) 健康检查(无需鉴权)
curl -s http://127.0.0.1:8787/health

# 2) 无 token 调用会被拒绝(预期 401)
curl -s -i -X POST http://127.0.0.1:8787/chat \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"demo","message":"top customers"}'

# 3) 带 token 对话:mock provider 会先调用 demo 工具再回答
curl -s -X POST http://127.0.0.1:8787/chat \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"demo","message":"top customers"}'

# 4) 查看会话数与月成本(costUsd > 0 说明成本追踪已接线)
curl -s http://127.0.0.1:8787/status -H "Authorization: Bearer dev-token"
```

也可以不起端口,直接用 CLI 交互或跑内置自检:

```bash
LLM_PROVIDER=mock GATEWAY_AUTH_TOKEN=dev-token node bin/chat-repl.js
npm run smoke
```

换成真实 provider 时,复制 `.env.example` 为 `.env` 并填入 `LLM_PROVIDER=anthropic` 与 `LLM_API_KEY`;缺任何必填项服务会 fail-fast 直接退出,不存在兜底密钥。架构与扩展方式见 [docs/scaffold-guide.md](./docs/scaffold-guide.md)。

## 安全与隐私边界

- 仓库不含任何真实业务数据:全部示例基于虚构公司 Brewline 合成,发布前经 `check:sanitized` 词面与密钥形态扫描。
- scaffold 配置 fail-fast:必填环境变量缺失直接抛错退出;任何配置项没有内置可用的默认密钥或默认内部地址。
- 所有写操作工具必须 `confirm: human`:首次调用只返回待确认摘要与短时效 token,人工确认后二次调用才真正执行。
- 工具经 scope 绑定(如强制注入 `tenant_id`)防越权;后端鉴权永不被网关绕过。
- 初始化器只写本地工作区:不做远程 Git 操作、不部署、不写数据库、不改生产配置。
- 私有值(密钥映射、内部域名、denylist)放目标工作区被 Git 忽略的 `business-agent/local/`,或仓库之外。

完整基线见 [docs/security-baseline.md](./docs/security-baseline.md)。

## 本地验证

```bash
npm run check
```

依次执行:

```bash
npm run check:syntax      # bin/test/scaffold 全部 js/cjs/mjs 语法检查
npm run check:sanitized   # 词面 + 密钥形态脱敏扫描
npm run check:manifest    # 命令清单与 commands/ 文件一致性
npm run check:scaffold    # scaffold 冒烟:mock provider 起服务并断言鉴权/对话/成本
npm run test:smoke        # init 进临时目录,断言生成物与升级保护
```

任一失败整体非零退出。kit 与 scaffold 均无 npm 依赖,`node >= 18` 即可运行全部检查。

## 支持矩阵与维护发布

| 工具 | 项目级入口 | 状态 |
| --- | --- | --- |
| Claude Code | `.claude/commands/<id>.md` | generated |
| Cursor | `.cursor/commands/<id>.md` | generated |
| GitHub Copilot | `.github/prompts/<id>.prompt.md` | generated |
| Codex | 无项目级 prompts 文件,经根 `AGENTS.md` 栅栏块 | via-AGENTS.md |

「generated」表示初始化器生成入口并通过结构检查,不等于已在每个真实客户端版本完成人工认证;人工验收口径见 [docs/support-matrix.md](./docs/support-matrix.md)。

维护约定:通用规则只改 `kit/core/`,adapter 保持薄入口;贡献三原则与 PR 检查清单见 [CONTRIBUTING.md](./CONTRIBUTING.md);漏洞私密报告与发布前脱敏义务见 [SECURITY.md](./SECURITY.md);行为规范见 [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)。当前版本 `0.1.0`(Unreleased):版本号只描述仓库内容,不代表任何远程 tag、Release 或 npm 包已存在,见 [CHANGELOG.md](./CHANGELOG.md)。License:Apache-2.0。
