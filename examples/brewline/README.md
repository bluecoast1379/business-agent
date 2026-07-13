# Brewline 黄金样例

> **声明:本目录全部为合成数据。** Brewline 是虚构的精品咖啡豆 B2B 供应商(给咖啡馆供豆),其中的公司、门店、供应商、金额、日期、评测结果均为编造,仅用于展示 10 个阶段命令的产物长什么样。**它不是运行时信任源**——任何命令、脚本、agent 都不应把本目录当作真实配置或真实数据读取。

## 这是什么

对 Brewline 完整走一遍 `discover-business → … → operate-agent` 工作流后,目标工作区里会留下的全部文档产物。每份文件的章节骨架与 `kit/core/commands/<id>.md` 的 Required Structure **逐节对应**,可以拿来做三件事:

1. **对照**:自己执行某个命令时,拿同名样例比对产物该长什么样、粒度到哪;
2. **验收**:检查你的产物是否满足对应命令的 Exit Criteria(样例即「满分卷」);
3. **教学**:给新同事讲解方法论时的完整案例。

## 文件与命令对应关系

| 样例文件 | 生成命令 | 章节骨架来源 |
| --- | --- | --- |
| `business-profile.yaml` | 初始化后人工填写 | `kit/core/templates/business-profile.template.yaml` |
| `_portfolio/00-discovery.md` | `/discover-business` | `kit/core/commands/discover-business.md` |
| `_portfolio/01-opportunity-matrix.md` | `/map-opportunities` | `kit/core/commands/map-opportunities.md` |
| `_portfolio/02-roadmap.md` | `/plan-roadmap` | `kit/core/commands/plan-roadmap.md` |
| `agents/billing-assistant/00-blueprint.md` | `/design-agent billing-assistant` | `kit/core/commands/design-agent.md` |
| `agents/billing-assistant/01-tool-contracts.yaml` | `/define-tools billing-assistant` | `kit/core/commands/define-tools.md` |
| `agents/billing-assistant/02-safety-review.md` | `/harden-agent billing-assistant` | `kit/core/commands/harden-agent.md` |
| `agents/billing-assistant/03-eval-plan.md` | `/eval-agent billing-assistant` | `kit/core/commands/eval-agent.md` |
| `agents/billing-assistant/04-ops-runbook.md` | `/operate-agent billing-assistant` | `kit/core/commands/operate-agent.md` |

`/scaffold-gateway` 的产物是代码目录 `agent-gateway/`(由 `scaffold/` 实例化),不适合以静态样例收录;其预期结构见 `kit/core/commands/scaffold-gateway.md` 的 Required Structure。`/agent-status` 只读态汇报,无文件产物。

## 建议阅读顺序

1. `business-profile.yaml` —— Brewline 是谁、有什么系统、预算多少;
2. `_portfolio/` 三件套 —— 资产盘点 → 六条产品线 × 七视角机会矩阵 → 三波路线图;
3. `agents/billing-assistant/` 五件套 —— 首个 agent(对账与账单助手)从蓝图到运营的完整闭环。

## 自洽性约定

样例内部的数据相互勾稽,阅读时可以交叉验证:

- discovery 登记的系统与环境变量键名(`BACKEND_URL` / `BACKEND_API_KEY` / `ROASTERY_API_KEY` / `PAYFLOW_WEBHOOK_SECRET` / `OPS_WEBHOOK_URL`)与 business-profile、blueprint、tool-contracts 一致;
- 机会矩阵的每条产品线都能指回 discovery 的章节;路线图的波次来自矩阵评分;
- blueprint 的工具清单与 `01-tool-contracts.yaml` 一一对应;预算数值与 business-profile 一致;
- 安全审查、评测、运营 runbook 引用的阈值、任务名、指标与前序文档一致。

全程只出现环境变量**键名**,无任何密钥值、真实域名、真实人名。
