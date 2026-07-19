#!/usr/bin/env node
'use strict';
// End-to-end smoke test for bin/init-workspace.cjs:
//   1. fresh init into a temp workspace (claude,cursor,copilot) -> assert outputs
//   2. --upgrade -> business-profile preserved (+ .business-agent-new), core refreshed,
//      hand-edited (fingerprint-stripped) adapter file protected
//   3. pre-existing AGENTS.md with user content (codex) -> fence appended/replaced,
//      content outside the fence untouched
//   4. --dry-run writes nothing; unsupported tool fails loudly
//
// If kit/core or scaffold/ are not built yet (parallel build steps), this test
// aborts early with a readable message instead of a crash stack.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const KIT_ROOT = path.resolve(__dirname, '..');
const INIT = path.join(KIT_ROOT, 'bin', 'init-workspace.cjs');
const { loadCommandManifest } = require('../bin/check-command-manifest.cjs');

const FENCE_BEGIN = '<!-- BEGIN business-agent -->';
const FENCE_END = '<!-- END business-agent -->';
const FINGERPRINT = 'generated-by: business-agent';

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, label) {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(label);
    console.error(`  FAIL: ${label}`);
  }
}

function read(absPath) {
  return fs.readFileSync(absPath, 'utf8');
}

function runInit(args) {
  return spawnSync(process.execPath, [INIT, ...args], { encoding: 'utf8' });
}

function mkTemp(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `business-agent-smoke-${tag}-`));
}

// --- prerequisite gate: parallel build steps may not be done yet -------------
function checkPrerequisites() {
  const required = [
    'kit/core/command-manifest.yaml',
    'kit/core/commands',
    'kit/core/templates/business-profile.template.yaml',
    'kit/core/templates/initialization-questions.template.md',
    'scaffold',
    'kit/adapters/claude.yaml',
    'kit/adapters/cursor.yaml',
    'kit/adapters/copilot.yaml',
    'kit/adapters/codex.yaml',
    'kit/adapters/codebuddy.yaml',
    'kit/adapters/trae.yaml'
  ];
  const missing = required.filter((rel) => !fs.existsSync(path.join(KIT_ROOT, rel)));
  if (missing.length > 0) {
    console.error('smoke.test: 前置产物缺失,无法运行(kit/core 与 scaffold 由并行构建步骤产出,可能尚未就绪):');
    for (const rel of missing) console.error(`  - ${rel}`);
    process.exit(1);
  }
}

function main() {
  checkPrerequisites();
  for (const relPath of [
    'scaffold/local/state.json',
    'scaffold/local/state.json.lock',
    'scaffold/local/.state.json.tmp-4242-1',
    'scaffold/local/state.json.bak',
    'scaffold/local/state.json.lock.reaper'
  ]) {
    const ignored = spawnSync('git', ['-C', KIT_ROOT, 'check-ignore', '--quiet', '--', relPath], { encoding: 'utf8' });
    assert(ignored.status === 0, `源码仓忽略运行时状态产物: ${relPath}`);
  }
  const manifest = loadCommandManifest(path.join(KIT_ROOT, 'kit', 'core', 'command-manifest.yaml'));
  const commandIds = manifest.commands.map((c) => c.id);

  const tempDirs = [];
  try {
    // ------------------------------------------------------------------
    console.log('场景 1: 全新初始化(claude,cursor,copilot,codebuddy,trae)');
    const t1 = mkTemp('t1');
    tempDirs.push(t1);
    const initResult = runInit(['--target', t1, '--tools', 'claude,cursor,copilot,codebuddy,trae', '--yes']);
    assert(initResult.status === 0, `init 退出码应为 0,实际 ${initResult.status}\n${initResult.stdout}\n${initResult.stderr}`);
    if (initResult.status !== 0) throw new Error('初始化失败,后续断言跳过');

    assert(fs.existsSync(path.join(t1, 'business-agent', 'core', 'command-manifest.yaml')), 'business-agent/core/command-manifest.yaml 已复制');
    assert(fs.existsSync(path.join(t1, 'business-agent', 'core', 'commands')), 'business-agent/core/commands/ 已复制');
    assert(fs.existsSync(path.join(t1, 'business-agent', 'scaffold', 'package.json')), 'business-agent/scaffold/ 已复制');
    const profilePath = path.join(t1, 'business-agent', 'business-profile.yaml');
    assert(fs.existsSync(profilePath), 'business-profile.yaml 已生成');
    assert(read(profilePath).includes(FINGERPRINT), 'business-profile.yaml 带指纹');
    assert(fs.existsSync(path.join(t1, 'business-agent', 'INITIALIZATION_QUESTIONS.md')), 'INITIALIZATION_QUESTIONS.md 已生成');
    assert(fs.existsSync(path.join(t1, 'business-agent', 'local', 'README.md')), 'local/README.md 已生成');

    const gitignore = read(path.join(t1, '.gitignore'));
    assert(gitignore.includes('business-agent/local/'), '.gitignore 含 business-agent/local/');
    assert(gitignore.includes('business-agent/scaffold/local/'), '.gitignore 含 business-agent/scaffold/local/ 防御性规则');
    assert(gitignore.split(/\r?\n/).some((l) => l.trim() === '.env'), '.gitignore 含 .env');

    const scaffoldGitignorePath = path.join(t1, 'business-agent', 'scaffold', '.gitignore');
    assert(fs.existsSync(scaffoldGitignorePath), 'scaffold/gitignore.template 已物化为 scaffold/.gitignore');
    const scaffoldGitignore = read(scaffoldGitignorePath);
    assert(scaffoldGitignore.split(/\r?\n/).some((l) => l.trim() === '/local/'), 'scaffold/.gitignore 含根定位 /local/ 规则');

    const runtimeStateDir = path.join(t1, 'business-agent', 'scaffold', 'local');
    fs.mkdirSync(runtimeStateDir, { recursive: true });
    const runtimeArtifacts = [
      'business-agent/scaffold/local/state.json',
      'business-agent/scaffold/local/state.json.lock',
      'business-agent/scaffold/local/.state.json.tmp-4242-1',
      'business-agent/scaffold/local/state.json.bak',
      'business-agent/scaffold/local/state.json.lock.reaper'
    ];
    for (const relPath of runtimeArtifacts) {
      fs.writeFileSync(path.join(t1, relPath), 'synthetic runtime state\n');
    }
    const gitInit = spawnSync('git', ['-C', t1, 'init', '--quiet'], { encoding: 'utf8' });
    assert(gitInit.status === 0, `临时目标工作区可初始化 git: ${gitInit.stderr}`);
    for (const relPath of runtimeArtifacts) {
      const ignored = spawnSync('git', ['-C', t1, 'check-ignore', '--quiet', '--', relPath], { encoding: 'utf8' });
      assert(ignored.status === 0, `生成项目忽略运行时状态产物: ${relPath}`);
    }
    const trackedControl = 'business-agent/scaffold/src/local/state.json';
    fs.mkdirSync(path.dirname(path.join(t1, trackedControl)), { recursive: true });
    fs.writeFileSync(path.join(t1, trackedControl), 'negative control\n');
    const controlIgnored = spawnSync('git', ['-C', t1, 'check-ignore', '--quiet', '--', trackedControl], { encoding: 'utf8' });
    assert(controlIgnored.status === 1, '/local/ 根定位规则不会误忽略 src/local/');

    const agents = read(path.join(t1, 'AGENTS.md'));
    assert(agents.includes(FENCE_BEGIN) && agents.includes(FENCE_END), 'AGENTS.md 栅栏标记齐全');
    assert(agents.includes('/agent-status'), 'AGENTS.md 栅栏块含命令总览');

    for (const [dir, suffix] of [['.claude/commands', '.md'], ['.cursor/commands', '.md'], ['.github/prompts', '.prompt.md']]) {
      for (const id of commandIds) {
        const file = path.join(t1, dir, `${id}${suffix}`);
        if (!fs.existsSync(file)) {
          assert(false, `${dir}/${id}${suffix} 应存在`);
          continue;
        }
        const text = read(file);
        assert(text.includes('按序读取'), `${dir}/${id}${suffix} 含「按序读取」`);
        assert(text.includes(`business-agent/core/commands/${id}.md`), `${dir}/${id}${suffix} 指向自己的 core 契约`);
      }
    }
    const claudeDoc = read(path.join(t1, '.claude', 'commands', `${commandIds[0]}.md`));
    assert(claudeDoc.startsWith('---') && claudeDoc.includes('description:'), 'claude 命令文件带 front-matter description');

    for (const [tool, dir] of [['codebuddy', '.codebuddy'], ['trae', '.trae']]) {
      const insPath = path.join(t1, dir, 'instructions.md');
      if (!fs.existsSync(insPath)) {
        assert(false, `${dir}/instructions.md 应存在(${tool} instructions adapter)`);
        continue;
      }
      const ins = read(insPath);
      assert(ins.includes(FINGERPRINT), `${dir}/instructions.md 带指纹`);
      assert(ins.includes('按序读取'), `${dir}/instructions.md 含「按序读取」`);
      assert(ins.includes('business-agent/core/command-manifest.yaml'), `${dir}/instructions.md 指向 core manifest`);
      for (const id of commandIds) {
        assert(ins.includes(`/${id}`), `${dir}/instructions.md 命令索引含 /${id}`);
      }
      assert(!fs.existsSync(path.join(t1, dir, 'commands')), `${dir} 不生成逐命令入口目录`);
    }

    // ------------------------------------------------------------------
    console.log('场景 2: --upgrade(profile 保护 + core 刷新 + 无指纹文件保护)');
    fs.appendFileSync(profilePath, '\ncustom_note: keep-me-after-upgrade\n');
    const coreManifestPath = path.join(t1, 'business-agent', 'core', 'command-manifest.yaml');
    fs.appendFileSync(coreManifestPath, '\n# junk-line-should-be-refreshed\n');
    const editedAdapterPath = path.join(t1, '.claude', 'commands', `${commandIds[0]}.md`);
    fs.writeFileSync(editedAdapterPath, '# 用户手工改写,无指纹\n');
    fs.writeFileSync(path.join(t1, '.gitignore'), gitignore
      .split(/\r?\n/)
      .filter((line) => line.trim() !== 'business-agent/scaffold/local/')
      .join('\n'));
    fs.writeFileSync(scaffoldGitignorePath, scaffoldGitignore
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '/local/')
      .join('\n'));

    const upgradeResult = runInit(['--target', t1, '--tools', 'claude,cursor,copilot,codebuddy,trae', '--yes', '--upgrade']);
    assert(upgradeResult.status === 0, `upgrade 退出码应为 0,实际 ${upgradeResult.status}\n${upgradeResult.stdout}\n${upgradeResult.stderr}`);

    const profileAfter = read(profilePath);
    assert(profileAfter.includes('keep-me-after-upgrade'), 'upgrade 后 business-profile.yaml 未被覆盖(preserveOnUpgrade)');
    assert(fs.existsSync(`${profilePath}.business-agent-new`), 'upgrade 后写出 business-profile.yaml.business-agent-new');
    assert(!read(coreManifestPath).includes('junk-line-should-be-refreshed'), 'upgrade 后 core 已整体刷新(junk 行消失)');
    assert(read(path.join(t1, '.gitignore')).split(/\r?\n/).some((line) => line.trim() === 'business-agent/scaffold/local/'), 'upgrade 为旧工作区幂等补入 scaffold/local 忽略规则');
    assert(read(scaffoldGitignorePath).split(/\r?\n/).some((line) => line.trim() === '/local/'), 'upgrade 刷新 scaffold 后恢复 /local/ 忽略规则');
    assert(read(editedAdapterPath) === '# 用户手工改写,无指纹\n', '无指纹的同名命令文件未被覆盖');
    assert(fs.existsSync(`${editedAdapterPath}.business-agent-new`), '无指纹冲突文件旁写出 .business-agent-new');
    assert(!fs.existsSync(path.join(t1, 'business-agent', 'INITIALIZATION_QUESTIONS.md.business-agent-new')), '未改动的 preserve 文件不产生 .business-agent-new');

    // ------------------------------------------------------------------
    console.log('场景 3: 已有 AGENTS.md(用户内容)+ codex 工具');
    const t2 = mkTemp('t2');
    tempDirs.push(t2);
    const userContent = '# 我的项目\n\n用户自定义说明,初始化后必须原样保留。\n';
    fs.writeFileSync(path.join(t2, 'AGENTS.md'), userContent);
    const codexResult = runInit(['--target', t2, '--tools', 'codex', '--yes']);
    assert(codexResult.status === 0, `codex init 退出码应为 0,实际 ${codexResult.status}\n${codexResult.stdout}\n${codexResult.stderr}`);
    let agents2 = read(path.join(t2, 'AGENTS.md'));
    assert(agents2.startsWith(userContent.trimEnd().split('\n')[0]), 'AGENTS.md 用户内容仍在开头');
    assert(agents2.includes('用户自定义说明,初始化后必须原样保留。'), 'AGENTS.md 栅栏外用户内容原样保留');
    assert(agents2.includes(FENCE_BEGIN) && agents2.includes(FENCE_END), 'AGENTS.md 已追加栅栏块');
    assert(!fs.existsSync(path.join(t2, '.claude')), 'codex 模式不生成 .claude/commands');

    // tamper inside the fence, then upgrade -> fence restored in place
    agents2 = agents2.replace('# business-agent 工作流入口', '# TAMPERED-HEADING');
    fs.writeFileSync(path.join(t2, 'AGENTS.md'), agents2);
    const codexUpgrade = runInit(['--target', t2, '--tools', 'codex', '--yes', '--upgrade']);
    assert(codexUpgrade.status === 0, `codex upgrade 退出码应为 0,实际 ${codexUpgrade.status}`);
    const agents2After = read(path.join(t2, 'AGENTS.md'));
    assert(!agents2After.includes('TAMPERED-HEADING'), 'upgrade 原位替换栅栏块(篡改内容被恢复)');
    assert(agents2After.includes('用户自定义说明,初始化后必须原样保留。'), 'upgrade 后栅栏外用户内容依旧原样');
    assert(agents2After.indexOf(FENCE_BEGIN) === agents2After.lastIndexOf(FENCE_BEGIN), '栅栏块没有被重复追加');

    // ------------------------------------------------------------------
    console.log('场景 4: --dry-run 不落盘;不支持的工具明确报错');
    const t3 = mkTemp('t3');
    tempDirs.push(t3);
    const dryRun = runInit(['--target', t3, '--tools', 'claude', '--dry-run']);
    assert(dryRun.status === 0, `dry-run 退出码应为 0,实际 ${dryRun.status}\n${dryRun.stderr}`);
    assert(!fs.existsSync(path.join(t3, 'business-agent')), 'dry-run 未创建 business-agent/');
    assert(!fs.existsSync(path.join(t3, 'AGENTS.md')), 'dry-run 未创建 AGENTS.md');

    const unsupported = runInit(['--target', t3, '--tools', 'kiro', '--yes']);
    assert(unsupported.status !== 0, '不支持的工具应非零退出');
    assert((unsupported.stderr || '').includes('暂不支持'), '不支持的工具报错指向 support-matrix');

    const aliasDryRun = runInit(['--target', t3, '--tools', 'trea', '--dry-run']);
    assert(aliasDryRun.status === 0, `别名 trea 应归一为 trae 并通过,实际 ${aliasDryRun.status}\n${aliasDryRun.stderr}`);
    assert((aliasDryRun.stdout || '').includes('trae'), '别名 trea 的执行摘要按 trae 展示');
  } catch (err) {
    failed++;
    failures.push(String(err.message || err));
    console.error(`  ABORT: ${err.message || err}`);
  } finally {
    for (const dir of tempDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (cleanupErr) {
        /* best effort */
      }
    }
  }

  console.log('');
  if (failed > 0) {
    console.error(`smoke.test: FAIL(${passed} 通过 / ${failed} 失败)`);
    for (const failure of failures) console.error(`  - ${failure.split('\n')[0]}`);
    process.exit(1);
  }
  console.log(`smoke.test: PASS(${passed} 条断言全部通过)`);
}

main();
