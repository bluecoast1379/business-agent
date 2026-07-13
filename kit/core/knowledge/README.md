# knowledge/ — 方法论文档导读

本目录沉淀业务 agent 从架构到运营的可复用方法论。全部内容为通用化模式(示例一律使用虚构的精品咖啡豆 B2B 供应商 **Brewline**),可直接引用到你自己的蓝图、审查与 runbook 中。

## 阅读地图

| 文档 | 主题 | 主要服务的命令 |
|---|---|---|
| `gateway-architecture.md` | 旁路网关模式:独立 Node 服务、HTTP 调既有后端、token 透传、绝不绕过后端鉴权;交互式/批处理双入口与统一心跳函数 | `/design-agent`、`/scaffold-gateway` |
| `tool-design.md` | 工具四模式:summary/raw 双形态、cleanParams 参数清洗、hint-in-result、scoped 工具工厂;最小权限角色 | `/define-tools`、`/scaffold-gateway` |
| `guardrails.md` | 护栏四件套:数据隔离三层(只有后端层是真正边界)、写操作两段式人工确认、预算双层、fail-fast 配置与禁止默认凭证 | `/design-agent`、`/harden-agent` |
| `layered-diagnosis.md` | 分层诊断引擎:完整性检查 → 规则一致性校验 → 人工干预识别;以 Brewline 月度对账为例 | `/design-agent`(诊断类 agent) |
| `patrol-agents.md` | 巡检 agent:临时实例、结构化任务提示词(日期区间+编号步骤)、safeRun 守卫、阈值外置 env | `/design-agent`、`/operate-agent` |
| `cost-model.md` | 成本估算方法(场景×日均次数×token 量×档位)、模型分档路由、省 token 三板斧、运行时实测对账 | `/plan-roadmap`、`/operate-agent` |
| `channels.md` | Channel 适配器接口、消息长度预算、入站 webhook 验签、SSE 流式 | `/design-agent`、`/scaffold-gateway`、`/harden-agent` |

## 按角色的推荐阅读顺序

- **规划者**(还没写一行代码):`cost-model.md` → `gateway-architecture.md`。先搞清楚钱怎么算、系统怎么旁路,再去画机会矩阵,估出来的 roadmap 才立得住。
- **实现者**(准备跑 `/scaffold-gateway`):`gateway-architecture.md` → `tool-design.md` → `guardrails.md` → `channels.md`。这四篇覆盖了实例化定制的全部决策点。
- **审查者**(跑 `/harden-agent`):`guardrails.md` → `checklists/gateway-incidents.md` → `channels.md` §3(webhook 验签)。按「护栏与事故清单对照速查」逐项核对。
- **运营者**(跑 `/operate-agent`):`patrol-agents.md` → `cost-model.md` §4(实测对账)。
- **做诊断/对账类 agent 的人**:加读 `layered-diagnosis.md`,它决定你的 agent 里哪些活给代码、哪些给 LLM。

## 核心不变式速查

跨越所有文档、值得反复背诵的七条:

1. 只有后端层是真正的安全边界,提示词层与工具层只是纵深(`guardrails.md`)。
2. 所有写操作必须两段式人工确认,模型自己「确认」不算数(`guardrails.md`)。
3. 工具默认 summary,raw 显式请求且限行;返回体价值密度要对得起 token 账单(`tool-design.md`)。
4. 系统提示词是函数,时变信息每次请求求值(`gateway-architecture.md`)。
5. 必填配置缺失就崩;任何配置不得有可用的密钥/域名默认值(`guardrails.md`)。
6. 成本以 cost-tracker 实测为准,冒烟必须证明「读数 > 0」(`cost-model.md`)。
7. 巡检失败必须出声;「没消息」要能区分「没问题」与「巡检挂了」(`patrol-agents.md`)。

## 反例索引(按症状反查)

排障与审查时,按你观察到的症状直接跳到对应文档的反例小节:

| 症状 | 大概率的病 | 去哪读 |
|---|---|---|
| 回答里的「今天」一直是几天前 | 提示词在模块加载时求值 | `gateway-architecture.md` 反例 3 |
| 某个渠道的用量没进成本统计 | 渠道绕过统一心跳函数 | `gateway-architecture.md` 反例 2、`channels.md` 反例 |
| 模型频繁选错工具 / 说查不到 | description 含糊、工具过多、参数没洗 | `tool-design.md` §2、§5 |
| 单次回答 token 成本异常高 | 工具透传原始大 JSON | `tool-design.md` §1 |
| 能诱导 agent 说出别家数据 | scope 未强制注入或后端免鉴权 | `guardrails.md` §1 |
| 写操作被「连问两次」触发 | 确认门实现成模型自确认 | `guardrails.md` §2 |
| 月成本读数恒为 0 | cost-tracker 未接线 | `cost-model.md` §4 |
| 巡检结论时对时错、没法环比 | 任务提示词无编号步骤、格式未钉死 | `patrol-agents.md` 反例 2 |
| 告警消失了很久没人发现 | 巡检静默失败 | `patrol-agents.md` 反例 3 |
| IM 里收到的报告总是半截 | 渠道无长度预算 | `channels.md` §2 |
| 对账 agent 每次跑结果不一样 | 把确定性工作交给了 LLM | `layered-diagnosis.md` 反例 1 |

## 使用约定

1. **命令契约引用这里,不复制这里**:`commands/<id>.md` 的 Execution Rules 指到具体文档;方法论更新只改一处。
2. **反例即检查项**:各篇末尾的反例与 `checklists/gateway-incidents.md` 十项清单互为印证,`/harden-agent` 审查时可交叉引用。
3. **Brewline 示例只是示例**:落到你的业务时,把术语、对象、阈值替换为 business-profile 与 discovery 中登记的真实口径;示例数据不构成任何默认值。
4. **沉淀你自己的方法论**:运营中长出的新模式(新的失败样例类型、新的渠道适配经验)先记进对应 agent 的 runbook;被第二个 agent 复用时,再提炼成本目录下的新文档——升级 kit 会覆盖本目录,自建文档请用独立文件名并在团队侧版本管理中保留副本。
