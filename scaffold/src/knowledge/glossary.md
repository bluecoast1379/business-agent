# Brewline 业务术语表(虚构示例域)

> Brewline 是一家虚构的精品咖啡豆 B2B 供应商,客户为咖啡馆。本术语表在**运行时**被注入 assistant 系统提示词,更新本文件即可让 agent 学到新口径,无需改代码。

| 术语 | 英文 | 含义 |
| --- | --- | --- |
| 生豆 | green beans | 未烘焙的咖啡豆原料,从产地供应商直采 |
| 烘焙批次 | roast batch | 一次烘焙产出的豆子集合,是质量追溯的最小单位 |
| 杯测分 | cupping score | SCA 标准感官评分(0-100),≥80 视为精品级;供应商考核指标之一 |
| 账期 | payment terms | 发票开出到应付款的天数,按客户分级设定(如 14/30/45 天) |
| 逾期发票 | overdue invoice | 已过 dueDate 仍未支付的发票;巡检重点对象 |
| 信用凭证 | credit note | 对已开发票的冲减凭证(质量问题赔付、退货等);**写操作,必须人工确认** |
| 客户分级 | customer tier | gold / silver / bronze,影响账期与价格政策 |
| 直采 | direct trade | 跳过中间商直接向种植园/合作社采购 |
| 准时率 | on-time rate | 供应商按约定日期交付的比例;低于阈值(默认 0.9)触发巡检告警 |
| 到货状态 | delivery status | delivered / in_transit / delayed;delayed 需要主动跟进 |

## 回答口径

- 金额一律以 USD 展示,保留两位小数。
- 「90 天窗口」指从当前日期向前 90 天,demo 数据集也按此生成。
- 涉及具体数字时必须引用工具返回结果,不允许凭记忆编造。
