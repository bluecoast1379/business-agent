# agent-gateway-scaffold

零依赖的业务 AI Agent 网关骨架:纯 Node 22+ ESM,`node:http` 提供 HTTP/SSE 与只读运维 dashboard,全局 `fetch` 调用 Anthropic 或 OpenAI-compatible API,内置确定性 MockProvider 可完全离线跑通。development profile 用于本地体验；production profile 强制 principal/RBAC、持久化 state 与 durable scheduler。示例业务域为虚构的精品咖啡豆 B2B 供应商 **Brewline**(客户=咖啡馆),替换 toolpack 即可接入你的真实业务。

## 架构

```
        ┌────────────────────────── agent-gateway ──────────────────────────┐
        │                                                                   │
 HTTP   │  channels/http.js ───┐                                            │
 SSE    │  (Bearer 鉴权)       │        registry.handleMessage(统一心跳)     │
        │                      ├──▶ agents/registry.js ──▶ agents/assistant │
 入站    │  channels/webhook.js─┘         │   (session 复用)      │          │
 webhook│  (HMAC-SHA256 验签)            │                       ▼          │
        │                                │                runtime/agent.js  │
        │  schedulers/local|durable ▶ agents/patrol.js     (tool-call 循环)  │
        │  (lease/fencing + 补跑)    (巡检,阈值 env 外置)     │        │       │
        │                                                  ▼        ▼       │
        │                                        providers/*     toolpacks/ │
        │                                  Anthropic|OpenAI|Mock demo(8 工具)│
        │                                             │              │      │
        │  guardrails: confirm-gate(写确认)           │              │      │
        │             scoped-tool(租户绑定)     runtime/cost-tracker.js      │
        │  stores/*(持久状态) · auth · telemetry · audit · dashboard         │
        └───────────────────────────────────────────────────────────────────┘
                       │                                    │
                  LLM API(fetch)                 你的业务后端(可选 BACKEND_URL)
```

## 模块职责

| 模块 | 职责 |
| --- | --- |
| `src/index.js` | boot:loadConfig → buildRegistry → startHttp → startScheduler;成功后 stdout 打印 `listening on <端口>` |
| `src/config.js` | 环境变量配置,fail-fast:缺必填直接抛错并给修复指引;无任何内置密钥/内部域名默认值 |
| `src/runtime/llm.js`、`src/providers/` | 统一 `complete()` contract;Anthropic、OpenAI-compatible(`/v1/chat/completions`)与确定性 Mock;工具调用、usage、stream 归一化 |
| `src/runtime/agent.js` | tool-call 循环:maxTurns 上限、每轮 usage 上报、request abort 传播、超单次预算中断并返回已得内容 |
| `src/runtime/tool.js`、`src/tools/` | schema 校验 + policy manifest;audience/tenant/effect/approval/idempotency/timeout/audit/output schema 缺项 fail closed |
| `src/stores/` | session/run/confirmation/cost/job/audit/idempotency/dead-letter 的统一异步契约;memory 与同主机多进程 file adapter;事务、CAS、锁、checksum、显式迁移 |
| `src/runtime/execution/` | timeout/cancellation、bounded retry、circuit breaker、bulkhead、idempotency 与 dead-letter |
| `src/runtime/session-store.js` | 会话 facade;development 可用 TTL memory,production 接 state store 持久化;默认最多 10,000 条且满载 fail-closed,TTL sweep 完整分页并跳过活跃 lease;运维仅通过 `capacitySnapshot`/`listMetadata`/`reconcile`/`prune` 读取摘要化 ID 与无正文 metadata |
| `src/runtime/cost-tracker.js` | 月度成本聚合(`/status` 与调度预算守卫读取的是真实接线数据) |
| `src/schedulers/` | local 与 durable scheduler;durable 支持 missed-run policy、lease/fencing、去重、重试与 dead-letter |
| `src/auth/` | Bearer principal 认证、角色/scope/tenant 授权与逐租户 rate/concurrency quota |
| `src/channels/http.js` | `/health`(免鉴权)、`/chat`、`/chat/stream`(SSE)、`/status`、`/confirmations`、`/jobs/:name/run`、`/webhook/reconciliation`;按 route role + scope 授权；chat 可用、manual job 必须用可信 `Idempotency-Key` |
| `src/channels/webhook.js` | 通用入站 webhook:时间戳 HMAC-SHA256 验签、可持久化四态 replay ledger、有界容量与显式 reconciliation;持久化层只存 payload/response 摘要,完整回复仅存当前进程内存 |
| `src/guardrails/confirm-gate.js` | 写工具带外人工确认:参数化写工具必须提供脱敏 review projection；首调返回摘要、args/review digest 与 `confirmationId`;**人**经带外端点审批后凭 id 二调才执行；credential-shaped args 直接拒绝 |
| `src/guardrails/scoped-tool.js` | `withScope` 强制注入参数(如 customerId),覆盖外部同名传参,防越权;`runtime/tool-policy.js` 对 manifest 缺项 fail-closed，并从 customer mode 排除仅限 operator 的全局工具 |
| `src/agents/registry.js` | 装配 assistant(交互)+ patrol(批处理);统一心跳 `handleMessage` |
| `src/agents/assistant.js` | 系统提示词**每次请求组装**(日期实时求值;术语表从 `src/knowledge/glossary.md` 运行时读取) |
| `src/agents/patrol.js` | demo 巡检:逾期发票/供应商准时率/延迟配送 → 控制台或出站 webhook 推送;阈值来自 env |
| `src/toolpacks/demo/` | Brewline 合成数据 + 7 个只读工具(summary/raw 双形态)+ 1 个写工具(演示 confirm-gate) |
| `src/observability/` | telemetry 默认 off;OTLP/HTTP JSON exporter、attribute allowlist/redaction 与 append-only hash-chain audit |
| `src/evals/` | JSONL dataset loader、deterministic grader、slice/threshold gate 与脱敏 trace export |
| `src/dashboard/` | operator/admin/auditor 只读视图;server-side redaction、cursor pagination、telemetry off/unavailable 状态 |
| `src/workflows/` | versioned workflow state machine、checkpoint、interrupt/resume 与 human handoff |
| `bin/chat-repl.js` | 本地 REPL,直连 handleMessage,mock 下可离线玩 |
| `smoke.js` | 不起端口的内部自检(`npm run smoke`) |

## 快速开始(mock,三分钟)

```bash
# 1. 准备配置(mock 无需任何密钥)
cp .env.example .env
# 编辑 .env:LLM_PROVIDER=mock,GATEWAY_AUTH_TOKEN=development-token

# 2. 起服务(或直接用环境变量,不写 .env 也行)
LLM_PROVIDER=mock GATEWAY_AUTH_TOKEN=development-token node src/index.js
# stdout: listening on 3000

# 3. 另开终端验证
curl -s http://127.0.0.1:3000/health
# {"status":"ok",...}

curl -s -X POST http://127.0.0.1:3000/chat \
  -H 'Authorization: Bearer development-token' -H 'content-type: application/json' \
  -H 'Idempotency-Key: demo-chat-001' \
  -d '{"sessionId":"demo","message":"top customers"}'
# reply 含 "[mock] top customers: Top 5 customers ..."(mock 先调了 get_top_customers 再回答)

curl -s http://127.0.0.1:3000/status -H 'Authorization: Bearer development-token'
# activeSessions / monthlyCostUsd(真实累计)/ budget / jobs

curl -s -X POST http://127.0.0.1:3000/jobs/daily-patrol/run -H 'Authorization: Bearer development-token'
# 手动触发巡检,报告打印到服务端控制台

curl -sN -X POST http://127.0.0.1:3000/chat/stream \
  -H 'Authorization: Bearer development-token' -H 'content-type: application/json' \
  -H 'Idempotency-Key: demo-stream-001' \
  -d '{"sessionId":"demo","message":"hello"}'
# SSE 逐段推送
```

`GET /chat/stream?sessionId=...&message=...` 默认禁用并返回 `405`，避免
prompt 与 session id 进入 URL、代理访问日志或浏览器历史。

其它两个入口:

```bash
npm run smoke   # 内部自检(不起端口):mock 回路 / confirm-gate / scheduler / cost>0
npm run chat    # 本地 REPL(LLM_PROVIDER=mock 可离线玩)
```

注意:`.env` 不会被自动加载(零依赖),用 `export $(grep -v '^#' .env | xargs)` 或直接以环境变量方式启动;`.env` 已被 `.gitignore` 忽略,绝不提交。当 `STATE_ADAPTER=file` 且未改写 `STATE_FILE_PATH` 时,默认状态位于 `local/state.json`;整个 `/local/` 目录已被根定位忽略,同目录的 lock、tmp、reaper 和人工备份也不得进入版本库。

## 生产 profile

生产环境至少需要 `RUNTIME_PROFILE=production`、非空 `AUTH_PRINCIPALS_JSON`、`STATE_ADAPTER=file`(或外部 conformance driver)与 `SCHEDULER_ADAPTER=durable`。每个 principal 显式绑定 `subjectId`、`tenantId`、`roles` 与 `scopes`;旧 `GATEWAY_AUTH_TOKEN` 只作为 legacy admin 迁移凭证。若 `HOST` 不是 loopback，还必须设置 `TLS_TERMINATED_BY_TRUSTED_PROXY=true`，且 Node 端口只能由该可信私网 HTTPS ingress 访问，不能把明文 listener 直接暴露公网。production 的 `BACKEND_URL`、`NOTIFY_WEBHOOK_URL`、LLM 与 OTLP 非 loopback 地址都强制 HTTPS。

内置 file state 通过 `wx` 排他锁、checksum、fsync 与 atomic rename 支持同主机多进程共享写与重启恢复(`multiProcess: true`,`multiHost: false`)。跨主机、容器跨节点或共享网络文件系统部署必须换用具备事务/CAS/多主机一致性并通过 conformance tests 的外部 driver。Telemetry 默认 `false`;只有显式设置 `TELEMETRY_ENABLED=true` 与 `OTEL_EXPORTER_OTLP_ENDPOINT` 才会创建 exporter 流量。Audit 有 O(1) chain-head checkpoint 和 `AUDIT_MAX_RECORDS` 硬上限；tool/agent/webhook/scheduler/管理写操作先以原子 `started` 记录占槽，满载时在外部 effect 前拒绝，预算/配额拒绝和未认证请求不占槽。scheduler 的自动 tick 与 manual run 使用同一 guard。满载不删证据，需停写、校验、完整归档后轮换 state。Dashboard 只读且不会隐式打开 telemetry。

生产配置、路由 RBAC、OpenAI-compatible 接入、durable scheduler、eval gate、迁移与回滚完整说明见 [生产运行指南](../docs/production-profile.md)。

## 接真实 LLM

```bash
LLM_PROVIDER=anthropic LLM_API_KEY=<你的key> GATEWAY_AUTH_TOKEN=<随机串> node src/index.js
```

OpenAI-compatible 入口:

```bash
LLM_PROVIDER=openai-compatible LLM_BASE_URL=https://api.openai.com \
  LLM_API_KEY=<你的key> GATEWAY_AUTH_TOKEN=<随机串> node src/index.js
```

可选:`LLM_MODEL`(默认 `claude-sonnet-4-6`)、`LLM_COMPLEX_MODEL`、`LLM_PRICE_TABLE_JSON`(成本折算单价);production 则必须为两个实际模型 id 提供精确价格条目。OpenAI-compatible base URL 不要包含尾部 `/v1/chat/completions`,runtime 会自动追加。真实 provider 成功响应上限为 4 MiB;usage、stop reason 和 tool call 通过统一响应契约后才进入执行链。自动 provider retry 默认关闭；显式启用时也只重试可证明未执行的限流/too-early 拒绝，HTTP 5xx、网络中断和超时一律按未知成本处理且不 fallback。

## 接真实业务后端

demo toolpack 全部读内存合成数据。接真实后端的路径:

1. 新建 `src/toolpacks/<你的域>/index.js`,照抄 demo 的形态:`defineTool` 定义 name/description/params,handler 里用 `fetch` 调你的后端(`BACKEND_URL`/`BACKEND_API_KEY` 从 config 读,绝不硬编码);
2. 保持 **summary/raw 双形态**:默认返回给 LLM 的是紧凑摘要(省 token),raw 仅作逃生舱；OpenAPI/MCP adapter 默认再限制 4 MiB、JSON depth 32 和 100,000 nodes;
3. **读优先**:所有写操作必须用 `wrapWriteTool` 包一层人工确认;多租户场景用 `withScope` 把租户 id 绑死;
4. 在 `src/agents/registry.js` 把 `buildDemoTools()` 换成(或合并)你的 toolpack;
5. 权限:网关调用后端所用的凭证应是**最小权限角色**,后端自身鉴权绝不能因为网关而绕过。

## 新增渠道

任何渠道最终都只做三件事:收文本 → `registry.handleMessage(sessionId, text)` → 按渠道格式化回复(参考 `channels/webhook.js` 的 formatter:长度截断/富文本适配)。入站推送类渠道务必验签(HMAC 示例已给);轮询类渠道自己起定时器即可。新文件放 `src/channels/`,在 `src/index.js` 装配。

### Webhook replay 与人工 reconciliation

- 同一进程内的并发重复会合并等待唯一执行,已提交事件的重复请求也可返回完整缓存回复;持久化状态只保留 SHA-256 摘要、HTTP 状态和时间证据,不写入 reply/业务结果。进程重启后遇到 committed 重放会返回 `WEBHOOK_COMMITTED_RECONCILIATION_REQUIRED`,绝不猜测或再执行。
- running lease 过期原子转为 permanent `unknown`;既不按 TTL 自动删除,也不自动重放。ledger 默认最多 10,000 条;容量用尽返回 `WEBHOOK_REPLAY_CAPACITY`(503),先对账再恢复。
- `POST /webhook/reconciliation` 仅允许 operator/admin 且必须具有 `webhooks:reconcile` scope;租户 principal 还必须显式具有 `webhooks:cross-tenant`,否则拒绝。API 不提供 eventId 列表,不回显 raw eventId,只返回摘要。
- 支持 `inspect`、`retry`、`mark-committed`、`forget`、`compact`:`retry` 仅能把 unknown 转为可重试,`mark-committed` 需外部对账证据摘要,`forget` 会重新打开重放可能性。变更动作同时需匹配 `expectedPayloadHash`、`expectedStatus` 与精确风险确认字符串, 用 CAS 拒绝 inspect 后状态已变的旧指令。确认字符串为:`I_VERIFIED_RETRY_IS_SAFE`、`I_VERIFIED_SIDE_EFFECT_COMMITTED` 或 `I_ACCEPT_DUPLICATE_DELIVERY_RISK`。`compact` 只清理已过期的 retryable failed 记录,不清理 committed/unknown。

## 新增巡检任务

写一个 `{ name, schedule: {minute, hour, dayOfWeek?, dayOfMonth?}, timeoutMs, idempotency, run }` 描述对象(参考 `src/agents/patrol.js`),在 registry 的 `jobs` 数组里加上即可。production 使用 durable scheduler,并为任务选择 `skip|coalesce|catch-up` missed-run policy 与最大尝试次数；`run({ signal, idempotencyKey })` 必须把取消和稳定 key 继续传给外部 sink。timeout 或 running lease 过期进入永不自动重放的 `reconciliation_required`，不会 takeover；已知失败达到上限才先持久化 `dead_lettered` 终态再进入 dead-letter。内置 file store 支持同主机多进程 scheduler 争抢,跨主机仍需外部 driver。`POST /jobs/<name>/run` 可手动触发,但需要 operator/admin 与 `jobs:run`。

durable ledger 的隐私默认是只保存 result 类型而不保存完整 result；如果构造 scheduler 时显式设置 `resultRetentionMs`，可在有字节上限的短时间内用 `listExecutions({ includeResult: true })` 读取，到期后会 compact。ledger 默认上限 10,000 条；满载时新执行拒绝运行，必须通过 `reconcileExecution()` 处理未知结果，并用显式承担 replay risk 的 `pruneExecutions()` 释放终态记录。系统不允许 prune `running`、`retry_wait` 和尚未 reconciliation 的记录。

## 护栏一览

- **fail-fast 配置**:缺必填环境变量直接拒绝启动,不给任何"能跑就行"的默认密钥。
- **鉴权**:除 `GET /health` 外按 principal role + scope 授权,token 用摘要 + 常数时间比较;入站 webhook 用 HMAC-SHA256 验签并绑定显式 principal。
- **配额**:按 tenant/subject 限制每分钟请求数与并发数,支持受控 tenant override。
- **持久化**:production 强制 durable state;confirmation/cost/job/audit/idempotency/dead-letter 共享统一 store contract。
- **审计 fail-closed**:受审计 effect 前先原子追加 metadata-only `started` 记录；该记录本身是容量预留，避免 TOCTOU。审计满载/不可用时 handler 不启动；completion append 失败只告警，不把可能已提交的 effect 伪装成可安全重试。
- **可靠执行**:超时/取消向下传播;自动重试仅用于 policy 允许的安全或幂等调用,并受 bulkhead/circuit breaker 约束。
- **预算双层**:`BUDGET_MAX_USD_PER_REQUEST` 超限中断单次 tool 循环;`BUDGET_MONTHLY_USD` 超限拒绝新会话、巡检跳过。成本来自每轮 usage × 单价表的真实累计。
- **写操作人工确认**:confirm-gate 两段式,id 一次性、15 分钟过期,二调执行的是首调存档的原始参数(防篡改)。
- **审批 ledger 隐私/容量**:persistent confirmation 默认上限 10,000 条，满载拒绝新审批，不驱逐未过期的 pending/approved 或可能已产生副作用的 executing/reconciliation_required。管理 `list()` 与程序化 `listMetadata/capacity/reconcile/prune` 仅返回 metadata，不返回原始 args；`prune` 按 cursor/limit 有界续传。
- **数据隔离**:scoped-tool 在工具层强制注入租户参数;提示词层只写规则不写密钥;后端层保持自身鉴权。
- **隐私默认**:telemetry 默认 off;启用后仍只导出 allowlist 脱敏元数据;dashboard 只读且不改变采集状态。
