#!/usr/bin/env node
'use strict';
// Unit tests for bin/check-command-manifest.cjs:
//   - the real kit/core manifest validates clean (skipped with a note if the
//     parallel core build step has not produced it yet);
//   - synthetic bad manifests are each rejected with the expected error;
//   - the mini-YAML parser handles the controlled subset and rejects the rest.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseYaml, loadCommandManifest, validateManifest } = require('../bin/check-command-manifest.cjs');

const KIT_ROOT = path.resolve(__dirname, '..');

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

function mkCase(name, manifestText, commandFiles) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `business-agent-manifest-${name}-`));
  const commandsDir = path.join(dir, 'commands');
  fs.mkdirSync(commandsDir);
  for (const file of commandFiles) {
    fs.writeFileSync(path.join(commandsDir, file), `# /${file.replace(/\.md$/, '')}\n`);
  }
  const manifestPath = path.join(dir, 'command-manifest.yaml');
  fs.writeFileSync(manifestPath, manifestText);
  return { dir, manifestPath, commandsDir };
}

const GOOD_MANIFEST = [
  'schema_version: "1.0"',
  'commands:',
  '  - id: alpha-review',
  '    title: "阶段甲"',
  '    summary: "第一个测试命令。"',
  '    entry: "core/commands/alpha-review.md"',
  '    order: 0',
  '    outputs: []',
  '    requires: []',
  '    implementation_gate: false',
  '    argument_hint: ""',
  '  - id: scaffold-gateway',
  '    title: "实例化网关"',
  '    summary: "实现闸门命令。"',
  '    entry: "core/commands/scaffold-gateway.md"',
  '    order: 1',
  '    outputs:',
  '      - "agent-gateway/"',
  '    requires:',
  '      - "agents/demo/00-blueprint.md"',
  '    implementation_gate: true',
  '    argument_hint: "[agent-slug]"',
  ''
].join('\n');

function main() {
  const tempDirs = [];
  try {
    // ------------------------------------------------------------------
    console.log('用例 1: 真实 kit/core manifest 校验通过');
    const realManifest = path.join(KIT_ROOT, 'kit', 'core', 'command-manifest.yaml');
    if (fs.existsSync(realManifest)) {
      const errors = validateManifest({
        manifestPath: realManifest,
        commandsDir: path.join(KIT_ROOT, 'kit', 'core', 'commands')
      });
      assert(errors.length === 0, `真实 manifest 应无错误,实际: ${errors.join(' | ')}`);
      const manifest = loadCommandManifest(realManifest);
      assert(manifest.commands.length === 10, `真实 manifest 应有 10 条命令,实际 ${manifest.commands.length}`);
    } else {
      console.log('  跳过:kit/core/command-manifest.yaml 尚未由 core 构建步骤产出。');
    }

    // ------------------------------------------------------------------
    console.log('用例 2: 合法合成 manifest 通过');
    const good = mkCase('good', GOOD_MANIFEST, ['alpha-review.md', 'scaffold-gateway.md']);
    tempDirs.push(good.dir);
    const goodErrors = validateManifest({ manifestPath: good.manifestPath, commandsDir: good.commandsDir });
    assert(goodErrors.length === 0, `合成合法 manifest 应无错误,实际: ${goodErrors.join(' | ')}`);

    // ------------------------------------------------------------------
    console.log('用例 3: 坏 manifest 逐类报错');
    const badCases = [
      {
        name: 'dup-id',
        text: GOOD_MANIFEST.replace('id: scaffold-gateway', 'id: alpha-review').replace('implementation_gate: true', 'implementation_gate: false'),
        files: ['alpha-review.md', 'scaffold-gateway.md'],
        expect: 'id 重复'
      },
      {
        name: 'missing-entry-file',
        text: GOOD_MANIFEST,
        files: ['alpha-review.md'],
        expect: 'entry 文件不存在'
      },
      {
        name: 'gate-on-wrong-command',
        text: GOOD_MANIFEST.replace('implementation_gate: false', 'implementation_gate: true'),
        files: ['alpha-review.md', 'scaffold-gateway.md'],
        expect: '只允许出现在 scaffold-gateway'
      },
      {
        name: 'orphan-file',
        text: GOOD_MANIFEST,
        files: ['alpha-review.md', 'scaffold-gateway.md', 'stray-command.md'],
        expect: '孤儿命令文件'
      },
      {
        name: 'missing-title',
        text: GOOD_MANIFEST.replace('    title: "阶段甲"\n', ''),
        files: ['alpha-review.md', 'scaffold-gateway.md'],
        expect: '缺少必填字段 title'
      },
      {
        name: 'missing-outputs',
        text: GOOD_MANIFEST.replace('    outputs: []\n', ''),
        files: ['alpha-review.md', 'scaffold-gateway.md'],
        expect: 'outputs 必须是列表'
      },
      {
        name: 'bad-order',
        text: GOOD_MANIFEST.replace('order: 1', 'order: 0'),
        files: ['alpha-review.md', 'scaffold-gateway.md'],
        expect: 'order 重复'
      },
      {
        name: 'unsupported-yaml',
        text: GOOD_MANIFEST.replace('summary: "第一个测试命令。"', 'summary: |'),
        files: ['alpha-review.md', 'scaffold-gateway.md'],
        expect: '解析失败'
      }
    ];
    for (const badCase of badCases) {
      const built = mkCase(badCase.name, badCase.text, badCase.files);
      tempDirs.push(built.dir);
      const errors = validateManifest({ manifestPath: built.manifestPath, commandsDir: built.commandsDir });
      assert(
        errors.some((e) => e.includes(badCase.expect)),
        `坏用例 ${badCase.name} 应报「${badCase.expect}」,实际: ${errors.join(' | ') || '(无错误)'}`
      );
    }

    // ------------------------------------------------------------------
    console.log('用例 4: mini-YAML 解析器子集行为');
    const doc = parseYaml(
      ['top: 1', 'flag: true', 'empty: []', 'inline: [a, "b c", 2]', 'nested:', '  child: "x"', 'items:', '  - one', '  - two'].join('\n'),
      '<unit>'
    );
    assert(doc.top === 1 && doc.flag === true, '标量: 数字与布尔');
    assert(Array.isArray(doc.empty) && doc.empty.length === 0, '空行内列表 []');
    assert(doc.inline.length === 3 && doc.inline[1] === 'b c' && doc.inline[2] === 2, '行内列表与引号');
    assert(doc.nested.child === 'x', '嵌套映射');
    assert(doc.items.join(',') === 'one,two', '块列表标量');

    let threw = '';
    try {
      parseYaml('a: &anchor 1', '<unit>');
    } catch (err) {
      threw = err.message;
    }
    assert(threw.includes('锚点'), '锚点语法应报错');
    threw = '';
    try {
      parseYaml('a:\n\tb: 1', '<unit>');
    } catch (err) {
      threw = err.message;
    }
    assert(threw.includes('Tab'), 'Tab 缩进应报错');
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
    console.error(`manifest.test: FAIL(${passed} 通过 / ${failed} 失败)`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`manifest.test: PASS(${passed} 条断言全部通过)`);
}

main();
