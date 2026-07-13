# /discover-business

## Goal

用访谈式盘点把公司的数字化家底一次性登记清楚:现有系统与 API、数据资产、人工流程痛点、可用通知渠道、干系人角色。产出 `agents/_portfolio/00-discovery.md`,作为机会矩阵与所有后续设计的事实基础——**后续每一条 agent 能力都必须能回溯到这里的某条资产或痛点**。

## Required Inputs

- `business-agent/business-profile.yaml`(公司名、行业、已登记的系统与渠道;缺失或全是 `<TODO>` 时先引导用户补齐关键项)
- `business-agent/core/templates/discovery.template.md`(产物骨架)
- `business-agent/INITIALIZATION_QUESTIONS.md`(已有的未决问题,避免重复提问)
- 用户口述、内部文档、API 文档等一手材料(用户提供什么读什么,不臆造)

## Execution Rules

- **访谈驱动,逐类推进**:按「系统 → 数据 → 流程痛点 → 渠道 → 干系人」五类逐一提问;每类先给 2~3 个具体示例问题帮用户回忆(如「有没有一个每周都要人肉跑的报表?」),再登记回答。
- **系统与 API 清单只登记事实**:名称、用途、读写能力(只读 / 可写)、认证方式(如 Bearer token / API key / 会话)、文档位置。**认证一律只登记「环境变量键名与用途」(如 `BACKEND_API_KEY`:调用订单服务),严禁把任何密钥值、真实 token、内部域名端口写进文档。**
- **数据资产按可用形态登记**:报表(谁在看、多久一次)、标签(维度与覆盖率)、事件流 / 日志(采样一条脱敏示例的字段名即可,不贴真实数据)。
- **人工流程痛点必须量化**:频次 × 单次耗时 × 涉及角色;答不出精确值就登记区间估计并标注「估计」。
- **区分事实、意图与假设**:用户确认过的标「已确认」;听起来合理但没验证的标「假设」;完全没有答案的进 open questions,并同步追加到 `business-agent/INITIALIZATION_QUESTIONS.md`(不覆盖已有条目)。
- 本阶段零代码、零系统调用;不要求用户现场提供任何凭证。

## Required Structure

`agents/_portfolio/00-discovery.md` 的完整章节骨架:

```markdown
# 业务资产盘点(Discovery)

## 1. 公司概况
- 公司 / 品牌:
- 行业与商业模式:
- 核心对象(以咖啡豆 B2B 供应商 Brewline 为例:咖啡馆客户、生豆供应商、订单、账单、发票、配送):

## 2. 现有系统与 API 清单
| 系统 | 用途 | 读/写 | 认证方式(仅键名) | 文档位置 | 备注 |
|---|---|---|---|---|---|

## 3. 数据资产
### 3.1 报表
| 报表 | 内容 | 使用者 | 频率 | 生成方式(人工/自动) |
|---|---|---|---|---|
### 3.2 标签与主数据
### 3.3 事件流 / 日志(字段名级描述,不贴真实数据)

## 4. 人工流程痛点
| 流程 | 现状做法 | 频次 | 单次耗时 | 涉及角色 | 痛感描述 | 确认状态 |
|---|---|---|---|---|---|---|

## 5. 可用通知与交互渠道
| 渠道 | 类型(IM/邮件/短信/网页) | 是否有 API/webhook | 认证(仅键名) | 备注 |
|---|---|---|---|---|

## 6. 干系人角色
| 角色 | 关注什么 | 决策权 | 访谈状态 |
|---|---|---|---|

## 7. Open Questions(同步至 INITIALIZATION_QUESTIONS.md)
- [ ] <问题> — 需要谁回答
```

## Exit Criteria

- [ ] 五类资产(系统 / 数据 / 痛点 / 渠道 / 干系人)每类至少完成一轮访谈,答不出的进了 open questions,没有空章节。
- [ ] 全文无任何密钥值、真实 token、内部域名端口、真实客户数据;认证信息只有环境变量键名与用途。
- [ ] 每条痛点带频次与耗时(精确值或标注「估计」的区间)。
- [ ] 每条记录带确认状态(已确认 / 假设),事实与假设可区分。
- [ ] open questions 已同步进 `business-agent/INITIALIZATION_QUESTIONS.md` 且未覆盖既有内容。

## Required Outputs

- `agents/_portfolio/00-discovery.md`
- 更新 `business-agent/INITIALIZATION_QUESTIONS.md`(追加新增未决问题)
- 对话内提示下一步:`/map-opportunities`
