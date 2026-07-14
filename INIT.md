# 初始化指南

本文面向**接收方**:拿到 Business Agent Kit 后,如何把它安装进自己的工作区、验收生成物、以及升级时哪些文件受保护。初始化只负责把方法论内核、scaffold 副本与工具入口写进本地工作区;它不授权实现、不做远程 Git 操作、不部署、不写数据库。

## 推荐流程

1. 把 kit checkout 或安装在目标工作区**之外**(相邻目录即可)。
2. 在目标工作区根目录运行初始化器,选择你实际使用的 AI 工具。
3. 打开 `business-agent/business-profile.yaml`,填入公司名、行业、系统清单、渠道与预算策略;密钥值、内部域名等私有内容放进被 Git 忽略的 `business-agent/local/`。
4. 如存在 `business-agent/INITIALIZATION_QUESTIONS.md`,补齐缺失资料。
5. 在 AI 工具中运行 `/agent-status`,确认命令入口生效,然后从 `/discover-business` 开始。

## 三种调用形态

### 1. 从相邻源码目录初始化

```bash
node ../business-agent/bin/init-workspace.cjs --target . --tools claude,cursor,copilot
```

Shell wrapper(会先校验 `node >= 22` 再转发同一入口):

```bash
../business-agent/install.sh . --tools claude
```

### 2. 从 package bin 初始化

通过 tarball 或 registry 安装后(见 [docs/install.md](./docs/install.md)):

```bash
business-agent-init --target . --tools claude,cursor
```

非交互环境加 `--yes`,缺失资料会写入 `business-agent/INITIALIZATION_QUESTIONS.md`,不会被猜测性默认值静默掩盖:

```bash
business-agent-init --target . --tools claude --yes
```

### 3. 升级已初始化的工作区

```bash
business-agent-init --target . --tools claude,cursor --upgrade
```

先用 `--dry-run` 预览写入 / 清理 / 冲突计划,再实际执行。

## 参数速查

| 参数 | 说明 |
| --- | --- |
| `--target <dir>` | 必填,目标工作区根目录 |
| `--tools <csv>` | `claude,cursor,copilot,codex`,默认 `claude`;不支持的工具直接报错并指向 [docs/support-matrix.md](./docs/support-matrix.md) |
| `--yes` | 非交互模式 |
| `--dry-run` | 只输出计划,不写盘 |
| `--upgrade` | 升级模式,按指纹刷新 kit 生成物 |
| `--force` | 覆盖一般生成文件;**对 preserveOnUpgrade 文件无效** |

## 会生成什么

| 生成物(target 侧) | 来源 | 升级行为 |
| --- | --- | --- |
| `business-agent/core/` | 逐文件复制 kit 的 `kit/core/` | **总是覆盖**(core 是 kit 事实源) |
| `business-agent/scaffold/` | 复制 kit 的 `scaffold/` | 覆盖;已用 `scaffold-gateway` 实例化到别处的 `agent-gateway/` 不受影响 |
| `business-agent/business-profile.yaml` | 模板生成 | **preserveOnUpgrade:已存在则永不覆盖(即使 `--force`)**,新版本写 `business-profile.yaml.business-agent-new` |
| `business-agent/local/` | 空目录 + README(「私有值放这里」) | 保留;同时确保 target `.gitignore` 含 `business-agent/local/` 与 `.env`(无则创建,已有则幂等追加) |
| `business-agent/INITIALIZATION_QUESTIONS.md` | 待补资料清单 | preserveOnUpgrade,同 business-profile |
| 根 `AGENTS.md` | 不存在则创建;已存在则以 `<!-- BEGIN business-agent -->` / `<!-- END business-agent -->` 栅栏块追加或原位替换 | 只改栅栏内内容,**绝不动栅栏外**的用户内容 |
| `.claude/commands/<id>.md` | claude adapter,10 个命令入口 | 按指纹刷新 |
| `.cursor/commands/<id>.md` | cursor adapter | 按指纹刷新 |
| `.github/prompts/<id>.prompt.md` | copilot adapter | 按指纹刷新 |
| (codex) | 不生成项目级 prompts 文件,靠根 `AGENTS.md` 栅栏块 | 随栅栏块更新 |

每个 adapter 都是薄入口:执行时按序读取根 `AGENTS.md` 栅栏块 → `business-agent/business-profile.yaml` → `business-agent/core/command-manifest.yaml` → `business-agent/core/commands/<id>.md`,并遵循其中的 Execution Rules。

## 指纹与升级保护(preserveOnUpgrade)

- 所有生成文件头部带注释指纹 `generated-by: business-agent`(markdown/yaml 用注释;无法安全注释的文件跳过指纹)。
- `--upgrade` 只清理 / 覆盖**带指纹**的旧文件;同名但无指纹的文件视为用户自有内容,不覆盖,新内容写到 `<文件名>.business-agent-new`,并在结尾摘要中提示人工处理。
- `business-agent/business-profile.yaml` 与 `business-agent/INITIALIZATION_QUESTIONS.md` 是团队维护的内容,**任何参数组合(含 `--force`)都不会原地覆盖**;kit 新版本的模板一律落到 `.business-agent-new` 供人工比对合并。
- 初始化结束输出摘要:生成 / 保留 / 冲突三张清单,以及下一步指引(打开 AI 工具,运行 `/agent-status`)。

## 安全边界

初始化器在任何参数组合下都不会:

- 拉取远程代码、创建或切换分支、push 或 merge;
- 触发构建、部署、release 或 package publish;
- 写数据库或修改生产配置;
- 启动 scaffold 服务或调用任何 LLM API;
- 把密钥值写进任何生成文件——配置与文档只引用环境变量**键名**。

初始化后的运行时安全边界(fail-fast 配置、写操作人工确认、scope 绑定)见 [docs/security-baseline.md](./docs/security-baseline.md)。

## 接收方验收清单

正式使用前逐项确认:

- [ ] `node --version` ≥ 18;
- [ ] 在 kit 目录 `npm run check` 全绿(语法 / 脱敏 / 命令清单 / scaffold 冒烟 / init 冒烟);
- [ ] 初始化后 `business-agent/core/`、`business-agent/scaffold/`、`business-agent/business-profile.yaml`、`business-agent/local/` 齐备;
- [ ] target `.gitignore` 含 `business-agent/local/` 与 `.env`;
- [ ] 根 `AGENTS.md` 有 business-agent 栅栏块,且原有内容(如有)未被改动;
- [ ] 所选工具的全部 10 个命令入口已生成(claude/cursor/copilot),或 codex 场景下 AGENTS.md 栅栏块内含命令索引;
- [ ] 在真实 AI 工具中运行 `/agent-status`,能输出规划状态汇报;
- [ ] `business-agent/scaffold/` 内 `LLM_PROVIDER=mock GATEWAY_AUTH_TOKEN=dev-token npm run smoke` 通过;
- [ ] 初始化过程无任何远程 Git、部署、数据库或生产配置动作;
- [ ] 团队私有 denylist 建立在**仓库之外**,并纳入 `check:sanitized --extra-banned` 例行检查(见 [docs/security-baseline.md](./docs/security-baseline.md))。
