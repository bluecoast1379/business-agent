# 生产运行指南

本指南说明 `scaffold/` 从本地 mock 演示切换到生产 profile 时必须满足的配置、权限、持久化、调度、可观测性与回滚要求。运行时要求 **Node.js 22 或更高版本**；仓库 CI 会在 Node 22、24、26（Linux）以及 Node 24（macOS/Windows）执行同一套检查。

## 1. 生产 profile 的最小配置

先从 `scaffold/.env.example` 复制配置，并通过部署平台的 secret/config 管理能力注入真实值；不要提交 `.env`。

```dotenv
RUNTIME_PROFILE=production
LLM_PROVIDER=openai-compatible
LLM_API_KEY=<由密钥管理系统注入>
LLM_BASE_URL=https://api.openai.com
LLM_MODEL=<已批准的模型 id>
LLM_PRICE_TABLE_JSON={"<已批准的模型 id>":{"inputPerMTok":<精确输入单价>,"outputPerMTok":<精确输出单价>}}

AUTH_PRINCIPALS_JSON=[{"token":"<由密钥管理系统注入>","principal":{"subjectId":"gateway-operator","tenantId":null,"roles":["operator"],"scopes":["chat:write","status:read","confirmations:read","confirmations:write","jobs:run","dashboard:read","runs:read","costs:read","evals:read","approvals:read","audit:read","system:read"]}}]

STATE_ADAPTER=file
STATE_FILE_PATH=/受控持久卷/business-agent/state.json
SCHEDULER_ADAPTER=durable

TELEMETRY_ENABLED=false
DASHBOARD_ENABLED=true

# 仅当 Node 监听地址只对可信私网 ingress 可达、且 ingress 已终止 HTTPS 时启用：
HOST=0.0.0.0
TLS_TERMINATED_BY_TRUSTED_PROXY=true
```

生产 profile 会在启动时拒绝以下组合：没有 `AUTH_PRINCIPALS_JSON`、使用内存 state、使用 local scheduler、每个 `LLM_MODEL` / `LLM_COMPLEX_MODEL` 没有精确单价，或启用 telemetry 却没有配置 `OTEL_EXPORTER_OTLP_ENDPOINT`。生产成本闸门不会对未知 deployment id 回退到通用默认价，避免因低估单价而绕过月度预算。`GATEWAY_AUTH_TOKEN` 只用于从旧版单 token 配置迁移的 admin 凭证；新的生产部署不要把它当作主体与租户权限模型。

部署前还应显式复核 `BUDGET_*`、`QUOTA_*`、`HOST`、`PORT`、会话 TTL、webhook 身份与巡检阈值。production 监听非 loopback `HOST` 时，必须设置 `TLS_TERMINATED_BY_TRUSTED_PROXY=true`，并确保 Node 明文端口只对该可信私网 ingress 可达；这不是允许直接暴露公网 HTTP。`LLM_BASE_URL`、`BACKEND_URL`、`NOTIFY_WEBHOOK_URL` 与 OTLP endpoint 在 production 对非 loopback 地址都必须使用无 URL credential/query/fragment 的 HTTPS URL。配置错误会 fail closed，而不是回退到一个可用密钥、内部地址或宽权限身份。

## 2. 身份、RBAC 与租户隔离

`AUTH_PRINCIPALS_JSON` 必须是一行 JSON 数组。每个元素由不可猜测的 Bearer token 和 principal 组成：

- `subjectId`：稳定的调用方标识，写入审计时会脱敏；
- `tenantId`：租户边界。跨租户访问默认拒绝；平台级操作员可设为 `null`，但仍受角色与 scope 限制；
- `roles`：`caller`、`operator`、`admin`、`service`、`auditor`；
- `scopes`：端点或 dashboard 的最小读取/执行权限。`admin` 与显式 `*` 会绕过逐项 scope 检查，只应授予受控应急身份。

HTTP 路由的默认策略如下：

| 路由 | 允许角色 | 必需 scope |
| --- | --- | --- |
| `POST /chat`、`POST /chat/stream` | caller / operator / admin | `chat:write` |
| `GET /status` | platform operator / admin / auditor | `status:read`；tenant principal 另需 `status:cross-tenant` |
| `GET /confirmations` | operator / admin | `confirmations:read` |
| `POST /confirmations/:id/approve`、`.../reject` | operator / admin | `confirmations:write` |
| `POST /jobs/:name/run` | platform operator / admin | `jobs:run`；tenant principal 另需 `jobs:cross-tenant` |

`POST /jobs/:name/run` 必须携带 1–128 字符的 `Idempotency-Key`。`POST /chat` 与 `POST /chat/stream` 强烈建议携带同一请求级 header；服务端按 authenticated principal + route 绑定 key 与请求摘要。同 key/同 body 在默认 5 分钟响应保留窗内返回原结果，同 key/不同 body 返回 `409`；窗口后只剩不可重放 tombstone，同样返回 `409` 并要求显式对账。到期正文会在启动、全局管理读取、容量检查或新 claim 时完整分页清除，即使该一次性 key 从未再次访问也不会无限留在 state/backup。服务端自行生成并返回 `x-request-id`；调用方提交的同名 header 不进入 telemetry、audit 或幂等计算。

所有 API JSON/SSE 响应默认携带 `private, no-store` 与 `nosniff`。HTTP server 显式限制 header/body 接收时间、keep-alive 与单 socket 请求数；鉴权失败等提前响应若尚有未读 body，会返回 `Connection: close` 并及时释放 socket，避免未认证 slow-body 长时间占用连接。

工具还会经过独立的 policy manifest：audience、tenant scope、数据分类、读写效果、人工审批、幂等性、超时、审计策略和输出 schema 任一缺失都拒绝装配。写工具必须同时声明人工审批和幂等键；审批信号走模型不可触达的带外管理端点。

## 3. 持久化与可靠执行

统一 state-store 契约覆盖 `session`、`run`、`confirmation`、`cost`、`job`、`audit`、`idempotency` 与 `dead-letter` namespace。内存与文件 adapter 使用相同的异步 JSON 契约、事务、CAS 与分页语义。

内置 `file` adapter 以同目录 `wx` 排他锁协调进程,每次变更写临时文件、`fsync`、原子 rename，并用 checksum 检测损坏；它支持同主机多进程并发与重启恢复(`multiProcess: true`)，但不承诺跨主机或共享网络文件系统一致性(`multiHost: false`)。跨节点横向扩容必须注入通过 store conformance tests 的事务/CAS driver，并验证其多主机能力。

本地以 scaffold 目录为 cwd 启动且未改写 `STATE_FILE_PATH` 时，file adapter 使用 `scaffold/local/state.json`。生成的 `scaffold/.gitignore` 会根定位忽略 `/local/`，从而同时覆盖 state、`.lock`、`.tmp-*`、`.reaper` 和 `.bak` 等运行时或备份产物。若将 `STATE_FILE_PATH` 改到 scaffold 之外，运维方必须在目标库和备份链路上建立等价的排除、权限与保留策略；不得依赖这条 scaffold 规则。

执行器对工具调用提供超时、取消、bulkhead、circuit breaker、幂等去重和 dead-letter。写工具、workflow node 与 scheduler job 一旦进入 handler，普通异常默认视为未知结果；只有 adapter 明确给出 `unknownOutcome:false` 的已知拒绝才可重试或进入普通 dead-letter。dead-letter 自身满载/写失败不得覆盖主错误或删除幂等 tombstone。调用方断开连接时，HTTP request signal 会向 agent/provider/tool 链路传播。

persistent confirmation ledger 默认最多 10,000 条（`maxRecords`），容量用尽时新建审批以 `CONFIRMATION_CAPACITY` fail closed。容量回收只删除已超过 15 分钟 TTL 的 `pending/approved` 或已超过终态保留期（默认 24 小时）的 `rejected/completed/failed`；`executing` 与 `reconciliation_required` 可能已产生外部副作用，永不因容量压力或 retention 被静默删除。写工具开始执行时会立即从持久化记录移除原始 args；管理列表、`capacity()`、`listMetadata()`、`reconcile()` 和可分页续传的 `prune()` 只返回 metadata，不返回 args。任何带参数写工具都必须显式提供 allowlist/redacted `summarize(args)`；管理面展示该 projection、`argsDigest` 与 `reviewDigest`，并在消费前复核绑定。通用边界再次清除 Bearer/JWT/provider/AWS/Google/private-key 等凭证形态，credential-shaped args 则在落盘前直接拒绝。对账要求 expected revision/status 与 SHA-256 证据摘要，用 CAS 拒绝过期指令。

`createReadOnlyDbTool` 的静态 SELECT 词法检查不是数据库权限边界；adapter 还必须声明并实际实现 `capabilities.readOnlyTransactions=true`，每次 query 都收到 `readOnly:true`。生产数据库用户仍应是数据库层只读角色，并在只读事务/副本上阻断可产生副作用的函数。

OpenAPI 与 MCP 工具结果默认受 4 MiB、JSON depth 32、node count 100,000 的共同边界约束。OpenAPI 同时检查声明长度与 chunked 实际字节；成功写响应在解析/边界检查后失败仍按 unknown 进入 reconciliation。MCP 在 adapter 无法获知远端 effect 时同样保守处理。数据库、MCP 或其他 read tool 的原始异常 message 不会进入下一轮 provider transcript 或返回调用方，只暴露受限稳定 error code，避免 DSN、SQL、路径或业务行泄露。

## 4. Provider、scheduler 与 eval

可用 provider：

- `mock`：确定性、离线，仅用于开发、测试与 eval gate；
- `anthropic`：Messages API；
- `openai-compatible`：`/v1/chat/completions`，支持规范化的文本、tool call、usage 与 SSE 响应。

真实 provider 的 API key、base URL 与模型 id 都从环境注入。OpenAI-compatible 在 production profile 必须提供 API key。两类真实 provider 的自动重试默认均为 0；显式 `maxRetries` 只适用于可证明未生成结果的限流（OpenAI-compatible 另含 425）拒绝。HTTP 5xx、网络断开、超时或响应解析失败可能已经产生费用，统一按未知成本结算并禁止自动 fallback。Anthropic 与 OpenAI-compatible 的成功响应统一限制为 4 MiB（同时检查 `Content-Length` 与 chunked 实际字节）；超限或中止时会取消 response body。usage 必须是完整的非负安全整数，tool call/stop reason 必须通过统一契约后才能进入预算与执行链。

`SCHEDULER_ADAPTER=durable` 使用持久化的 execution record、lease、fencing token 与去重键，并支持 `skip`、`coalesce`、`catch-up` missed-run policy。每个 job 有 1–300,000 ms 的强制 execution timeout（默认 60 秒；内置 patrol 30 秒），signal 会传给 handler；即使 handler 忽略取消，caller/tick/stop 也会在边界后收敛为 `reconciliation_required`，持久 tombstone 阻止重放。`running` lease 过期只证明 worker 停止续租，不能证明外部写未发生，因此一律转 reconciliation，绝不 takeover 执行第二次。只有任务显式声明 `idempotency: required`、实际消费稳定 `idempotencyKey`，且错误同时明确 `retryable:true` 与 `unknownOutcome:false` 时才会重试。已知失败达到尝试上限才进入 `dead_lettered`。HTTP manual run 将 header 派生为稳定、无原始 key 的 runId，响应丢失后的同 key 重试不会生成第二次执行。

durable execution ledger 默认只保留状态、尝试次数、时间和结果类型，不持久化业务 result，也不在 `listJobs()` 中暴露 result。`createDurableScheduler()` 的 `resultRetentionMs` 可在明确知情时短期保留 JSON result（默认 `0`，最长 24 小时，并受 `maxRetainedResultBytes` 限制）；到期后由读取路径或 `compactExecutions()` 删除。ledger 默认硬上限为 10,000 条（`maxExecutionRecords`），满载时新的手动执行 fail closed，调度 tick 不推进 cursor。运维程序可使用 `listExecutions()`、`reconcileExecution()` 和 `pruneExecutions()`：未知结果只能用外部对账证据的 SHA-256 digest 收敛；prune 必须显式传入 `acknowledgeReplayRisk: true`，且永不删除 `running`、`retry_wait` 或未对账的记录。

发布 gate 使用固定 mock provider 运行 JSONL eval 与阈值文件，输出可复现的 pass rate、safety slice 和成本结果；`--mutate` negative control 必须能够让 gate 失败。真实模型离线评测可以作为额外证据，但不能替代 CI 中的确定性回归集。

## 5. Telemetry、审计与 dashboard

`TELEMETRY_ENABLED` 默认 `false`。关闭时不会创建 exporter 请求；dashboard 会明确显示历史数据处于 disabled/off，而不会偷偷启用收集。启用时必须提供 OTLP HTTP endpoint；production 对非 loopback collector 强制 HTTPS，本机 sidecar collector 才允许明文 loopback。运行时只导出 allowlist 内的 span/metric 属性，并在 exporter 边界前做脱敏；不要把 prompt、消息正文、Authorization、cookie、tool arguments/results 或业务 payload 加入 attributes。

审计日志与 telemetry 分开：审计记录主体、租户、动作、资源、policy decision、结果、幂等键等元数据，并通过 hash chain 检测意外损坏或链路不一致；不记录原始 prompt、凭证或工具 payload。durable append 通过事务内 chain-head checkpoint 做常数次 ledger lookup，不在每次写入重扫历史。对 tool、agent、webhook、scheduler job 和管理写操作，运行时在外部 effect 前原子追加 `started` 事件；该事件本身就是容量预留，避免 `capacity()` 检查与实际写入之间的 TOCTOU。审计不可用或满载时 effect 不启动；已存在 pre-effect 证据后的 completion append 失败只产生告警，不能诱导客户端重放可能已提交的 effect。预算/配额拒绝、无效请求和未认证 logout 不占用 pre-effect 容量。Webhook 的 guard 由 registry 在原子 budget reservation 成功后回调，自动与手动 scheduler guard 则在 budget 检查后统一下沉到 scheduler，避免通道层重复占槽。

`AUDIT_MAX_RECORDS` 默认 10,000；满载后 `AUDIT_CAPACITY_EXHAUSTED` fail closed 于新的受审计 effect，同时产生错误日志/metric 与 `/status`/dashboard DEGRADED 状态，绝不为腾空间静默删证据。运维必须在到达阈值前停止写入、`verify()`、导出并把完整 state + head 归档到受控不可变存储，再轮换到新的 state 文件。内置文件 adapter 的链头与数据位于同一信任域，因此 Dashboard 只标记为 `UNVERIFIED`。若要证明有权限修改状态文件的攻击者未重算整条链，必须把链头周期性锚定到独立的只写存储或外部签名系统后，才可标记为 `VERIFIED`。

dashboard 是同进程的只读运维视图：只接受 `GET`/`HEAD`，需要 operator/admin/auditor 角色、`dashboard:read`，以及页面对应的 `runs:read`、`costs:read`、`evals:read`、`approvals:read`、`audit:read` 或 `system:read`。服务端会先脱敏再渲染；dashboard 不提供执行、审批、重试、配置修改或 telemetry 开关。

## 6. 状态迁移与回滚

state snapshot 带有明确 `schemaVersion`。迁移只能逐版本向前执行；缺少迁移步骤、损坏 checksum 或遇到比运行时更新的 schema 时，服务会拒绝启动。没有自动 downgrade。

推荐发布步骤：

1. 停止旧实例写入，备份 state 文件或数据库快照，并记录当前应用版本、schema version 与 checksum；
2. 在副本上运行新版本迁移、store contract tests、runtime tests、eval gate 与 smoke check；
3. 先启动单个新实例，验证 `/health`、鉴权后的 `/status`、dashboard off/on 状态、scheduler lease 和一条只读请求；
4. 同主机扩进程前验证 file-lock child-process 测试；跨主机扩容前验证外部 driver 的多主机事务/CAS 能力；
5. 保留回滚窗口内的旧二进制和**迁移前**快照。

audit 轮换不是普通 retention 删除：先停写并确认 `verify().valid=true`，把完整 state snapshot、audit count/head hash、应用版本和 checksum 一起写入受控归档，再创建新的 state 文件并保留归档索引。不得直接编辑或裁剪 append-only namespace。

应用回滚与数据回滚必须分开：若新版本尚未提升 schema，可停止新实例后切回旧版本；若已经迁移，先停止所有写入，再恢复迁移前快照并切回旧版本。不要让旧二进制读取较新的 snapshot，也不要手工编辑 checksum 文件。涉及写工具的外部副作用不能靠 state snapshot 自动撤销，必须使用业务系统自己的补偿流程与审计证据。

## 7. 发布前验证

在仓库根目录执行：

```bash
npm run check
```

该入口串行执行语法与脱敏、命令 manifest、adapter conformance、行业模板、完整 Node tests、确定性 eval、scaffold HTTP smoke 与 release/package gate。任一 gate 失败都返回非零。该命令不会 push、部署、写生产配置、写生产数据库或发布 npm 包。
