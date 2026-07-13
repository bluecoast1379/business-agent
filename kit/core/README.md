# kit/core — 方法论内核

本目录是 business-agent 的**事实源**:10 条命令的阶段契约、产物模板、方法论知识与安全清单全部沉淀在这里。各 AI 工具(claude / cursor / copilot / codex)的命令文件只是**薄 adapter**,不承载任何方法论内容;升级 kit 时 core 目录总是被整体覆盖,因此**不要在 core 里写任何私有值或本地改动**(私有值放 `business-agent/local/`,业务画像放 `business-agent/business-profile.yaml`)。

## 目录导读

| 路径 | 内容 | 何时读 |
|---|---|---|
| `command-manifest.yaml` | 10 条命令的注册表:id、标题、顺序、产物、前置、实现闸门 | 每次执行命令前,确认顺序与前置产物 |
| `commands/<id>.md` | 每条命令的阶段契约:Goal / Required Inputs / Execution Rules / Required Structure / Exit Criteria / Required Outputs | 执行对应命令时逐节遵循 |
| `templates/` | 10 个产物模板,与各命令 Required Structure 一一对应,占位一律 `<TODO: ...>` | 生成产物文档时作为骨架 |
| `knowledge/` | 8 篇方法论文档:网关架构、工具设计、护栏、分层诊断、巡检 agent、成本模型、渠道适配 | design-agent 及之后的阶段随用随查 |
| `checklists/gateway-incidents.md` | 业务 agent 网关十大事故清单(症状 / 根因 / 守卫) | harden-agent 阶段逐项对照 |

## 读取顺序(薄 adapter → 事实源)

执行任何 `/<id>` 命令时,按以下顺序读取,后读的文件不得与先读的冲突;冲突时以 core 命令契约为准并向用户报告:

1. **薄 adapter**(如 `.claude/commands/<id>.md`):只是入口,声明「按序读取下列文件并遵循其中 Execution Rules」,自身不含规则。
2. **根 `AGENTS.md` 栅栏块**(`<!-- BEGIN business-agent -->` 至 `<!-- END business-agent -->`):工作区级总约定与命令索引。
3. **`business-agent/business-profile.yaml`**:本公司的业务画像(行业、系统清单、渠道、模型 provider、预算策略),是所有命令的公共输入。
4. **`business-agent/core/command-manifest.yaml`**:确认该命令的 order、requires(前置产物是否齐备)、outputs 与 implementation_gate。
5. **`business-agent/core/commands/<id>.md` 的阶段契约**:逐节执行 Goal → Required Inputs → Execution Rules → Required Structure → Exit Criteria → Required Outputs。

## 两条全局硬规则

1. **文档里永远只登记「环境变量键名与用途」,严禁出现密钥值、真实 token、内部域名端口**。发现即删除并提醒用户轮换。
2. **写操作(对业务系统产生副作用的工具或命令)必须人工确认**;规划阶段(order 0~5)不授权写任何业务代码,唯一的实现闸门是 `scaffold-gateway`(见 manifest 中 `implementation_gate: true`)。
