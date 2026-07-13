# 旁路网关架构(Gateway Architecture)

业务 agent 的推荐落地形态不是「改造既有系统」,而是**旁路网关**:一个独立的 Node 服务,站在 LLM 与既有后端之间,双向都只走标准协议。既有系统一行代码不用改,agent 失败也不影响主业务——这是让第一个 agent 快速上线且可随时下线的关键。

## 核心原则

1. **独立进程、独立部署**:网关是单独的服务(scaffold 即此形态),不嵌进任何既有应用;它挂了,订单照下、账单照出。
2. **对后端只用 HTTP,走既有 API**:网关以普通 API 客户端身份调用后端,不直连数据库、不共享内存、不读内部消息队列。后端已有的鉴权、限流、审计对 agent 全部生效。
3. **token 透传与最小权限**:网关持有的后端凭证应是为 agent 单独申请的最小权限角色;能透传终端用户身份时优先透传(后端按真实用户鉴权),不能透传时按租户注入 scope。
4. **绝不绕过后端鉴权**:任何「为了让 agent 查得快」而开的后门(直连库、免鉴权内部端点)都等于把提示注入的爆炸半径扩大到全库。后端鉴权是数据隔离三层中唯一的真正边界(见 `guardrails.md`)。

## 分层结构

```
channels(HTTP / webhook / CLI)      ← 入口:鉴权、格式化、长度预算
        │  handleMessage(sessionId, message)
agents(assistant / patrol)          ← 提示词组装(运行时)、模型分档、预算
        │  tool calls
runtime(llm / agent / tool / session / cost-tracker / scheduler)
        │
guardrails(scoped-tool / confirm-gate)
        │  HTTP + least-privilege token
既有后端(订单服务 / 账务服务 / ...)   ← 真正的安全边界
```

依赖方向自上而下,后端对网关无感知。换 LLM provider、加渠道、加工具,都只动网关内部一层。

## 交互式 / 批处理双入口范式

同一套 agent 运行时,两种触发方式:

- **交互式(assistant)**:用户经 HTTP/IM 提问,会话由 session-store 维持(TTL 过期清理),多轮上下文复用。适合「Brewline 运营在群里问:云雾庄园这个月的订单额是多少」。
- **批处理(patrol)**:scheduler 定时触发,**每次创建临时 agent 实例**,跑结构化任务提示词(日期区间 + 编号步骤),结果推送到渠道后实例即弃。适合「每个工作日 9 点扫一遍逾期发票」。详见 `patrol-agents.md`。

两个入口最终都收敛到**统一心跳函数** `handleMessage(sessionId, message)`:鉴权之后、agent 之前的唯一入口。统一心跳的价值在于横切关注点只写一次——预算检查、成本上报、日志、错误兜底都挂在这一个函数上,新加渠道时不可能「忘了接成本追踪」(事故清单第 3 项)。

## 反例(真实教训的泛化)

- **反例 1:网关直连业务库查询「更快更省」。** 后果:提示注入一旦得手,SQL 拼进哪张表都可能;后端的行级权限、审计日志全部失效。守卫:只走 API;确需高效聚合查询时,让后端加一个带鉴权的聚合端点。
- **反例 2:每个渠道各写一条处理链。** IM 入口接了成本追踪,HTTP 入口忘了;IM 有预算熔断,定时任务没有——月底账单才发现巡检跑爆了。守卫:所有入口收敛到统一心跳函数,新渠道只写「格式转换」。
- **反例 3:系统提示词在模块顶层拼好当常量。** 长驻进程跑到第三天,agent 还坚信今天是上线日。守卫:提示词是函数,每次请求现组装(事故清单第 4 项)。
- **反例 4:demo 阶段网关与后端共用管理员 key,上线「回头再改」。** 从没有回头。守卫:第一天就用独立最小权限凭证,demo 用 mock 数据即可。

## 统一心跳函数的最小契约

```js
// the single funnel between channels and agents;
// every cross-cutting concern hangs here exactly once
async function handleMessage(sessionId, message) {
  assertBudget();                          // monthly circuit breaker
  const session = sessions.getOrCreate(sessionId);
  const agent = registry.resolve(session); // assistant or patrol task
  const reply = await agent.prompt(message, { sessionMessages: session.messages });
  // usage is reported inside the agent loop per turn; nothing to remember here
  session.append(message, reply);
  return reply;
}
```

契约要点:入参只有会话标识与文本(渠道细节在适配器层就消化掉);出参是纯文本/结构化回复(渠道各自渲染);预算检查在最前(超限时任何渠道都熔断);会话读写只发生在这一层,agent 本身无状态。

## 上线形态建议

- 单实例起步足够(session 在内存,多实例需要外置会话存储,首版不做);先跑通、有真实用量,再谈扩容。
- 对外暴露面最小化:`/health` 无鉴权,其余端点一律 Bearer token(事故清单第 5 项)。
- 网关自身日志只记消息摘要与工具调用名,不落全量业务数据,避免网关变成新的敏感数据副本。
- 演进路径:mock provider 跑通全链路 → 换真实 provider + demo 数据 → 接第一个真实只读后端 → 才考虑写工具与新渠道。每一步都保持可整体回退(网关下线即恢复原状,这正是旁路的意义)。
