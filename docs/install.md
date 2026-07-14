# 安装方式:tarball / Git / registry

Business Agent Kit 支持三种分发通道。当前版本 `0.2.0`(远程存在对应 git tag `v0.2.0`);**npm 包尚未发布**,registry 通道在包实际发布前只是形状说明。

通用前置:`node >= 22`(kit 与 scaffold 均零 npm 依赖,无需 `npm install`)。

## 通道一:tarball(推荐用于离线 / 受控分发)

分发方在 kit 仓库根目录打包:

```bash
npm pack
# 生成 business-agent-0.2.0.tgz
```

接收方两种用法:

```bash
# A. 全局安装,获得 business-agent-init 命令
npm install -g ./business-agent-0.2.0.tgz
cd /path/to/your-workspace
business-agent-init --target . --tools claude,cursor

# B. 只解包,不安装
tar -xzf business-agent-0.2.0.tgz     # 解出 package/ 目录
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

## 通道三:registry(包发布后)

包发布到 npm registry 之后(0.2.0 当前**尚未发布**),形状为:

```bash
npm install -g business-agent
business-agent-init --target . --tools claude

# 或免安装
npx --package=business-agent business-agent-init --target . --tools claude
```

发布本身由维护者按 [SECURITY.md](../SECURITY.md) 的脱敏义务人工执行,本 kit 的任何脚本都不会自动 publish。

## 安装后验收清单

无论哪个通道,正式使用前逐项确认:

- [ ] `node --version` ≥ 18;
- [ ] kit 源码目录内 `npm run check` 全绿(tarball 通道可跳过,分发方应已跑过并留证);
- [ ] `npm run check:sanitized` 零命中;
- [ ] 找一个**临时目录**试运行:`node <kit>/bin/init-workspace.cjs --target /tmp/ba-试装目录 --tools claude --yes`,确认生成 `business-agent/core/`、`business-agent/scaffold/`、`business-agent/business-profile.yaml`、`business-agent/local/`、根 `AGENTS.md` 栅栏块与 `.claude/commands/` 10 个入口;
- [ ] 试装目录里 `cd business-agent/scaffold && LLM_PROVIDER=mock GATEWAY_AUTH_TOKEN=dev-token npm run smoke` 通过;
- [ ] 确认初始化过程无远程 Git、部署、数据库动作;
- [ ] 正式工作区初始化后,按 [INIT.md](../INIT.md) 的接收方验收清单完整过一遍。

## 升级

任何通道升级后,在目标工作区重跑:

```bash
business-agent-init --target . --tools <你的工具> --upgrade
```

`business-agent/core/` 与 `business-agent/scaffold/` 会刷新;`business-profile.yaml` 与 `INITIALIZATION_QUESTIONS.md` 永不被原地覆盖(新版本写 `.business-agent-new`);已实例化的 `agent-gateway/` 不受影响。详见 [INIT.md](../INIT.md)。
