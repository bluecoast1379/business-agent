# 巡检 Agent(Patrol Agents)

巡检 agent 是「定时批处理」形态:没有用户在线提问,由 scheduler 触发,自己查数据、自己判断、把结论推送到渠道。它与交互式 agent 共享同一套运行时与工具,但设计取向完全不同——**交互式求灵活,巡检式求确定**。

## 1. 临时实例,而非长驻会话

每次巡检**新建一个 agent 实例**,跑完即弃:

```js
// each patrol run gets a fresh agent: no session carry-over,
// no stale context, deterministic budget per run
async function runDailyPatrol() {
  const agent = createAgent({
    name: "invoice-patrol",
    model: config.defaultModel,
    systemPrompt: buildPatrolPrompt(),   // evaluated per run
    tools: patrolTools,
    maxBudgetUsd: Number(process.env.PATROL_MAX_BUDGET_USD || 0.2),
  });
  return agent.prompt(buildTaskPrompt(dateRange()));
}
```

理由:巡检不需要记忆,复用会话只会让上次的结论污染这次的判断;临时实例天然给了**每次运行独立的预算与日志边界**,一次跑飞不连累下一次。

## 2. 结构化任务提示词:日期区间 + 编号步骤

巡检的任务提示词不是「看看有没有逾期发票」,而是一份**可复跑的作业单**:

```
任务:Brewline 逾期发票日巡(数据区间:{{date_from}} ~ {{date_to}})
步骤:
1. 调 get_unpaid_invoices(summary)获取未回款发票汇总;
2. 筛出超过账期 {{OVERDUE_DAYS}} 天的发票;
3. 按客户聚合,金额降序取前 10;
4. 对比上次巡检快照,标注新增与已回款项;
5. 按以下格式输出,不要输出格式外的内容:
   [逾期总览] 张数/金额/环比
   [Top 客户] 客户|张数|金额|最早逾期日
   [新增] ...
   [建议关注] 不超过 3 条,每条一句话
```

要点:**日期区间显式传入**(不让模型自己理解「最近」);**步骤编号**(模型漏步骤的概率随步骤模糊度上升);**输出格式钉死**(下游渠道格式化与人工快扫都依赖它);阈值以 `{{占位}}` 从 env 注入。

## 3. safeRun:预算检查 + 异常兜底

scheduler 执行任何任务都包 safeRun 守卫:

```js
async function safeRun(job) {
  if (costTracker.isOverBudget(config.monthlyBudgetUsd)) {
    log.warn(`skip ${job.name}: monthly budget exceeded`);
    notifyOps(`patrol ${job.name} skipped: over budget`);
    return;
  }
  try {
    await job.run();
  } catch (err) {
    log.error(`patrol ${job.name} failed`, err);
    notifyOps(`patrol ${job.name} failed: ${err.message}`); // alert, never swallow
  }
}
```

两个不变式:**预算超限时跳过并通知**(而不是带病硬跑烧钱);**异常必须出声**(巡检静默失败 = 大家以为「没告警就是没问题」,比不巡检更危险)。

## 4. 阈值外置到 env

「逾期几天算逾期」「差异多少条才告警」「Top 取几名」全部外置:

- 每个阈值一个环境变量,带默认值:`OVERDUE_DAYS=7`、`PATROL_ALERT_MIN_COUNT=3`;
- runbook 巡检任务表登记「env 键名=默认值」(见 `/operate-agent`),调阈值改 env 重启即可,**不改代码不发版**;
- 误报处理 SOP 的第一动作就是调阈值——阈值硬编码时,每次误报都变成一次代码变更。

## 5. 推送纪律

- 巡检结论推送到蓝图指定渠道(IM 群 / 邮件),遵守渠道长度预算(见 `channels.md`),超长自动降级为「总览 + 明细链接/附件」。
- **无异常也要发心跳**(如「本日巡检:无逾期新增」),否则「没消息」无法区分「没问题」和「巡检挂了」。
- 推送带数据区间与运行时间戳,方便事后对账「这条告警基于哪天的数据」。

## 反例

- **反例 1:巡检复用交互式会话。** 周一的结论留在上下文里,周二模型「延续」了周一的判断,漏报新增逾期。守卫:临时实例。
- **反例 2:任务提示词只有一句话目标。** 每天的输出结构都不一样,渠道格式化时好时坏,没法 diff 环比。守卫:编号步骤 + 钉死输出格式。
- **反例 3:catch 里只 log 不通知。** 巡检因后端接口改版连挂两周,无人察觉,直到客户先发现逾期。守卫:失败必须推送告警;runbook 把「告警数骤降为 0」本身列为异常信号。
