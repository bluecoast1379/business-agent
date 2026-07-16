# Scaffold 指南:架构、模块职责与扩展

`scaffold/` 是一个零依赖(Node 22+,ESM,Node 内置模块 + 全局 `fetch`)的业务 agent 网关骨架。`/scaffold-gateway` 命令把它复制为目标工作区的 `agent-gateway/` 并按蓝图定制;你也可以直接在副本上手工开发。development profile 提供可离线运行的 mock 体验,production profile 强制 principal/RBAC、持久化 state、durable scheduler 与 fail-closed 配置。本文讲清楚结构、职责边界与常见扩展;完整生产清单见 [生产运行指南](./production-profile.md)。

## 架构总览

```
                         ┌────────────────────────────────────────────┐
   外部调用方             │              agent-gateway                 │        既有后端
                         │                                            │
 HTTP 客户端 ──/chat──►  │  channels/http.js ──┐                      │
 (Bearer token)          │  channels/webhook.js┼─► agents/registry.js │
 入站 webhook ──验签──►  │  (统一 handleMessage)│        │             │
                         │                     │        ▼             │
 定时触发 ───────────►   │  runtime/scheduler ─┘  runtime/agent.js    │
                         │                        (tool-call 循环)    │
                         │                          │         │       │
                         │              providers/*      toolpacks/* ─┼──fetch──► BACKEND_URL
                         │       (anthropic|openai|mock)    │          │      (最小权限凭证,
                         │                                 ▼          │       后端鉴权照常生效)
                         │              guardrails/scoped-tool.js     │
                         │              guardrails/confirm-gate.js    │
                         │                                            │
                         │  横切:auth/quota · durable state/execution │
                         │       telemetry/audit · dashboard · evals │
                         └────────────────────────────────────────────┘
```

这是**旁路网关**模式:agent 网关是一个独立 Node 服务,通过 HTTP 调用既有后端,不嵌进后端进程、不直连数据库、不绕过后端自身的鉴权。交互式(HTTP 对话)与批处理(定时巡检)双入口共用同一条 `handleMessage` 心跳。

## 模块职责

| 模块 | 职责 | 边界 |
| --- | --- | --- |
| `src/config.js` | 读环境变量并校验 | **fail-fast**:必填项缺失直接抛错退出;无任何默认密钥 / 默认内部地址 |
| `src/runtime/llm.js`、`src/providers/` | Provider contract,内置 Anthropic / OpenAI-compatible / Mock,归一 tool calls、usage 与 stream | 只管一次补全;不管循环、预算、会话 |
| `src/runtime/agent.js` | `createAgent(...)`:tool-call 循环、轮数上限、预算折算、逐轮 usage、abort 传播 | 不认识 HTTP;渠道无关 |
| `src/runtime/tool.js`、`src/tools/` | 参数 schema + mandatory policy manifest + principal/tenant tool registry | policy 或 output schema 缺项 fail closed |
| `src/auth/` | principal、Bearer authenticator、route authorizer、tenant quota | 认证、角色、scope、租户四层独立判断 |
| `src/stores/` | memory/file adapter 的统一 JSON contract;事务、CAS、分页、锁、checksum、显式 migration | file 支持同主机多进程(`multiProcess: true`),不支持多主机(`multiHost: false`) |
| `src/runtime/execution/` | timeout/cancel、bounded retry、circuit breaker、bulkhead、idempotency、dead-letter | 非安全/非幂等调用不自动重试 |
| `src/runtime/session-store.js` | 会话 facade、TTL 与持久化 adapter | production 接统一 state store |
| `src/runtime/cost-tracker.js` | `trackUsage / getMonthlyCost / isOverBudget / summary` | 由 `agent.js` **每次调用**接线——「定义了但没接线」是十大事故之一 |
| `src/schedulers/` | local/durable scheduler;missed-run、lease/fencing、dedupe、retry、dead-letter | durable 的多实例能力取决于 state driver |
| `src/channels/http.js` | `GET /health`(无鉴权)、`POST /chat`、`POST /chat/stream`(SSE,JSON body)、`GET /status`、`GET/POST /confirmations*`(人工审批)、`POST /jobs/:name/run`、`POST /webhook/reconciliation` | 除 health/webhook 外验证 Bearer principal,再按 route role + scope 授权；manual job 强制 `Idempotency-Key`，chat 同 key 绑定 principal/route/body |
| `src/channels/webhook.js` | 入站 webhook:HMAC 验签→可持久化 replay state machine→隔离 session→同一 `handleMessage`;已提交完整 reply 仅作进程内缓存,持久化层只存摘要 | 验签失败、running 过期、进程重启后 committed 重放、容量用尽均 fail closed;恢复必须走带 scope 的 operator reconciliation |
| `src/guardrails/scoped-tool.js` | `withScope(tool, scope)`:强制注入隔离参数,外部同名参数被覆盖 | 硬约束;模型生成什么参数都盖掉 |
| `src/guardrails/confirm-gate.js` | `createConfirmationCenter()` + `wrapWriteTool(tool, { center, summarize })`:参数化写操作强制脱敏 review projection + args/review digest，人工带外审批后才执行 | 禁止盲审批；credential-shaped args 落盘前拒绝，summary 在中心边界再次脱敏 |
| `src/agents/registry.js` | 装配交互 agent 与巡检 agent,暴露统一 `handleMessage(sessionId, message)` | 新 agent 在此注册 |
| `src/agents/assistant.js` | demo 交互 agent:系统提示词 = 角色 + 能力 + 术语表(从 `knowledge/glossary.md` **运行时读取注入**)+ 规则;当前日期每次求值 | 术语表改文件即生效,不改代码 |
| `src/agents/patrol.js` | demo 巡检:查数据找异常(阈值来自环境变量)→ 推送 | 阈值外置,调阈值不发版 |
| `src/toolpacks/demo/` | Brewline 合成数据 + 6~8 个只读工具(summary/raw 双形态)+ 1 个写工具(演示 confirm-gate) | 教学用;真实 toolpack 参照其形状新建 |
| `src/observability/` | telemetry off-by-default、OTLP/HTTP JSON、redaction 与 hash-chain audit | prompt、凭证、tool payload 不进入 exporter |
| `src/evals/` | JSONL dataset、grader、slice/threshold gate、脱敏 trace export | CI 固定 mock provider 保持可复现 |
| `src/dashboard/` | 只读 HTML/API、逐页 capability、服务端脱敏与分页 | 仅 GET/HEAD,不承载审批或配置写入 |
| `src/workflows/` | versioned workflow engine、checkpoint、interrupt/resume、handoff | 运行状态通过 store 持久化 |
| `src/knowledge/` | 运行时注入的知识文件(术语表) | 业务口径的唯一事实源 |
| `bin/chat-repl.js` | CLI REPL,直连 `registry.handleMessage` | mock provider 下无密钥可玩 |
| `smoke.js` | `npm run smoke`:不起端口的内部自检(对话一轮、confirm-gate 两段、scheduler 单 tick、cost > 0) | 改完必跑 |

## 运行方式

```bash
# mock provider,无需密钥
LLM_PROVIDER=mock GATEWAY_AUTH_TOKEN=development-token PORT=8787 node src/index.js

# CLI REPL / 内部自检
LLM_PROVIDER=mock GATEWAY_AUTH_TOKEN=development-token node bin/chat-repl.js
npm run smoke

# 真实 provider:复制 .env.example 为 .env,填 LLM_PROVIDER 与 LLM_API_KEY
npm start
```

配置项以 `scaffold/.env.example` 为准。Provider 支持 `anthropic|openai-compatible|mock`;production 还要求 `AUTH_PRINCIPALS_JSON`、durable state 与 durable scheduler。`GATEWAY_AUTH_TOKEN` 只保留为 development/legacy admin 迁移入口。

## Production profile 的装配边界

`RUNTIME_PROFILE=production` 会拒绝 memory state、local scheduler、空 principals，以及未给 `LLM_MODEL` / `LLM_COMPLEX_MODEL` 逐个提供精确 `LLM_PRICE_TABLE_JSON` 条目的配置。内置 file adapter 使用同目录 `wx` 排他锁协调同主机进程,并以 checksum + fsync + atomic rename 持久化;它声明 `multiProcess: true`,`multiHost: false`。多个本机进程可以共享一个 state 文件,但跨主机、跨节点容器或共享网络文件系统必须注入通过同一 contract/conformance tests 的事务/CAS driver。

运行时将 session、run、confirmation、cost、job、audit、idempotency 与 dead-letter 统一放入 state contract。工具执行的 timeout/cancel/retry/idempotency 与 scheduler lease/fencing 共同解决进程重启、重复提交和失败隔离；write/workflow/job handler 的普通异常默认 unknown，只有明确 `unknownOutcome:false` 的已知拒绝可重试。job timeout 或 running lease 过期进入 reconciliation，不能 takeover 重放潜在外部 effect。短期 idempotency response 会在启动和全局管理/容量/新 claim 路径按期清除正文，保留 tombstone。写操作必须人工审批且要求幂等键。

Telemetry 默认关闭。显式开启时必须配置 OTLP endpoint,导出前经过 allowlist 与 redaction；HTTP 只导出模板 route 和服务端 request id，API/SSE 默认 `no-store`。production 非 loopback `HOST` 必须声明可信 HTTPS ingress，`BACKEND_URL`/notify/LLM/OTLP 的非 loopback 地址必须 HTTPS。Audit 通过 chain-head checkpoint O(1) 定位链头且有硬容量；tool/agent/webhook/scheduler/管理写 effect 先原子追加 `started` 事件，以实际记录而不是先查容量的方式预留槽位。满载或审计不可用时 effect 不启动；预算/配额拒绝和未认证请求不占槽。scheduler 的自动 tick 与 manual run 共享同一 guard。归档/轮换保留完整链，不静默删除。dashboard 对 off/disabled 状态如实展示,不会替用户启用采集。Dashboard 只接受 GET/HEAD,并要求 operator/admin/auditor、`dashboard:read` 与页面 scope。状态 migration 只向前、缺步骤或较新 schema fail closed;应用/数据回滚流程见 [生产运行指南](./production-profile.md#6-状态迁移与回滚)。

## 扩展一:接真实后端

demo toolpack 用内存合成数据;接真实后端 = 新建一个 toolpack,工具 handler 里用 `fetch` 调 `BACKEND_URL`:

1. 新建 `src/toolpacks/<slug>/index.js`,按 `01-tool-contracts.yaml` 逐条 `defineTool`——description 面向 LLM 描述返回内容,params 带类型与 required;
2. handler 内 `fetch(config.backendUrl + path, { headers: { Authorization: Bearer ${config.backendApiKey} } })`;凭证只从 config 取,config 只从环境变量取;
3. 返回**summary 优先**:默认给「前 N 条 + 聚合统计 + 一行 hint」,`mode: raw` 才透传原始结构；OpenAPI/MCP adapter 还会统一执行 bytes/depth/node 边界，driver 原始异常 message 不进入 LLM transcript;
4. 写操作工具用 `wrapWriteTool(tool, { center, summarize })` 包确认闸；`summarize` 只挑选审批必要字段并脱敏，不得序列化整包 args；隔离参数用 `withScope` 强制注入；
5. 数据库查询工具除了静态 SELECT 检查，还必须由数据库 adapter 声明并实现只读事务能力；数据库账号本身使用只读角色；
6. 在 `agents/registry.js` 把新 toolpack 挂给对应 agent,`npm run smoke` 通过后,再用 mock provider 手工过一遍 REPL。

后端侧配合:为网关签发**最小权限、只读优先**的专用凭证,不要复用管理员凭证——「默认最高权限角色」是十大事故之一。

## 扩展二:换 LLM provider

Provider 接口只有一个方法:

```
complete({ model, system, messages, tools, maxTokens })
  → { stopReason, text?, toolCalls?, usage }
```

Anthropic 与 OpenAI-compatible 已内置;后者调用 `<LLM_BASE_URL>/v1/chat/completions`,归一 JSON/SSE、tool calls 与 usage。新增 provider 时在 `src/providers/` 实现同一 contract 并由 factory 分发。注意:`usage` 必须如实返回,否则预算折算失真;新 provider 的单价表通过环境变量覆盖,不硬编码价格。`MockProvider` 的确定性行为被 smoke/eval gate 依赖,不要改动其契约。

## 扩展三:加渠道

渠道适配器的职责是「把外部消息变成 `handleMessage(sessionId, message)` 调用,把回复按渠道格式化后发回去」:

1. 入站:参照 `channels/webhook.js`——先**验签**(HMAC 或渠道方案),再提取文本与会话标识;未验签即信任入站消息是十大事故之一;
2. 出站:实现 formatter——每个渠道有自己的长度预算与格式(IM 卡片、纯文本、markdown 子集),超长先截断再发;
3. 复用同一 `handleMessage` 心跳,不要为新渠道另起一条 agent 调用路径——护栏(预算、确认闸)都挂在心跳上,绕开心跳等于绕开护栏。

Webhook replay ledger 是 `running / committed / failed / unknown` 四态机。`running` 过期只能转 `unknown`,不能自动重放;`committed` 持久化记录不得包含完整 reply。进程重启后的 committed 重复事件和 unknown 事件均需人工对账。`POST /webhook/reconciliation` 要求 operator/admin + `webhooks:reconcile`;租户 principal 不得读取网关级 ledger,除非另有 `webhooks:cross-tenant`。管理 API 只按调用方已知 eventId 查询,不列出或回显 raw eventId;`retry / mark-committed / forget` 都要求 `expectedPayloadHash` + `expectedStatus` 同时匹配且给出精确风险确认,因此 inspect 后发生状态竞争的旧指令会被拒绝。ledger 有界(默认 10,000 条),满载时拒绝新事件;`compact` 只删除已过期的 failed 记录,不会隐式删除 committed/unknown 证据。

## 改动后的最低验证

任何改动至少跑 `npm test` 与 `npm run smoke`(scaffold 内)。若修改 kit 内置 scaffold 本体,仓库根还必须跑 `npm run check`;它会覆盖 runtime/security tests、adapter/template conformance、deterministic eval、HTTP smoke 与 release gate。接入真实密钥前,先确认 `.env` 已被 `.gitignore` 覆盖；使用 file state 时还必须用 `git check-ignore scaffold/local/state.json scaffold/local/state.json.lock scaffold/local/.state.json.tmp-<pid>-<seq>` 确认 state 及其锁/临时产物不会被追踪。
