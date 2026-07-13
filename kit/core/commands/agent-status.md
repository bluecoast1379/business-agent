# /agent-status

## Goal

只读汇报:盘点当前工作区里 agent 组合规划(portfolio)与每个 agent 的产物状态,判定各自处于 10 阶段中的哪一步、缺什么产物、下一步该执行哪条命令。本命令不生成、不修改任何文件。

## Required Inputs

- `business-agent/core/command-manifest.yaml`(命令顺序、outputs、requires 的权威定义)
- `business-agent/business-profile.yaml`(存在性与 `<TODO>` 残留情况)
- `agents/_portfolio/` 下的 `00-discovery.md`、`01-opportunity-matrix.md`、`02-roadmap.md`
- `agents/<slug>/` 各目录下的 `00-blueprint.md`、`01-tool-contracts.yaml`、`02-safety-review.md`、`03-eval-plan.md`、`04-ops-runbook.md`
- `agent-gateway/`(或用户自定义的网关目录)存在性,及其 `package.json`、`.env.example`

## Execution Rules

- 全程只读。即使发现产物缺章节或格式错误,也只在汇报中标注,不代为修复。
- 以 manifest 的 `outputs` / `requires` 为判定基准:产物文件存在且非空 → 该阶段「已完成」;文件存在但仍含 `<TODO:` 占位或模板必备章节缺失 → 「不完整」;文件不存在 → 「未开始」。
- 组合规划层(order 1~3)与单 agent 层(order 4~9)分开汇报;`agents/` 下每个非 `_portfolio` 子目录视为一个 agent。
- 对每个 agent 给出**下一步命令**:取 manifest order 最小的、requires 已满足但 outputs 尚未完成的命令;若前置未满足,指出先补哪个前置。
- 检查实现闸门状态:`scaffold-gateway` 是否已具备执行条件(`00-blueprint.md` 与 `01-tool-contracts.yaml` 存在,且蓝图「待确认项」章节为空)。
- 若传入了 agent-slug 参数,只深查该 agent 并附产物内容级体检(章节齐全度、占位残留清单)。

## Required Structure

在对话中按以下结构汇报(不落盘):

```markdown
# Agent 规划状态总览

## 组合规划层
| 阶段 | 产物 | 状态 | 备注 |
|---|---|---|---|
| discover-business | agents/_portfolio/00-discovery.md | 已完成/不完整/未开始 | <缺失章节或占位残留> |
| map-opportunities | agents/_portfolio/01-opportunity-matrix.md | ... | ... |
| plan-roadmap | agents/_portfolio/02-roadmap.md | ... | ... |

## 各 Agent 状态
| agent | 当前阶段 | 已有产物 | 缺失产物 | 闸门状态 | 下一步命令 |
|---|---|---|---|---|---|
| <slug> | design/tools/scaffold/... | ... | ... | 可通过/待确认项未清空/前置缺失 | /<id> <slug> |

## 网关
- agent-gateway/:存在与否、来自哪个 agent、smoke 是否已记录通过

## 建议下一步
1. <按优先级列出 1~3 条具体命令>
```

## Exit Criteria

- [ ] `agents/` 下每个 agent(含 `_portfolio` 层)都出现在汇报中,无遗漏。
- [ ] 每行「状态」判定都基于文件存在性 + 内容体检,而非猜测。
- [ ] 每个未完结的 agent 都给出了明确的下一步命令与参数。
- [ ] 实现闸门(scaffold-gateway)的可通过性给出了明确结论与依据。
- [ ] 未创建、未修改任何文件。

## Required Outputs

- 无文件产出;仅对话内状态汇报。
- 若发现产物损坏、占位残留或闸门被绕过(有 `agent-gateway/` 却无蓝图),在汇报末尾以「异常」小节显式列出。
