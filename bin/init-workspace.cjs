#!/usr/bin/env node
'use strict';
// business-agent workspace initializer.
//
// Copies the methodology core + gateway scaffold into a target workspace,
// renders user-owned seed files, maintains the AGENTS.md fence block and the
// per-tool thin command adapters. Safe to re-run: generated files carry a
// fingerprint comment; user-owned files are never overwritten in place.
//
// Usage:
//   node bin/init-workspace.cjs --target <dir> [--tools claude,cursor,copilot,codex]
//                               [--yes] [--dry-run] [--upgrade] [--force]

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { parseYaml, loadCommandManifest } = require('./check-command-manifest.cjs');

const KIT_ROOT = path.resolve(__dirname, '..');
const FINGERPRINT = 'generated-by: business-agent';
const FENCE_BEGIN = '<!-- BEGIN business-agent -->';
const FENCE_END = '<!-- END business-agent -->';
const NEW_SUFFIX = '.business-agent-new';
const SUPPORTED_TOOLS = ['claude', 'cursor', 'copilot', 'codex'];
const GITIGNORE_ENTRIES = ['business-agent/local/', '.env'];

// ---------------------------------------------------------------------------
// CLI plumbing
// ---------------------------------------------------------------------------

function usage() {
  return [
    '用法: node bin/init-workspace.cjs --target <dir> [选项]',
    '',
    '选项:',
    '  --target <dir>   目标工作区根目录(必填)。',
    '  --tools <csv>    接入的 AI 工具,逗号分隔;支持 claude,cursor,copilot,codex;默认 claude。',
    '  --yes, -y        非交互模式,跳过确认。',
    '  --dry-run        只展示计划动作,不写磁盘。',
    '  --upgrade        升级模式:刷新 core/scaffold 与带指纹的生成文件;',
    '                   business-profile.yaml 等人工维护文件永不原地覆盖(新版写 *.business-agent-new)。',
    '  --force          连同无指纹的同名生成文件一起覆盖(preserveOnUpgrade 文件仍不覆盖)。',
    '  --help, -h       显示本帮助。'
  ].join('\n');
}

function parseArgs(argv) {
  const options = { target: '', tools: ['claude'], yes: false, dryRun: false, upgrade: false, force: false };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--target') options.target = argv[++i] || '';
    else if (arg === '--tools') options.tools = String(argv[++i] || '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
    else if (arg === '--yes' || arg === '-y') options.yes = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--upgrade') options.upgrade = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--help' || arg === '-h') { console.log(usage()); process.exit(0); }
    else { console.error(`未知参数: ${arg}\n\n${usage()}`); process.exit(2); }
  }
  return options;
}

function fatal(message) {
  console.error(`init-workspace: ${message}`);
  process.exit(2);
}

function confirmOrExit(question) {
  if (!process.stdin.isTTY) {
    fatal('非交互环境(stdin 不是 TTY),请加 --yes 确认执行,或先用 --dry-run 预览。');
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} (y/N) `, (answer) => {
      rl.close();
      if (!/^y(es)?$/i.test(answer.trim())) {
        console.log('已取消,未写入任何文件。');
        process.exit(0);
      }
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// fingerprint & managed writes
// ---------------------------------------------------------------------------

function hasFingerprintText(text) {
  return String(text).slice(0, 600).includes(FINGERPRINT);
}

function fingerprintComment(relPath) {
  const ext = path.extname(relPath).toLowerCase();
  if (ext === '.md') return `<!-- ${FINGERPRINT} -->`;
  if (ext === '.yaml' || ext === '.yml') return `# ${FINGERPRINT}`;
  return null; // file type without a comment syntax: skip fingerprint
}

function withFingerprint(relPath, content) {
  const comment = fingerprintComment(relPath);
  if (!comment || hasFingerprintText(content)) return content;
  return `${comment}\n${content}`;
}

class Workspace {
  constructor(targetDir, options) {
    this.target = targetDir;
    this.options = options;
    this.created = [];
    this.updated = [];
    this.preserved = [];
    this.conflicts = [];
    this.notes = [];
  }

  rel(absPath) {
    return path.relative(this.target, absPath) || '.';
  }

  writeRaw(absPath, content) {
    if (this.options.dryRun) return;
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content);
  }

  /**
   * Write a kit-managed file.
   * preserve=true marks a user-owned seed (preserveOnUpgrade): once it exists
   * it is NEVER overwritten in place (not even with --force); a differing new
   * version is parked next to it as <name>.business-agent-new.
   */
  writeManaged(absPath, content, { preserve = false } = {}) {
    const rel = this.rel(absPath);
    if (!fs.existsSync(absPath)) {
      this.writeRaw(absPath, content);
      this.created.push(rel);
      return;
    }
    const existing = fs.readFileSync(absPath, 'utf8');
    if (existing === content) {
      this.preserved.push(`${rel}(内容一致)`);
      return;
    }
    if (preserve) {
      this.writeRaw(absPath + NEW_SUFFIX, content);
      this.preserved.push(`${rel}(人工维护,永不原地覆盖)`);
      this.conflicts.push(`${rel}${NEW_SUFFIX} — 新版本模板已写在旁边,请人工比对合并`);
      return;
    }
    if (hasFingerprintText(existing) || this.options.force) {
      this.writeRaw(absPath, content);
      this.updated.push(rel);
      return;
    }
    this.writeRaw(absPath + NEW_SUFFIX, content);
    this.conflicts.push(`${rel}${NEW_SUFFIX} — 同名文件无指纹(疑似人工修改),未覆盖,新版本已写在旁边`);
  }

  /** Copy a kit-owned tree (core/scaffold): always refreshed as a whole. */
  copyTree(srcDir, destDir, label) {
    const existedBefore = fs.existsSync(destDir);
    if (!this.options.dryRun) {
      if (existedBefore) fs.rmSync(destDir, { recursive: true, force: true });
    }
    const count = this.copyDirRecursive(srcDir, destDir);
    const rel = this.rel(destDir);
    (existedBefore ? this.updated : this.created).push(`${rel}/(${label},${count} 个文件${existedBefore ? ',整目录刷新' : ''})`);
  }

  copyDirRecursive(srcDir, destDir) {
    let count = 0;
    if (!this.options.dryRun) fs.mkdirSync(destDir, { recursive: true });
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      if (entry.name === '.DS_Store' || entry.name === 'node_modules') continue;
      const src = path.join(srcDir, entry.name);
      // npm never packs files literally named ".gitignore", so the scaffold
      // ships one as "gitignore.template"; materialize the real name on copy
      // (it protects the receiver's .env once the scaffold is instantiated).
      const destName = entry.isFile() && entry.name === 'gitignore.template' ? '.gitignore' : entry.name;
      const dest = path.join(destDir, destName);
      if (entry.isDirectory()) {
        count += this.copyDirRecursive(src, dest);
      } else if (entry.isFile()) {
        if (!this.options.dryRun) fs.copyFileSync(src, dest);
        count++;
      }
    }
    return count;
  }
}

// ---------------------------------------------------------------------------
// content builders
// ---------------------------------------------------------------------------

function yamlQuote(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function buildFenceBlock(commands) {
  const rows = commands.map((c) => `| ${c.order} | \`/${c.id}\` | ${c.title} | ${c.summary} |`);
  return [
    FENCE_BEGIN,
    `<!-- ${FINGERPRINT} -->`,
    '',
    '# business-agent 工作流入口',
    '',
    '本工作区已初始化 business-agent(业务 AI agent 规划与落地工作流)。AI 工具执行任一工作流命令时,按序读取:',
    '',
    '1. 本栅栏块(总入口与使用约定)',
    '2. `business-agent/business-profile.yaml`(业务画像,人工维护)',
    '3. `business-agent/core/command-manifest.yaml`(命令清单与产物契约)',
    '4. `business-agent/core/commands/<id>.md`(对应命令的阶段契约)',
    '',
    '## 命令总览',
    '',
    '| 顺序 | 命令 | 名称 | 说明 |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    '## 使用约定',
    '',
    '- 建议路径:先做组合规划(`/discover-business` → `/map-opportunities` → `/plan-roadmap`),再逐个落地 agent(`/design-agent` → `/define-tools` → `/scaffold-gateway` → `/harden-agent` → `/eval-agent` → `/operate-agent`);随时用 `/agent-status` 查看进度与缺口。',
    '- 私有值(密钥、内部域名、真实业务数据)只放 `business-agent/local/`(已加入 .gitignore);工作流文档只登记「键名与用途」,严禁写入真实值。',
    '- `/scaffold-gateway` 带实现闸门:蓝图(00-blueprint)与工具契约(01-tool-contracts)齐备、且蓝图中「待确认项」清空后,才进入写代码阶段。',
    FENCE_END
  ].join('\n');
}

function buildCommandDoc(command, adapter) {
  const lines = [];
  if (adapter.frontmatter) {
    lines.push('---');
    lines.push(`description: ${yamlQuote(command.summary)}`);
    if (command.argument_hint) lines.push(`argument-hint: ${yamlQuote(command.argument_hint)}`);
    lines.push('---');
  }
  lines.push(`<!-- ${FINGERPRINT} -->`);
  lines.push('');
  lines.push(`# /${command.id} ${command.title}`);
  lines.push('');
  lines.push(String(command.summary));
  lines.push('');
  lines.push('本文件为薄入口。执行时按序读取:');
  lines.push('');
  lines.push('1. 根 `AGENTS.md` 的 business-agent 栅栏块(总入口与使用约定)');
  lines.push('2. `business-agent/business-profile.yaml`(业务画像)');
  lines.push('3. `business-agent/core/command-manifest.yaml`(命令清单与产物契约)');
  lines.push(`4. \`business-agent/core/commands/${command.id}.md\`(本命令的阶段契约)`);
  lines.push('');
  lines.push('并遵循其中的 Execution Rules 执行,产物写入 manifest 登记的 outputs 路径。');
  return lines.join('\n') + '\n';
}

function buildLocalReadme() {
  return [
    `<!-- ${FINGERPRINT} -->`,
    '',
    '# business-agent/local — 私有值放这里',
    '',
    '本目录已加入 `.gitignore`,用于存放**不进版本库**的私有内容:',
    '',
    '- 密钥 / token 的真实值(工作流文档里只登记键名与用途)',
    '- 内部域名、内网地址、真实企业与人员信息',
    '- 私有 denylist(配合 `check-sanitized --extra-banned` 使用)',
    '',
    '任何工作流产物(discovery、蓝图、工具契约……)引用敏感信息时,只写',
    '「键名 + 存放位置(本目录)」,不要把真实值复制进文档。',
    ''
  ].join('\n');
}

// ---------------------------------------------------------------------------
// steps
// ---------------------------------------------------------------------------

function checkSources(tools) {
  const missing = [];
  const need = [
    ['kit/core/command-manifest.yaml', '命令清单(core 内容构建步骤产出)'],
    ['kit/core/commands', '命令契约目录(core 内容构建步骤产出)'],
    ['kit/core/templates/business-profile.template.yaml', '业务画像模板(core 内容构建步骤产出)'],
    ['kit/core/templates/initialization-questions.template.md', '初始化问题清单模板(core 内容构建步骤产出)'],
    ['scaffold', '网关骨架(scaffold 构建步骤产出)']
  ];
  for (const tool of tools) need.push([`kit/adapters/${tool}.yaml`, `${tool} 工具 adapter 描述`]);
  for (const [rel, label] of need) {
    if (!fs.existsSync(path.join(KIT_ROOT, rel))) missing.push(`  - ${rel}(${label})`);
  }
  if (missing.length > 0) {
    fatal(`kit 源文件缺失,无法初始化:\n${missing.join('\n')}`);
  }
}

function loadAdapter(tool) {
  const adapterPath = path.join(KIT_ROOT, 'kit', 'adapters', `${tool}.yaml`);
  const doc = parseYaml(fs.readFileSync(adapterPath, 'utf8'), adapterPath);
  if (!doc || typeof doc !== 'object') fatal(`adapter 描述损坏: ${adapterPath}`);
  return {
    tool,
    status: String(doc.status || ''),
    outputDir: doc.output_dir ? String(doc.output_dir) : '',
    filePattern: doc.file_pattern ? String(doc.file_pattern) : '{id}.md',
    frontmatter: doc.frontmatter === true
  };
}

function applyAgentsFence(ws, commands) {
  const agentsPath = path.join(ws.target, 'AGENTS.md');
  const block = buildFenceBlock(commands);
  if (!fs.existsSync(agentsPath)) {
    ws.writeRaw(agentsPath, block + '\n');
    ws.created.push('AGENTS.md(新建,含栅栏块)');
    return;
  }
  const existing = fs.readFileSync(agentsPath, 'utf8');
  const beginIdx = existing.indexOf(FENCE_BEGIN);
  const endIdx = existing.indexOf(FENCE_END);
  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    const next = existing.slice(0, beginIdx) + block + existing.slice(endIdx + FENCE_END.length);
    if (next === existing) {
      ws.preserved.push('AGENTS.md(栅栏块内容一致)');
    } else {
      ws.writeRaw(agentsPath, next);
      ws.updated.push('AGENTS.md(仅原位替换栅栏块,栅栏外内容未动)');
    }
    return;
  }
  if (beginIdx !== -1 || endIdx !== -1) {
    ws.writeRaw(agentsPath + NEW_SUFFIX, block + '\n');
    ws.conflicts.push(`AGENTS.md — 栅栏标记不完整(只找到 BEGIN/END 之一),未修改;完整栅栏块已写到 AGENTS.md${NEW_SUFFIX}`);
    return;
  }
  const joiner = existing.endsWith('\n') ? '\n' : '\n\n';
  ws.writeRaw(agentsPath, existing + joiner + block + '\n');
  ws.updated.push('AGENTS.md(已有文件,追加栅栏块;原内容未动)');
}

function ensureGitignore(ws) {
  const gitignorePath = path.join(ws.target, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    ws.writeRaw(gitignorePath, `# ${FINGERPRINT}\n${GITIGNORE_ENTRIES.join('\n')}\n`);
    ws.created.push('.gitignore(含 business-agent/local/ 与 .env)');
    return;
  }
  const existing = fs.readFileSync(gitignorePath, 'utf8');
  const lines = existing.split(/\r?\n/).map((l) => l.trim());
  const toAdd = GITIGNORE_ENTRIES.filter((entry) => !lines.includes(entry));
  if (toAdd.length === 0) {
    ws.preserved.push('.gitignore(条目已齐)');
    return;
  }
  const joiner = existing.endsWith('\n') ? '' : '\n';
  ws.writeRaw(gitignorePath, `${existing}${joiner}\n# business-agent\n${toAdd.join('\n')}\n`);
  ws.updated.push(`.gitignore(幂等追加: ${toAdd.join(', ')})`);
}

function generateAdapterFiles(ws, tools, commands) {
  for (const tool of tools) {
    const adapter = loadAdapter(tool);
    if (!adapter.outputDir) {
      ws.notes.push(`${tool}: 不生成项目级命令文件(${adapter.status}),通过根 AGENTS.md 栅栏块接入。`);
      continue;
    }
    for (const command of commands) {
      const fileName = adapter.filePattern.replace('{id}', command.id);
      const absPath = path.join(ws.target, adapter.outputDir, fileName);
      ws.writeManaged(absPath, buildCommandDoc(command, adapter));
    }
    ws.notes.push(`${tool}: 命令入口生成于 ${adapter.outputDir}/(${commands.length} 条)。`);
  }
}

function printSummary(ws, options) {
  const mode = options.dryRun ? '演练(--dry-run,未写磁盘)' : options.upgrade ? '升级(--upgrade)' : '初始化';
  console.log('');
  console.log('========================================');
  console.log(`business-agent init 摘要 — 模式: ${mode}`);
  console.log(`目标工作区: ${ws.target}`);
  console.log(`接入工具: ${options.tools.join(', ')}`);
  console.log('----------------------------------------');
  const sections = [
    ['新建', ws.created, '+'],
    ['刷新/覆盖', ws.updated, '~'],
    ['保留不动', ws.preserved, '='],
    [`冲突(新版已写 *${NEW_SUFFIX})`, ws.conflicts, '!']
  ];
  for (const [label, items, mark] of sections) {
    console.log(`${label} (${items.length}):`);
    for (const item of items) console.log(`  ${mark} ${item}`);
  }
  if (ws.notes.length > 0) {
    console.log('----------------------------------------');
    for (const note of ws.notes) console.log(`  * ${note}`);
  }
  console.log('----------------------------------------');
  console.log('下一步:');
  console.log('  1. 编辑 business-agent/business-profile.yaml,把 <TODO> 占位填成你的业务画像;');
  console.log('  2. 查看 business-agent/INITIALIZATION_QUESTIONS.md,补齐未决问题;');
  console.log('  3. 打开你的 AI 工具(如 Claude Code),运行 /agent-status 查看规划状态与下一步命令;');
  console.log('  4. 私有值只放 business-agent/local/(已 gitignore),文档里只登记键名与用途。');
  console.log('========================================');
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const options = parseArgs(process.argv);
  if (!options.target) fatal(`缺少 --target 参数。\n\n${usage()}`);
  if (options.tools.length === 0) options.tools = ['claude'];
  for (const tool of options.tools) {
    if (!SUPPORTED_TOOLS.includes(tool)) {
      fatal(`工具 "${tool}" 暂不支持,见 docs/support-matrix.md(当前支持: ${SUPPORTED_TOOLS.join(', ')})。`);
    }
  }
  options.tools = [...new Set(options.tools)];

  const target = path.resolve(options.target);
  checkSources(options.tools);

  const manifest = loadCommandManifest(path.join(KIT_ROOT, 'kit', 'core', 'command-manifest.yaml'));
  const commands = [...manifest.commands].sort((a, b) => (a.order || 0) - (b.order || 0));

  const baDir = path.join(target, 'business-agent');
  if (fs.existsSync(baDir) && !options.upgrade && !options.force) {
    fatal(`目标已存在 ${path.join(path.basename(target), 'business-agent')}/。\n  升级请加 --upgrade;确要覆盖生成文件请加 --force;先看差异请加 --dry-run。`);
  }

  console.log(`init-workspace: 目标 ${target}`);
  console.log(`  工具: ${options.tools.join(', ')};模式: ${options.dryRun ? 'dry-run' : options.upgrade ? 'upgrade' : 'init'}${options.force ? ' + force' : ''}`);
  if (!options.yes && !options.dryRun) {
    await confirmOrExit('将按上述配置写入目标工作区,继续?');
  }

  const ws = new Workspace(target, options);
  if (!options.dryRun) fs.mkdirSync(target, { recursive: true });

  // 1. kit-owned trees: methodology core + gateway scaffold (always refreshed)
  ws.copyTree(path.join(KIT_ROOT, 'kit', 'core'), path.join(baDir, 'core'), '方法论内核');
  ws.copyTree(path.join(KIT_ROOT, 'scaffold'), path.join(baDir, 'scaffold'), '网关骨架');

  // 2. user-owned seeds (preserveOnUpgrade: never overwritten in place)
  const profileTemplate = fs.readFileSync(path.join(KIT_ROOT, 'kit', 'core', 'templates', 'business-profile.template.yaml'), 'utf8');
  ws.writeManaged(path.join(baDir, 'business-profile.yaml'), withFingerprint('business-profile.yaml', profileTemplate), { preserve: true });
  const questionsTemplate = fs.readFileSync(path.join(KIT_ROOT, 'kit', 'core', 'templates', 'initialization-questions.template.md'), 'utf8');
  ws.writeManaged(path.join(baDir, 'INITIALIZATION_QUESTIONS.md'), withFingerprint('INITIALIZATION_QUESTIONS.md', questionsTemplate), { preserve: true });

  // 3. private value drop zone + gitignore protection
  if (!options.dryRun) fs.mkdirSync(path.join(baDir, 'local'), { recursive: true });
  ws.writeManaged(path.join(baDir, 'local', 'README.md'), buildLocalReadme());
  ensureGitignore(ws);

  // 4. AGENTS.md fence block (tool-neutral entry, also the codex adapter)
  applyAgentsFence(ws, commands);

  // 5. per-tool thin command adapters
  generateAdapterFiles(ws, options.tools, commands);

  printSummary(ws, options);
}

main().catch((err) => {
  console.error(`init-workspace: 意外错误: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
