# /operate-agent

## Goal

让 agent 从「上线了」变成「有人管」:制定巡检任务表、成本监控与运营 SOP,产出 `agents/<slug>/04-ops-runbook.md`。目标是任何一个没参与建设的同事,拿着这份 runbook 也能接手日常运营与故障处置。

## Required Inputs

- `agents/<slug>/03-eval-plan.md`(前置产物:灰度方案与指标即运营监控的起点)
- `agents/<slug>/00-blueprint.md`(巡检式形态的触发计划与推送渠道)
- `agent-gateway/`(scheduler 任务注册、`/status` 端点、cost-tracker)
- `business-agent/business-profile.yaml`(月度预算)
- `business-agent/core/knowledge/patrol-agents.md`、`knowledge/cost-model.md`
- `business-agent/core/templates/ops-runbook.template.md`

## Execution Rules

- **巡检任务表逐项落到可执行**:每个巡检任务写清任务名、检查内容、计划(cron 语义:分/时/星期)、阈值、推送渠道与接收人、对应 scheduler 任务名(与 `agent-gateway/` 内注册名一致,不一致视为未接线)。**阈值一律外置到环境变量**(登记键名与默认值),调阈值不改代码。
- **成本监控三道线**:月度预算数值(与 business-profile 一致)、预警线(建议 70%,触发通知)、熔断线(100%,`isOverBudget` 拒绝新请求只保留 `/health`)。写明各线触发后谁收到通知、通过什么渠道、预期处置动作;数据源统一为 cost-tracker / `/status` 读数,不看 provider 账单反推。
- **运营 SOP 至少覆盖四个场景**,每个场景按「触发信号 → 处置步骤(编号)→ 升级条件」写:
  1. 误报处理:巡检告警被人工判定为误报 → 记录误报原因 → 调阈值(改 env)或修规则 → 误报样例进评测集防回归;
  2. 术语表维护:用户新黑话导致答非所问 → 补术语表(知识文件)→ 重启生效 → 加评测样例;
  3. 模型 / 价格季度复核:每季度核对 provider 价目与模型型号,重算成本估算表,评估分档策略是否要换档;
  4. 故障处置:agent 无响应 / 回答质量骤降 / 预算异常消耗的排查顺序(先看 `/status` 与日志,再查 provider 状态页,最后回滚最近变更)。
- **明确责任人与节奏**:日常值班人、周报(用量 / 成本 / 抽检准确率 / 告警数)责任人、季度复核责任人;没有名字的 SOP 不算完成(可用角色名占位但须用户确认)。
- runbook 中出现的一切配置只登记环境变量键名;不写密钥值、不写内部域名。

## Required Structure

`agents/<slug>/04-ops-runbook.md` 的完整章节骨架:

```markdown
# 运营与巡检 Runbook:<slug>

## 1. 运营概览
- 责任人:值班 / 周报 / 季度复核:
- 关键入口:/status 端点、日志位置、scheduler 任务清单:

## 2. 巡检任务表
| 任务 | 检查内容 | 计划(分/时/星期) | 阈值(env 键名=默认值) | 推送渠道/接收人 | scheduler 任务名 |
|---|---|---|---|---|---|

## 3. 成本监控
- 月度预算:<值>(来源 business-profile)
- 三道线:预警(70%)/ 熔断(100%)/ 数据源(cost-tracker `/status`):
| 线 | 阈值 | 通知谁/渠道 | 处置动作 |
|---|---|---|---|

## 4. 运营 SOP
### 4.1 误报处理
- 触发信号: / 处置步骤: / 升级条件:
### 4.2 术语表维护
### 4.3 模型与价格季度复核
### 4.4 故障处置

## 5. 例行报告
- 周报模板(用量/成本/抽检准确率/告警数)与发送渠道:

## 6. 变更管理
- 阈值调整、提示词修改、工具增删的审批与回滚方式:
```

## Exit Criteria

- [ ] 每个巡检任务的 scheduler 任务名与 `agent-gateway/` 实际注册一致;阈值全部外置为 env 键名。
- [ ] 成本三道线数值明确、与 business-profile 预算一致,通知与处置写到人 / 角色。
- [ ] 四个 SOP 场景齐备,处置步骤编号可执行,误报与术语场景都回灌评测集。
- [ ] 责任人与报告节奏经用户确认。
- [ ] 全文无密钥值、无内部域名、无真实客户数据。

## Required Outputs

- `agents/<slug>/04-ops-runbook.md`
- 对话内收尾:该 agent 十阶段闭环完成;建议定期跑 `/agent-status` 复查组合状态,或回 `/plan-roadmap` 启动下一波。
