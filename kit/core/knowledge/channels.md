# 渠道适配(Channels)

渠道层解决「agent 的回答如何进出各个界面」:HTTP API、IM 群机器人、邮件、CLI。设计原则只有一条:**渠道只做格式与传输,业务全部收敛到统一心跳函数** `handleMessage(sessionId, message)`(见 `gateway-architecture.md`)。

## 1. Channel 适配器接口

每个渠道实现同一组最小接口:

```js
// a channel adapter only translates; it never talks to agents directly
const channel = {
  name: "im-group",
  // inbound: verify -> extract -> normalize -> handleMessage
  async onInbound(rawRequest) {
    verifySignature(rawRequest);            // reject on failure, 4xx
    const { sessionId, text } = extract(rawRequest);
    const reply = await handleMessage(sessionId, text);
    return this.format(reply);
  },
  // outbound: format + truncate per channel budget
  format(reply) { /* channel-specific rendering */ },
};
```

新加渠道 = 写一个适配器,不碰 agents / runtime / guardrails。判断适配器是否「薄」的标准:删掉它,agent 的行为与安全性完全不变。

## 2. 消息长度预算

每个渠道有硬性或体验性的长度上限(IM 单条消息、邮件摘要区、短信更极端)。适配器为渠道声明**长度预算**,超预算时按固定策略降级,而不是让消息被渠道截断到半句话:

1. 优先保留结论与关键数字(「逾期 37 张、合计 8.4 万」);
2. 明细降级为「前 N 条 + 『其余见附件/链接』」;
3. 表格在纯文本渠道转为「每行一条」的紧凑列表。

配套地,把渠道长度预算告知 agent(系统提示词或工具 hint 里注明「回答将推送到 IM,正文控制在 X 字内」),从生成端就控制,比事后硬截好得多。

反例:巡检报告在网页端调得很完美,接入 IM 群后每天被截断在表头,运营看了两周「空报告」才反馈——适配器没有长度预算,生成端也不知道渠道限制。

## 3. 入站 webhook 验签

IM / 第三方平台回调进来的消息,**验签是第一行代码**(事故清单第 8 项):

- 用渠道方规定的算法(常见 HMAC-SHA256)校验签名,secret 来自环境变量,绝不硬编码;
- **验签失败必须 4xx 拒绝并告警**,不允许「失败仅 log、继续处理」的降级写法——那等于没验;
- 有时间戳的协议要校验时间窗防重放;消息体加密的渠道,解密失败同样拒绝;
- 渗透用例:伪造签名、重放旧请求,断言均被拒(`/harden-agent` §4)。

记住威胁模型:webhook URL 一旦泄露(日志、代理、渠道方事故),没有验签的入口等于把 `handleMessage` 公开在互联网上——聊天鉴权做得再好也被绕过。

## 4. SSE 流式输出

交互式 HTTP 渠道建议提供 SSE(Server-Sent Events)端点,把 agent 的回答分段推送:

- 长回答(分析类、多工具调用)首 token 等待可能数秒,流式让用户看到进度,体感差异巨大;
- 实现要点:`Content-Type: text/event-stream`、逐段 `data:` 写出、结束发终止事件;工具调用期间可推送「正在查询订单数据…」的状态事件;
- **鉴权与非流式端点同规格**(Bearer token),SSE 不是鉴权豁免区;
- 中断处理:客户端断开时停止生成,已产生的 usage 照常上报 cost-tracker(钱已经花了,账要记上)。

不适合流式的渠道(IM 推送、邮件)就整段发送,不要为流式而流式。

## 5. 渠道选择的实务建议

- **第一个渠道选团队已经天天在用的**(多半是 IM 群):零迁移成本,用量数据真实;新开专属网页反而没人去。
- 交互式与巡检推送可以是**同一个群**:用户白天问,巡检早上推,agent 存在感与信任积累最快。
- 每个渠道的鉴权口径在 discovery 阶段登记(仅键名),渠道 secret 与 token 全部走 `.env`。

## 反例汇总

- 验签失败只打日志 → 伪造消息驱动写工具(未遂,被确认门拦住)——两层护栏救了一层的失误,但事故报告仍按「验签缺失」定级。
- 每个渠道各自直调 agent → 新渠道忘了接 cost-tracker,月成本统计缺口 40%。
- SSE 端点忘加鉴权 → 渗透用例第 2 组(无 token 裸调)当场抓出。渠道每多一个入口,`/harden-agent` 的端点清单就要同步多一行。
