#!/usr/bin/env node
'use strict';
// Scaffold gate:
//   1. `node --check` every .js under scaffold/;
//   2. smoke-test the gateway with the deterministic MockProvider:
//      boot scaffold/src/index.js with LLM_PROVIDER=mock PORT=0, wait for the
//      `listening on <port>` stdout line, then assert:
//        GET  /health                 -> 200 (no auth)
//        POST /chat  (no token)       -> 401
//        POST /chat  (Bearer token)   -> 200, body contains the mock marker
//                                        "[mock] top customers" (mock calls the
//                                        demo tool first, per the contract)
//        GET  /status (Bearer token)  -> 200, costUsd is a number > 0
//      then kill the child and exit 0.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const KIT_ROOT = path.resolve(__dirname, '..');
const SCAFFOLD_DIR = path.join(KIT_ROOT, 'scaffold');
const ENTRY = path.join(SCAFFOLD_DIR, 'src', 'index.js');
const AUTH_TOKEN = 'test-token';
const BOOT_TIMEOUT_MS = 15000;
const REQUEST_TIMEOUT_MS = 5000;

function collectJsFiles(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== '.git') collectJsFiles(abs, out);
    } else if (entry.isFile() && /\.(js|mjs)$/.test(entry.name)) {
      out.push(abs);
    }
  }
}

function syntaxCheck() {
  const files = [];
  collectJsFiles(SCAFFOLD_DIR, files);
  if (files.length === 0) {
    console.error('check-scaffold: FAIL,scaffold/ 下没有任何 .js 文件');
    process.exit(1);
  }
  const failures = [];
  for (const file of files.sort()) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) {
      failures.push(`${path.relative(KIT_ROOT, file)}\n    ${(result.stderr || '').trim()}`);
    }
  }
  if (failures.length > 0) {
    console.error(`check-scaffold: FAIL(${failures.length} 个文件语法错误):`);
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
  }
  console.log(`check-scaffold: 语法检查通过(${files.length} 个 .js 文件)`);
}

function findKeyDeep(value, key) {
  if (value === null || typeof value !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(value, key)) return value[key];
  for (const child of Object.values(value)) {
    const found = findKeyDeep(child, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

// Plain node:http client (no global-fetch dependency, works on any Node).
function request(method, url, options) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers: (options && options.headers) || {} }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`请求超时(${REQUEST_TIMEOUT_MS}ms): ${method} ${url}`));
    });
    req.on('error', reject);
    if (options && options.body) req.write(options.body);
    req.end();
  });
}

function startGateway() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY], {
      cwd: SCAFFOLD_DIR,
      env: {
        ...process.env,
        LLM_PROVIDER: 'mock',
        GATEWAY_AUTH_TOKEN: AUTH_TOKEN,
        PORT: '0'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`启动超时(${BOOT_TIMEOUT_MS}ms)未见 "listening on <port>"\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, BOOT_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const line = stdout.split(/\r?\n/).find((l) => /listening on/i.test(l));
      if (line && !settled) {
        const numbers = line.match(/\d+/g);
        if (numbers && numbers.length > 0) {
          settled = true;
          clearTimeout(timer);
          resolve({ child, port: parseInt(numbers[numbers.length - 1], 10), getOutput: () => ({ stdout, stderr }) });
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`网关进程提前退出(code=${code})\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      }
    });
    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

function stopGateway(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    const killTimer = setTimeout(() => {
      child.kill('SIGKILL');
    }, 2000);
    child.on('exit', () => {
      clearTimeout(killTimer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

async function smoke() {
  const { child, port, getOutput } = await startGateway();
  const base = `http://127.0.0.1:${port}`;
  const authHeaders = { Authorization: `Bearer ${AUTH_TOKEN}`, 'Content-Type': 'application/json' };
  const steps = [];
  try {
    // 1. health without auth
    const health = await request('GET', `${base}/health`);
    if (health.status !== 200) throw new Error(`GET /health 期望 200,实际 ${health.status}:${health.text}`);
    steps.push('GET /health -> 200');

    // 2. chat without token -> 401
    const unauthorized = await request('POST', `${base}/chat`, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'smoke-session', message: 'hello' })
    });
    if (unauthorized.status !== 401) {
      throw new Error(`无 token POST /chat 期望 401,实际 ${unauthorized.status}:${unauthorized.text}`);
    }
    steps.push('POST /chat (no token) -> 401');

    // 3. chat with token -> 200 + deterministic mock marker (tool call round-trip)
    const chat = await request('POST', `${base}/chat`, {
      headers: authHeaders,
      body: JSON.stringify({ sessionId: 'smoke-session', message: 'top customers' })
    });
    if (chat.status !== 200) throw new Error(`POST /chat 期望 200,实际 ${chat.status}:${chat.text}`);
    if (!chat.text.includes('[mock] top customers')) {
      throw new Error(`POST /chat 响应未包含 MockProvider 确定性标记 "[mock] top customers":${chat.text.slice(0, 400)}`);
    }
    steps.push('POST /chat (Bearer) -> 200 + mock tool-call marker');

    // 4. status with token -> 200 + costUsd > 0 (cost tracker is wired up)
    const status = await request('GET', `${base}/status`, { headers: authHeaders });
    if (status.status !== 200) throw new Error(`GET /status 期望 200,实际 ${status.status}:${status.text}`);
    let statusJson;
    try {
      statusJson = JSON.parse(status.text);
    } catch (err) {
      throw new Error(`GET /status 响应不是 JSON:${status.text.slice(0, 400)}`);
    }
    const costUsd = findKeyDeep(statusJson, 'costUsd');
    if (typeof costUsd !== 'number' || !(costUsd > 0)) {
      throw new Error(`GET /status 的 costUsd 应为 > 0 的数字(证明 cost-tracker 已接线),实际: ${JSON.stringify(costUsd)}`);
    }
    steps.push(`GET /status -> 200, costUsd=${costUsd}`);
  } catch (err) {
    const output = getOutput();
    console.error('check-scaffold: FAIL,冒烟测试未通过:');
    console.error(`  ${err.message}`);
    if (steps.length > 0) console.error(`  已通过步骤: ${steps.join(' | ')}`);
    console.error(`  网关 stdout(尾部):\n${output.stdout.slice(-2000)}`);
    console.error(`  网关 stderr(尾部):\n${output.stderr.slice(-2000)}`);
    await stopGateway(child);
    process.exit(1);
  }
  await stopGateway(child);
  console.log('check-scaffold: PASS');
  for (const step of steps) console.log(`  - ${step}`);
}

async function main() {
  if (!fs.existsSync(SCAFFOLD_DIR) || !fs.existsSync(ENTRY)) {
    console.error('check-scaffold: FAIL,scaffold/src/index.js 不存在。');
    console.error('  提示:scaffold/ 由网关骨架构建步骤产出,可能尚未就绪。');
    process.exit(1);
  }
  syntaxCheck();
  await smoke();
}

main().catch((err) => {
  console.error(`check-scaffold: FAIL,意外错误: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
