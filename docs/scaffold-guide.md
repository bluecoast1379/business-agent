# Scaffold 指南:架构、模块职责与扩展

`scaffold/` 是一个零依赖(Node 22+,ESM,`node:http` + 全局 `fetch`)的业务 agent 网关骨架。`/scaffold-gateway` 命令把它复制为目标工作区的 `agent-gateway/` 并按蓝图定制;你也可以直接在副本上手工开发。本文讲清楚它的结构、每个模块的职责边界,以及三类最常见的扩展:接真实后端、换 LLM provider、加渠道。

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
                         │              runtime/llm.js   toolpacks/* ─┼──fetch──► BACKEND_URL
                         │            (anthropic | mock)   │          │      (最小权限凭证,
                         │                                 ▼          │       后端鉴权照常生效)
                         │              guardrails/scoped-tool.js     │
                         │              guardrails/confirm-gate.js    │
                         │                                            │
                         │  横切:config(fail-fast) · session-store   │
                         │        cost-tracker · knowledge 运行时注入 │
                         └────────────────────────────────────────────┘
```

这是**旁路网关**模式:agent 网关是一个独立 Node 服务,通过 HTTP 调用既有后端,不嵌进后端进程、不直连数据库、不绕过后端自身的鉴权。交互式(HTTP 对话)与批处理(定时巡检)双入口共用同一条 `handleMessage` 心跳。

## 模块职责

| 模块 | 职责 | 边界 |
| --- | --- | --- |
| `src/config.js` | 读环境变量并校验 | **fail-fast**:必填项缺失直接抛错退出;无任何默认密钥 / 默认内部地址 |
| `src/runtime/llm.js` | Provider 接口 `complete(...)`,内置 `AnthropicProvider` 与 `MockProvider` | 只管一次补全;不管循环、预算、会话 |
| `src/runtime/agent.js` | `createAgent(...)`:tool-call 循环、轮数上限、预算折算、逐轮上报 cost-tracker | 不认识 HTTP;渠道无关 |
| `src/runtime/tool.js` | `defineTool(...)` + 手写参数校验(type / required / enum) | 校验失败返回结构化错误给模型,不抛穿进程 |
| `src/runtime/session-store.js` | TTL 会话存储、定时清理 | 内存实现;换持久化只动这一层 |
| `src/runtime/cost-tracker.js` | `trackUsage / getMonthlyCost / isOverBudget / summary` | 由 `agent.js` **每次调用**接线——「定义了但没接线」是十大事故之一 |
| `src/runtime/scheduler.js` | `registerJob({name, schedule, run})`,每分钟 tick 匹配 | `safeRun` 包预算检查 + try/catch + 日志,单任务失败不拖垮进程 |
| `src/channels/http.js` | `GET /health`(无鉴权)、`POST /chat`、`GET /chat/stream`(SSE)、`GET /status`、`GET/POST /confirmations*`(人工审批)、`POST /jobs/:name/run` | 除 health/webhook 外一律校验 `Authorization: Bearer GATEWAY_AUTH_TOKEN` |
| `src/channels/webhook.js` | 入站 webhook:时间戳 HMAC-SHA256 验签(签名基为 `"<timestamp>.<body>"`,±300s 防重放)→ 提取文本 → 走同一 `handleMessage`;出站 formatter(按渠道格式化 + 长度截断) | 验签 secret 来自环境变量;验签失败或时间戳过期即拒绝 |
| `src/guardrails/scoped-tool.js` | `withScope(tool, scope)`:强制注入隔离参数,外部同名参数被覆盖 | 硬约束;模型生成什么参数都盖掉 |
| `src/guardrails/confirm-gate.js` | `createConfirmationCenter()` + `wrapWriteTool(tool, { center })`:首调登记待办返回 confirmationId,**人工经 `POST /confirmations/:id/approve` 带外审批**后凭 id 二调才真执行;未审批二调被拒 | 所有写工具必须包一层;审批通道绝不能经过模型 |
| `src/agents/registry.js` | 装配交互 agent 与巡检 agent,暴露统一 `handleMessage(sessionId, message)` | 新 agent 在此注册 |
| `src/agents/assistant.js` | demo 交互 agent:系统提示词 = 角色 + 能力 + 术语表(从 `knowledge/glossary.md` **运行时读取注入**)+ 规则;当前日期每次求值 | 术语表改文件即生效,不改代码 |
| `src/agents/patrol.js` | demo 巡检:查数据找异常(阈值来自环境变量)→ 推送 | 阈值外置,调阈值不发版 |
| `src/toolpacks/demo/` | Brewline 合成数据 + 6~8 个只读工具(summary/raw 双形态)+ 1 个写工具(演示 confirm-gate) | 教学用;真实 toolpack 参照其形状新建 |
| `src/knowledge/` | 运行时注入的知识文件(术语表) | 业务口径的唯一事实源 |
| `bin/chat-repl.js` | CLI REPL,直连 `registry.handleMessage` | mock provider 下无密钥可玩 |
| `smoke.js` | `npm run smoke`:不起端口的内部自检(对话一轮、confirm-gate 两段、scheduler 单 tick、cost > 0) | 改完必跑 |

## 运行方式

```bash
# mock provider,无需密钥
LLM_PROVIDER=mock GATEWAY_AUTH_TOKEN=dev-token PORT=8787 node src/index.js

# CLI REPL / 内部自检
LLM_PROVIDER=mock GATEWAY_AUTH_TOKEN=dev-token node bin/chat-repl.js
npm run smoke

# 真实 provider:复制 .env.example 为 .env,填 LLM_PROVIDER=anthropic 与 LLM_API_KEY
npm start
```

配置项以 `scaffold/.env.example` 为准:必填 `LLM_PROVIDER`(`anthropic|mock`;anthropic 时必填 `LLM_API_KEY`)与 `GATEWAY_AUTH_TOKEN`;可选 `LLM_BASE_URL` / `LLM_MODEL` / `LLM_COMPLEX_MODEL` / `PORT` / `HOST` / `BUDGET_*` / `BACKEND_URL` / `BACKEND_API_KEY`。

## 扩展一:接真实后端

demo toolpack 用内存合成数据;接真实后端 = 新建一个 toolpack,工具 handler 里用 `fetch` 调 `BACKEND_URL`:

1. 新建 `src/toolpacks/<slug>/index.js`,按 `01-tool-contracts.yaml` 逐条 `defineTool`——description 面向 LLM 描述返回内容,params 带类型与 required;
2. handler 内 `fetch(config.backendUrl + path, { headers: { Authorization: Bearer ${config.backendApiKey} } })`;凭证只从 config 取,config 只从环境变量取;
3. 返回**summary 优先**:默认给「前 N 条 + 聚合统计 + 一行 hint」,`mode: raw` 才透传原始结构;对大结果做行数与字节截断;
4. 写操作工具用 `wrapWriteTool` 包确认闸,隔离参数用 `withScope` 强制注入;
5. 在 `agents/registry.js` 把新 toolpack 挂给对应 agent,`npm run smoke` 通过后,再用 mock provider 手工过一遍 REPL。

后端侧配合:为网关签发**最小权限、只读优先**的专用凭证,不要复用管理员凭证——「默认最高权限角色」是十大事故之一。

## 扩展二:换 LLM provider

Provider 接口只有一个方法:

```
complete({ model, system, messages, tools, maxTokens })
  → { stopReason, text?, toolCalls?, usage }
```

在 `src/runtime/llm.js` 新增一个实现(用全局 `fetch` 调目标 API,把工具调用与 usage 归一到上述返回形状),在 provider 工厂按 `LLM_PROVIDER` 分发即可。注意两点:`usage` 必须如实返回,否则预算折算失真;新 provider 的单价表通过环境变量覆盖,不硬编码价格。`MockProvider` 的确定性行为被 `npm run check:scaffold` 依赖,不要改动其契约。

## 扩展三:加渠道

渠道适配器的职责是「把外部消息变成 `handleMessage(sessionId, message)` 调用,把回复按渠道格式化后发回去」:

1. 入站:参照 `channels/webhook.js`——先**验签**(HMAC 或渠道方案),再提取文本与会话标识;未验签即信任入站消息是十大事故之一;
2. 出站:实现 formatter——每个渠道有自己的长度预算与格式(IM 卡片、纯文本、markdown 子集),超长先截断再发;
3. 复用同一 `handleMessage` 心跳,不要为新渠道另起一条 agent 调用路径——护栏(预算、确认闸)都挂在心跳上,绕开心跳等于绕开护栏。

## 改动后的最低验证

任何改动至少跑:`npm run smoke`(scaffold 内)+ 仓库根 `npm run check:scaffold`(若你改的是 kit 内置 scaffold 本体)。接入真实密钥前,先确认 `.env` 已被 `.gitignore` 覆盖。
