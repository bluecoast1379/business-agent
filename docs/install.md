# 安装方式:tarball / Git / registry

Business Agent Kit 支持三种分发通道。当前版本 `0.3.0`，对应 git tag `v0.3.0` 与 npm 包 `business-agent@0.3.0`。

通用前置:`node >= 22`(kit 与 scaffold 均零 npm 依赖,无需 `npm install`)。

## 通道一:tarball(推荐用于离线 / 受控分发)

分发方在 kit 仓库根目录打包:

```bash
npm pack
# 生成 business-agent-0.3.0.tgz
```

接收方两种用法:

```bash
# A. 全局安装,获得 business-agent-init 命令
npm install -g ./business-agent-0.3.0.tgz
cd /path/to/your-workspace
business-agent-init --target . --tools claude,cursor

# B. 只解包,不安装
tar -xzf business-agent-0.3.0.tgz     # 解出 package/ 目录
cd /path/to/your-workspace
node ../package/bin/init-workspace.cjs --target . --tools claude
```

## 通道二:Git checkout(推荐用于跟随源码演进)

```bash
# clone 到目标工作区之外的相邻目录
git clone <repo-url> business-agent
cd your-workspace
node ../business-agent/bin/init-workspace.cjs --target . --tools claude,cursor,copilot
```

- 需要可复现安装时,**用 commit 固定**:`git checkout <commit-sha>`——不要假定某个 tag 存在;
- 也可用 wrapper:`../business-agent/install.sh . --tools claude`(自动校验 node 版本后转发同一入口)。

## 通道三:registry

从 npm registry 安装:

```bash
npm install -g business-agent
business-agent-init --target . --tools claude

# 或免安装
npx --package=business-agent business-agent-init --target . --tools claude
```

发布由维护者创建 GitHub Release 后触发受信发布 workflow；本地 kit 命令不会自行 push 或 publish。发布前必须满足 [SECURITY.md](../SECURITY.md) 的脱敏义务与完整 release gate。

## 安装后验收清单

无论哪个通道,正式使用前逐项确认:

- [ ] `node --version` ≥ 22;
- [ ] kit 源码目录内 `npm run check` 全绿,包括 syntax/sanitized/manifest、adapter/template conformance、完整 Node tests、确定性 eval、HTTP smoke 与 release/package gate(tarball 通道可跳过,但分发方必须留证);
- [ ] `npm run check:sanitized` 零命中;
- [ ] 找一个**临时目录**试运行:`node <kit>/bin/init-workspace.cjs --target /tmp/ba-试装目录 --tools claude --yes`,确认生成 `business-agent/core/`、`business-agent/scaffold/`、`business-agent/business-profile.yaml`、`business-agent/local/`、根 `AGENTS.md` 栅栏块与 `.claude/commands/` 10 个入口;
- [ ] 试装目录里 `cd business-agent/scaffold && LLM_PROVIDER=mock GATEWAY_AUTH_TOKEN=development-token npm run smoke` 通过;
- [ ] 确认初始化过程无远程 Git、部署、数据库动作;
- [ ] 正式工作区初始化后,按 [INIT.md](../INIT.md) 的接收方验收清单完整过一遍。

## 升级

任何通道升级后,在目标工作区重跑:

```bash
business-agent-init --target . --tools <你的工具> --upgrade
```

`business-agent/core/` 与 `business-agent/scaffold/` 会刷新;`business-profile.yaml` 与 `INITIALIZATION_QUESTIONS.md` 永不被原地覆盖(新版本写 `.business-agent-new`);已实例化的 `agent-gateway/` 不受影响。详见 [INIT.md](../INIT.md)。

已实例化 gateway 若使用 production state,升级应用前还要按 [生产运行指南](./production-profile.md#6-状态迁移与回滚) 备份并演练 snapshot migration。初始化器升级与运行时数据迁移是两件事:前者不会替你修改生产 state,也不会自动部署或回滚。
