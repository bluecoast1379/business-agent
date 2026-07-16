# 安全基线:网关十大事故与守卫

业务 agent 网关的事故极少来自模型本身,几乎都来自工程侧的十个坑。本文把 `kit/core/checklists/gateway-incidents.md` 的清单展开为「症状 / 根因 / 守卫」,`/harden-agent` 阶段必须逐项对照并给出证据;最后一节是发布与提交前的脱敏检查用法。

## 十大事故清单(展开版)

### 1. 源码内兜底密钥 / 内部域名

- **症状**:环境变量没配,服务却「能跑」;换环境部署后流量打到了错误的(甚至是别人的)后端;密钥随仓库泄漏。
- **根因**:`config.apiKey = process.env.X || "sk-xxxx"` 式的兜底写法;开发图方便把内网地址写成默认值。
- **守卫**:fail-fast——必填项缺失直接抛错退出(scaffold 的 `config.js` 即此行为);代码评审拒绝一切 `|| "<真实值>"`;`check:sanitized` 扫密钥形态兜底。

### 2. `.gitignore` 不含 `.env` / `node_modules`

- **症状**:第一次 `git add -A` 就把 `.env` 提交进历史;密钥进历史 = 已泄漏。
- **根因**:骨架没带 `.gitignore`,或复制目录时丢了隐藏文件。
- **守卫**:scaffold 自带 `.gitignore`(`.env`、`node_modules/`、`*.log`);初始化器同时确保 target `.gitignore` 覆盖 `business-agent/local/` 与 `.env`;一旦已泄漏,**先轮换凭证再清历史**。

### 3. 月度成本追踪定义了未接线

- **症状**:代码里有 cost-tracker,月底账单却是靠 provider 后台才发现超支——tracker 读数恒为 0。
- **根因**:tracker 模块写了,但 agent 调用循环没有逐轮上报 usage;或只在某一条路径上报,巡检路径漏了。
- **守卫**:上报放在 agent 循环内部(scaffold 由 `agent.js` 每轮接线),所有渠道共用同一心跳;冒烟断言 `GET /status` 的 `costUsd > 0`(`check:scaffold` 即此断言)。

### 4. 系统提示词日期在模块加载时求值

- **症状**:agent 永远认为「今天」是进程启动那天;跨天后所有相对时间(昨天 / 本周 / 逾期天数)集体错位,且很难被发现。
- **根因**:`const SYSTEM = `今天是 ${new Date(...)}`` 写在模块顶层,只求值一次。
- **守卫**:提示词用函数每次构建(scaffold 的 `assistant.js` 即此写法);评测集包含跨天时间问答样例。

### 5. 聊天端点无鉴权 / 无限流

- **症状**:网关地址一旦被扫到,任何人可白嫖模型调用,并透过工具触达内部数据;账单被刷爆。
- **根因**:demo 阶段「先跑起来」,上线时忘了补鉴权。
- **守卫**:除 `GET /health` 外先验证 Bearer principal,再按 route 校验 role + scope + tenant,并对 tenant/subject 执行 rate/concurrency quota;production 不接受只有 legacy `GATEWAY_AUTH_TOKEN` 而没有 `AUTH_PRINCIPALS_JSON` 的配置。渗透用例必须覆盖无 token 401、错 role/scope 403、跨租户拒绝与 quota 429;预算上限只是最后一道成本兜底。

### 6. 默认以最高权限角色调用后端

- **症状**:agent 的一次幻觉参数或一次注入,变成后端里的管理员操作。
- **根因**:图方便复用管理员 token 给网关。
- **守卫**:为网关签发**专用最小权限凭证**,只读优先;写能力单独授权、单独凭证;后端侧鉴权照常校验——网关是旁路,永不成为后端的信任白名单。

### 7. 知识文件存在但从未注入提示词

- **症状**:精心维护的术语表 / 政策文档躺在仓库里,agent 的回答却全靠通用语料自由发挥,业务口径持续跑偏。
- **根因**:知识文件只被 README 引用,没有任何代码在运行时读它。
- **守卫**:知识文件由 agent 构建提示词时**运行时读取注入**(scaffold 的 `assistant.js` 读 `knowledge/glossary.md`);评测集包含术语口径题,注入断链会直接测出来。

### 8. 入站 webhook 未验签 / 未解密即信任

- **症状**:任何能拿到 webhook 地址的人都能伪造「支付成功」「客户消息」,驱动 agent 做出真实动作。
- **根因**:只校验了字段格式,没校验消息来源。
- **守卫**:HMAC-SHA256 验签(secret 来自环境变量),验签失败直接拒绝(scaffold 的 `webhook.js` 即此行为);渠道自带加密方案的先解密再解析;把入站内容视为**不可信数据**,进提示词前声明其来源。

### 9. 写操作无人工确认

- **症状**:模型误解语义或被提示注入,直接创建了贷项、发出了催款通知;事后只能人工回滚。
- **根因**:写工具与读工具同权,一次 tool-call 就落库。
- **守卫**:policy manifest 中所有 `effect: write` 工具必须同时为 `approval: human` 与 `idempotency: required`;运行时用 confirm-gate 包装——首调只登记待办并返回 confirmationId,**审批信号走模型触达不到的带外通道**。任何带参数写工具必须给出 allowlist/redacted review projection，并用 args/review digest 绑定；禁止仅显示 `Execute tool` 的盲审批。中心边界再次清除 credential shape，含凭证形态的 args 在落盘前拒绝。persistent ledger 必须有硬容量上限和全分页 retention，管理列表不返回原始 args，且不得为腾容量静默删除未过期审批、执行中或待对账状态。

### 10. 工具返回原始大 JSON 撑爆上下文

- **症状**:一次「查一下上月订单」耗掉几十万 token,成本飙升、响应变慢、模型在噪声里漏掉关键字段。
- **根因**:工具把后端分页接口的原始响应整包塞回模型。
- **守卫**:summary 优先——默认返回「前 N 条 + 聚合统计 + 一行分析 hint」,`mode: raw` 才给原始数据且带行数 / 字节截断;契约层为每个工具显式声明 `mode`。

## 数据隔离三层(审查口径)

`/harden-agent` 要求对每个 agent 给出三层证据,缺一层不算通过:

1. **提示词层**:系统提示词声明数据边界与拒答规则(软约束,只是第一道);
2. **工具层**:scope 绑定强制注入隔离参数 + 参数校验 + 写操作确认闸(硬约束);
3. **后端层**:网关持最小权限凭证,后端自身鉴权与行级权限照常生效(兜底)。

配套渗透用例:越权租户、无 token 调用、提示注入样例。黄金样例见 `examples/brewline/agents/billing-assistant/02-safety-review.md`。

## 生产 profile 的额外硬边界

十大事故清单是最低门槛。production profile 还必须满足以下工程控制：

### 身份与权限

- `AUTH_PRINCIPALS_JSON` 为每个 token 绑定稳定 subject、tenant、role 与最小 scopes；`admin`/`*` 只用于受控应急身份；
- HTTP route policy 与 tool policy 是两层独立授权，不能用 prompt 代替；tool manifest 缺 audience、tenantScope、dataClass、effect、approval、idempotency、timeout、audit 或 outputSchema 时 fail closed；
- 写工具同时要求 human approval 与 idempotency，审批端点只对 operator/admin 开放，模型不能取得审批凭证或直接调用审批通道；
- webhook 除 HMAC 与 replay window 外，还要绑定显式 integration identity/principal，不能把 body 内自报 tenant 当成信任身份。
- webhook replay ledger 不持久化完整 reply/业务结果；`running` 过期与重启后无法回放的 `committed` 均 fail closed，只能由具有 `webhooks:reconcile` 的 operator 按已知 eventId 对账。管理面不提供 raw eventId 列表，ledger 必须有硬容量上限，满载时拒绝新事件。

### 持久化与可靠执行

- production 禁止 memory state 与 local scheduler。session、run、confirmation、cost、job、audit、idempotency、dead-letter 使用统一持久化契约；
- 内置 file adapter 使用同目录 `wx` 排他锁、checksum、fsync、原子 rename，损坏时拒绝启动；它保证同主机多进程协调,不保证跨主机/共享网络文件系统，跨节点副本必须使用通过 contract tests 的事务/CAS driver；
- timeout 与 client cancellation 要传播到 provider/tool；bulkhead 与 circuit breaker 防止局部故障拖垮进程；write/workflow/job handler 的未分类异常默认 unknown，只有明确 `unknownOutcome:false` 的已知拒绝允许 bounded retry；DLQ 故障不能覆盖主错误或删除 tombstone；
- `POST /chat`/stream 的 request idempotency 绑定 principal+route+body，manual job 强制 `Idempotency-Key` 并派生稳定 runId；同 key 不得执行不同 body/job；
- durable scheduler 使用 lease、fencing token 与 execution key 去重，明确 missed-run policy；达到最大尝试次数先写终态再进入 dead-letter，未知结果进入永不自动重放的 reconciliation。execution ledger 不默认保存业务 result，具有硬容量上限；prune 需要显式风险确认且不允许删除 running/未对账记录。
- scheduler job 必须有受限 timeout 并消费 cancellation signal；timeout 或已过期 running lease 只能进入 reconciliation，不得以 fencing 能保护 ledger 为由重放无法撤销的外部 effect；内置 patrol webhook 传递稳定 idempotency key。
- HTTP 完整响应的短期幂等缓存必须在启动/管理/容量/新 claim 路径全局 sweep，不能依赖同一 key 再次访问；到期只删业务正文，不删阻止 replay 的 tombstone/digest。

### Telemetry、审计与 dashboard

- `TELEMETRY_ENABLED=false` 是隐私默认值。关闭时 exporter 零请求；启用必须显式配置 OTLP endpoint，并只允许脱敏后的 metadata attributes；
- telemetry 与 audit 分离。Audit 记录 actor/tenant/action/resource/policy decision/outcome/idempotency 等元数据并维护 hash chain，不记录 prompt、Authorization、tool arguments/results 或业务 payload；
- production 非 loopback listener 必须由可信私网 HTTPS ingress 终止 TLS 并显式声明；外部 LLM/backend/notify/OTLP URL 必须 HTTPS。API/SSE 响应 `no-store`，调用方 path/request-id 不得原样进入 telemetry；未认证 slow body 必须有明确连接/时间上限；
- audit 使用 durable chain-head checkpoint 与硬容量；tool/agent/webhook/scheduler/管理写操作以原子 `started` 事件在 effect 前占用容量，不能用先查容量再执行的 TOCTOU 方案。满载或审计不可用时 effect fail closed；scheduler guard 必须同时覆盖自动 tick 与 manual run。预算/配额拒绝及未认证请求不消耗 pre-effect 槽位。归档/轮换必须保留完整链和 head，不能静默删证据。OpenAPI/MCP tool result 有 bytes/depth/nodes 边界，driver 原始 error message 不进入 provider transcript；
- dashboard 只允许 operator/admin/auditor 的 GET/HEAD，按页面 capability 授权，在服务端脱敏与分页；它不执行审批、重试、配置或 telemetry 开关。

### 迁移与回滚

- state schema 迁移只允许显式逐版本向前；checksum 错误、缺 migration step、或 snapshot 版本高于运行时都会 fail closed；
- 发布前备份迁移前 snapshot 并在副本演练。回滚时先停止所有写入，再分别决定应用回滚与数据 snapshot 恢复；旧二进制不得读取新 schema；
- tool 已在外部业务系统造成的写入不随 state snapshot 自动回滚，必须走业务补偿流程并保留审计证据。完整步骤见 [生产运行指南](./production-profile.md)。

## 脱敏检查(提交与发布前强制)

### 基本用法

```bash
npm run check:sanitized
```

默认脚本命令与 `npm run check` 都以 `--strict` 扫描工作树全部候选文件(仅内建排除 `.git`、`node_modules`),两类规则:

- **密钥形态规则(内置)**:通用密钥模式——OpenAI/Anthropic/Google 等 provider key、Slack token、AWS AccessKey、PEM 私钥头、GitHub token、JWT、带引号或 dotenv/shell 无引号的 credential assignment;值为 `${...}` / `process.env` / 明确占位符时跳过(完整模式清单见 `bin/sanitize-patterns.cjs`);
- **词面规则(全部外置)**:随包的 `bin/sanitize-patterns.cjs` **刻意不内置任何项目/公司专有词**——即使以转义或编码形式携带,词表本身也会泄露它要保护的私有词汇。你的专有词一律走下述私有 denylist。

命中输出 `文件:行号` 与掩码片段(前 3 后 3 字符,中间 `***`),**不回显全值**;同时始终输出 skipped 清单及原因。strict 下任何 unreadable/stat/read 失败、symlink、未批准二进制、超 5 MiB 或非 UTF-8 文件都会 fail closed,不得以“未命中”形式静默通过。`check-release.cjs` 复用同一份 `sanitize-patterns.cjs`,防止工作树与打包门禁规则漂移。

### 受控 skip manifest

源码包原则上不应包含二进制或超大文件。若工作树审计确有受控例外,只能使用精确路径、精确 reason 与明确 justification 的 JSON manifest:

```json
{
  "schemaVersion": "1.0",
  "skips": [
    {
      "path": "assets/generated.bin",
      "reason": "binary-extension",
      "justification": "Generated artifact is verified by the deterministic asset pipeline."
    }
  ]
}
```

```bash
node bin/check-sanitized.cjs --strict --skip-manifest /path/to/controlled-skips.json
```

- reason 只允许 `binary-extension`、`binary-content`、`invalid-utf8`、`oversized`;
- 不允许 glob、目录级绕过或批准 unreadable/stat/read 错误;
- 未使用、路径不存在或 reason 不匹配的 manifest 条目同样失败,避免例外长期漂移。

### 私有 denylist(`--extra-banned`)

内置规则只覆盖通用密钥形态;你团队自己的公司名、项目代号、内部域名、人名等专有词需要一份**私有 denylist**:

```bash
node bin/check-sanitized.cjs --extra-banned /path/outside-repo/private-denylist.txt
```

- 格式:一行一个词或正则,`#` 开头为注释;示例见 [private-denylist.example.txt](./private-denylist.example.txt);
- **必须放在仓库之外**(比如私有运维仓或本机受控目录)——denylist 本身就是一份敏感词汇总,进了公开仓库等于自我泄漏;
- 建议把带 `--extra-banned` 的检查写进团队的发布前手续(与 [SECURITY.md](../SECURITY.md) 的发布义务一致)。

### 边界与例外

- 检查覆盖**工作树**,不含 Git 历史;敏感值一旦进入历史,视同泄漏:先轮换凭证,再评估历史清理;
- 检查是词面 / 形态扫描,不能替代人工评审——结构化数据(如真实客户名单)不含敏感词也不允许入库;
- 给内置规则提 PR 时只允许新增**通用形态模式**,严禁提交任何公司/项目专有词或真实值样本(哪怕转义、编码过)——专有词永远属于仓库外的私有 denylist。
