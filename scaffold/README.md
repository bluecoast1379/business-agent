# agent-gateway-scaffold

零依赖的业务 AI Agent 网关骨架:纯 Node 18+ ESM,`node:http` 提供 HTTP/SSE 通道,全局 `fetch` 调用 Anthropic Messages API(含 tool use 循环),内置确定性 MockProvider 可完全离线跑通。示例业务域为虚构的精品咖啡豆 B2B 供应商 **Brewline**(客户=咖啡馆),替换 toolpack 即可接入你的真实业务。

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
        │  runtime/scheduler.js ──▶ agents/patrol.js       (tool-call 循环)  │
        │  (分钟 tick + safeRun)    (巡检,阈值 env 外置)     │        │       │
        │                                                  ▼        ▼       │
        │                                        runtime/llm.js  toolpacks/ │
        │                                        Anthropic|Mock  demo(8 工具)│
        │                                             │              │      │
        │  guardrails: confirm-gate(写确认)           │              │      │
        │             scoped-tool(租户绑定)     runtime/cost-tracker.js      │
        │  runtime/session-store.js(TTL 会话)   (每轮 usage → 月成本/预算)    │
        └───────────────────────────────────────────────────────────────────┘
                       │                                    │
                 Anthropic API(fetch)              你的业务后端(可选 BACKEND_URL)
```

## 模块职责

| 模块 | 职责 |
| --- | --- |
| `src/index.js` | boot:loadConfig → buildRegistry → startHttp → startScheduler;成功后 stdout 打印 `listening on <端口>` |
| `src/config.js` | 环境变量配置,fail-fast:缺必填直接抛错并给修复指引;无任何内置密钥/内部域名默认值 |
| `src/runtime/llm.js` | Provider 接口 `complete()`;AnthropicProvider(Messages API + tool use)与确定性 MockProvider;单价表(可 env 覆盖) |
| `src/runtime/agent.js` | tool-call 循环:maxTurns 上限、每轮 usage 上报 cost-tracker、超单次预算中断并返回已得内容 |
| `src/runtime/tool.js` | `defineTool` + 手写参数校验(type/required/enum) |
| `src/runtime/session-store.js` | 内存会话(TTL 清理、按干净轮次截断历史) |
| `src/runtime/cost-tracker.js` | 月度成本聚合(`/status` 与调度预算守卫读取的是真实接线数据) |
| `src/runtime/scheduler.js` | 分钟 tick 调度;safeRun 包月度预算检查 + try/catch + 运行日志 |
| `src/channels/http.js` | `/health`(免鉴权)、`/chat`、`/chat/stream`(SSE)、`/status`、`/confirmations`(人工审批写操作)、`/jobs/:name/run`;除 /health 与 /webhook 外要求 Bearer token |
| `src/channels/webhook.js` | 通用入站 webhook:时间戳 HMAC-SHA256 验签(`sha256=HMAC(secret, "<timestamp>.<body>")`,±300s 防重放)→ 提取文本 → 走同一 handleMessage;含按渠道格式化+长度截断 |
| `src/guardrails/confirm-gate.js` | 写工具带外人工确认:首调登记待办返回 `confirmationId`;**人**经 `POST /confirmations/:id/approve`(或 REPL `/approve`)审批后凭 id 二调才执行;未审批二调被拒;id 一次性、15 分钟过期 |
| `src/guardrails/scoped-tool.js` | `withScope` 强制注入参数(如 customerId),覆盖外部同名传参,防越权 |
| `src/agents/registry.js` | 装配 assistant(交互)+ patrol(批处理);统一心跳 `handleMessage` |
| `src/agents/assistant.js` | 系统提示词**每次请求组装**(日期实时求值;术语表从 `src/knowledge/glossary.md` 运行时读取) |
| `src/agents/patrol.js` | demo 巡检:逾期发票/供应商准时率/延迟配送 → 控制台或出站 webhook 推送;阈值来自 env |
| `src/toolpacks/demo/` | Brewline 合成数据 + 7 个只读工具(summary/raw 双形态)+ 1 个写工具(演示 confirm-gate) |
| `bin/chat-repl.js` | 本地 REPL,直连 handleMessage,mock 下可离线玩 |
| `smoke.js` | 不起端口的内部自检(`npm run smoke`) |

## 快速开始(mock,三分钟)

```bash
# 1. 准备配置(mock 无需任何密钥)
cp .env.example .env
# 编辑 .env:LLM_PROVIDER=mock,GATEWAY_AUTH_TOKEN=test-token

# 2. 起服务(或直接用环境变量,不写 .env 也行)
LLM_PROVIDER=mock GATEWAY_AUTH_TOKEN=test-token node src/index.js
# stdout: listening on 3000

# 3. 另开终端验证
curl -s http://127.0.0.1:3000/health
# {"status":"ok",...}

curl -s -X POST http://127.0.0.1:3000/chat \
  -H 'Authorization: Bearer test-token' -H 'content-type: application/json' \
  -d '{"sessionId":"demo","message":"top customers"}'
# reply 含 "[mock] top customers: Top 5 customers ..."(mock 先调了 get_top_customers 再回答)

curl -s http://127.0.0.1:3000/status -H 'Authorization: Bearer test-token'
# activeSessions / monthlyCostUsd(真实累计)/ budget / jobs

curl -s -X POST http://127.0.0.1:3000/jobs/daily-patrol/run -H 'Authorization: Bearer test-token'
# 手动触发巡检,报告打印到服务端控制台

curl -sN 'http://127.0.0.1:3000/chat/stream?sessionId=demo&message=hello' \
  -H 'Authorization: Bearer test-token'
# SSE 逐段推送
```

其它两个入口:

```bash
npm run smoke   # 内部自检(不起端口):mock 回路 / confirm-gate / scheduler / cost>0
npm run chat    # 本地 REPL(LLM_PROVIDER=mock 可离线玩)
```

注意:`.env` 不会被自动加载(零依赖),用 `export $(grep -v '^#' .env | xargs)` 或直接以环境变量方式启动;`.env` 已被 `.gitignore` 忽略,绝不提交。

## 接真实 LLM(Anthropic)

```bash
LLM_PROVIDER=anthropic LLM_API_KEY=<你的key> GATEWAY_AUTH_TOKEN=<随机串> node src/index.js
```

可选:`LLM_MODEL`(默认 `claude-sonnet-4-6`)、`LLM_COMPLEX_MODEL`、`LLM_PRICE_TABLE_JSON`(成本折算单价)。要换其它 provider,在 `src/runtime/llm.js` 按 `complete({model,system,messages,tools,maxTokens}) → {stopReason,text,toolCalls,usage}` 接口再实现一个工厂,并在 `createProvider` 里挂上即可——上层 agent 循环不用动。

## 接真实业务后端

demo toolpack 全部读内存合成数据。接真实后端的路径:

1. 新建 `src/toolpacks/<你的域>/index.js`,照抄 demo 的形态:`defineTool` 定义 name/description/params,handler 里用 `fetch` 调你的后端(`BACKEND_URL`/`BACKEND_API_KEY` 从 config 读,绝不硬编码);
2. 保持 **summary/raw 双形态**:默认返回给 LLM 的是紧凑摘要(省 token),raw 仅作逃生舱;
3. **读优先**:所有写操作必须用 `wrapWriteTool` 包一层人工确认;多租户场景用 `withScope` 把租户 id 绑死;
4. 在 `src/agents/registry.js` 把 `buildDemoTools()` 换成(或合并)你的 toolpack;
5. 权限:网关调用后端所用的凭证应是**最小权限角色**,后端自身鉴权绝不能因为网关而绕过。

## 新增渠道

任何渠道最终都只做三件事:收文本 → `registry.handleMessage(sessionId, text)` → 按渠道格式化回复(参考 `channels/webhook.js` 的 formatter:长度截断/富文本适配)。入站推送类渠道务必验签(HMAC 示例已给);轮询类渠道自己起定时器即可。新文件放 `src/channels/`,在 `src/index.js` 装配。

## 新增巡检任务

写一个 `{ name, schedule: {minute, hour, dayOfWeek?, dayOfMonth?}, run }` 描述对象(参考 `src/agents/patrol.js`),在 registry 的 `jobs` 数组里加上即可。所有任务经 `safeRun` 执行:月度预算超限自动跳过、异常不影响进程;`POST /jobs/<name>/run` 可手动触发。

## 护栏一览

- **fail-fast 配置**:缺必填环境变量直接拒绝启动,不给任何"能跑就行"的默认密钥。
- **鉴权**:除 `GET /health` 外全部要求 `Authorization: Bearer <GATEWAY_AUTH_TOKEN>`(常数时间比较);入站 webhook 用 HMAC-SHA256 验签。
- **预算双层**:`BUDGET_MAX_USD_PER_REQUEST` 超限中断单次 tool 循环;`BUDGET_MONTHLY_USD` 超限拒绝新会话、巡检跳过。成本来自每轮 usage × 单价表的真实累计。
- **写操作人工确认**:confirm-gate 两段式,token 一次性、5 分钟过期,二调执行的是首调存档的原始参数(防篡改)。
- **数据隔离**:scoped-tool 在工具层强制注入租户参数;提示词层只写规则不写密钥;后端层保持自身鉴权。
