# 工具设计(Tool Design)

工具是 agent 的手,也是 token 成本与越权风险的主要来源。本篇给出四个经过实战检验的模式:summary/raw 双形态、参数清洗、hint-in-result、scoped 工具工厂,以及配套的最小权限原则。

## 1. summary/raw 双形态

**默认给摘要,明细按需下钻。** 列表 / 明细类工具一律实现两种形态:

- `summary`(默认):裁剪字段(只留模型回答需要的)、截断行数(如前 20 行)、附聚合统计(总数、合计、分组小计)。
- `raw`:显式传 `mode=raw` 才返回逐行数据,且仍设行数上限(如 50 行)并在超限时说明。

以 Brewline 为例:`get_unpaid_invoices` 的 summary 返回「未回款发票 37 张、合计 8.4 万,按客户分组前 5 名」,而不是 37 张发票 × 40 个字段的原始 JSON。后者一次就能吃掉数千 token,还把模型注意力稀释到 `updated_by` 这类无关字段上(事故清单第 10 项)。

判断口径:**工具返回体的价值密度要对得起它的 token 账单**。写 description 时明确两种形态的语义,让模型知道何时该下钻。

## 2. cleanParams:参数清洗在工具层,不指望模型

模型传参不可靠是常态:多传没定义的参数、枚举值大小写不对、数字传成字符串、日期格式五花八门。工具层统一做:

- **白名单过滤**:只保留 schema 声明过的参数,未知参数丢弃(而不是透传给后端引发 400)。
- **类型归一**:`"20"` → 20、`"True"` → true、日期归一到 `YYYY-MM-DD`。
- **必填校验与友好报错**:缺必填时返回给模型一条可行动的错误(「缺少 date_from,请以 YYYY-MM-DD 提供」),模型能自我修正;直接抛 500 它只会瞎猜。

反例:把模型参数原样拼进后端查询,模型某次把客户名传进 `customer_id`,后端返回空,模型于是「查不到」——用户以为没数据,实际是参数没洗。

## 3. hint-in-result:工具返回携带分析指引

工具返回体不只是数据,还可以带一个 `hint` 字段引导模型下一步:

```json
{
  "summary": "unpaid invoices: 37, total 84,000; top customer CLOUD-MIST (12)",
  "truncated": true,
  "hint": "Data truncated to top 5 groups. Call with mode=raw and customer_id to drill into one customer. Amounts are pre-tax."
}
```

hint 的三个高价值用法:说明**截断与下钻方式**;提示**口径陷阱**(含税/不含税、时区、账期定义);建议**关联工具**(「回款分析可结合 get_order_summary 对照」)。这比把同样的话塞进系统提示词便宜——只在用到该工具时才占上下文。

反例:所有口径说明都堆在系统提示词里,每轮对话都为一个从未被调用的工具付 token。

## 4. scoped 工具工厂:防越权在工具层收口

凡是按租户 / 客户隔离的数据,工具用工厂包一层,scope 参数由网关**强制注入**:

```js
// withScope(tool, { tenantId }): handler receives injected scope;
// same-name params from the model are overwritten, not merged.
const scopedTool = withScope(getOrderSummary, { tenantId: session.tenantId });
```

要点:**覆盖而不是补缺**——模型传了 `tenant_id` 也以注入值为准;scope 来自会话鉴权结果,不来自消息内容。配套写渗透用例:诱导 agent 查其他租户,断言返回不含他租户数据(见 `/harden-agent`)。

同时记住:工具层 scope 是纵深防御,**真正的边界在后端按 token 校验归属**(`guardrails.md`);两层都要有,但只有后端层缺失才算安全事故。

## 5. 写工具与最小权限

- 写工具必须 `confirm: human`,包两段式确认门(`guardrails.md` §写操作人工确认),契约里写清 `effect`。
- 网关的后端凭证按**工具清单实际用到的范围**申请:只读 agent 就申请只读角色。「先拿管理员 key 跑通」是事故清单第 6 项的标准起点。
- 工具数量克制:模型面对 30 个工具的选择正确率显著低于 8 个。蓝图能力没用到的工具删掉,相似工具合并(用参数区分),比写再多 description 都有效。
