// stdio MCP 协议测试（MCP 步骤3验收）：spawn 真服务进程，逐行发 JSON-RPC，断言协议面与工具契约。
// 全程不触发浏览器（download 的非法参数在浏览器预检前就被拒）；状态目录指向临时目录避免污染真实状态。
// 运行: node test_mcp_protocol.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zhu-mcp-proto-'));
const child = spawn(process.execPath, [path.join(REPO, 'mcp', 'zhu-dl-server.mjs')], {
  env: { ...process.env, ZHU_DL_MCP_STATE_DIR: tmp, ZHU_DL_DEFAULT_OUT: tmp },
  stdio: ['pipe', 'pipe', 'pipe'],
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pending = new Map(); // id → resolve
let buf = '';
let protocolFailures = [];

child.stdout.on('data', chunk => {
  buf += chunk.toString('utf8');
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (e) {
      protocolFailures.push(`stdout 不是合法 JSON 行: ${line.slice(0, 120)}`);
      continue;
    }
    const waiter = pending.get(msg.id);
    if (waiter) { pending.delete(msg.id); waiter(msg); }
  }
});

function send(msg) {
  child.stdin.write(JSON.stringify(msg) + '\n');
}

/** 发请求并等待同 id 响应（带超时）。 */
function request(id, method, params = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`请求超时: ${method} (id=${id})`));
    }, 15000);
    pending.set(id, msg => { clearTimeout(timer); resolve(msg); });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

/** tools/call 并解析文本负载为 JSON（协议层返回 isError 时抛出）。 */
async function call(id, name, args = {}) {
  const res = await request(id, 'tools/call', { name, arguments: args });
  assert.ok(res.result, `${name} 应有 result`);
  const text = res.result.content?.[0]?.text ?? '';
  if (res.result.isError) {
    return { isError: true, text };
  }
  try { return { isError: false, data: JSON.parse(text), text }; } catch {
    return { isError: false, text };
  }
}

const passed = [];
const ok = msg => { console.log(`✓ ${msg}`); passed.push(msg); };

let exitCode = null;
let exited = false;
child.on('exit', (code) => { exitCode = code; exited = true; });

try {
  // ---------- initialize / ping ----------
  const init = await request(1, 'initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'zhu-test', version: '0' },
  });
  assert.equal(init.result.protocolVersion, '2024-11-05', 'protocolVersion 回显');
  assert.equal(init.result.serverInfo.name, 'zhu-downloader', 'serverInfo.name');
  assert.equal(init.result.serverInfo.version, '0.1.0', 'serverInfo.version');
  assert.ok(init.result.capabilities?.tools, 'capabilities.tools 声明');
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  ok('initialize：协议版本回显 + serverInfo + tools 能力声明');

  const pong = await request(2, 'ping');
  assert.deepEqual(pong.result, {});
  ok('ping → {}');

  // ---------- tools/list ----------
  const list = await request(3, 'tools/list');
  const tools = list.result.tools;
  const names = tools.map(t => t.name).sort();
  assert.deepEqual(names, [
    'zhu_dl_close', 'zhu_dl_collect', 'zhu_dl_download', 'zhu_dl_guide',
    'zhu_dl_open_manual', 'zhu_dl_retry', 'zhu_dl_status', 'zhu_dl_stop',
  ].sort(), '恰好 8 个工具且命名符合契约');
  for (const t of tools) {
    assert.equal(typeof t.description, 'string', `${t.name} 有描述`);
    assert.equal(t.inputSchema?.type, 'object', `${t.name} inputSchema 为 object`);
  }
  const byName = Object.fromEntries(tools.map(t => [t.name, t]));
  assert.deepEqual(byName.zhu_dl_guide.inputSchema.required ?? [], [], 'guide 无必填');
  assert.ok(byName.zhu_dl_download.inputSchema.properties.dois, 'download 有 dois 参数');
  assert.equal(byName.zhu_dl_status.inputSchema.properties.includeItems.enum.join(), 'problems,all,none', 'status includeItems 枚举');
  ok('tools/list：8 工具 schema 齐备');

  // ---------- zhu_dl_guide ----------
  const guide = await call(4, 'zhu_dl_guide');
  assert.equal(guide.isError, false);
  assert.ok(guide.text.includes('zhu_dl_open_manual') && guide.text.includes('zhu_dl_retry') && guide.text.includes('zhu_dl_close'), '规程含核心工具名');
  assert.ok(guide.text.includes('安全边界'), '规程含安全边界');
  ok('zhu_dl_guide：规程完整');

  // ---------- status（无 job → idle） ----------
  const idle = await call(5, 'zhu_dl_status', {});
  assert.equal(idle.isError, false);
  assert.equal(idle.data.state, 'idle', '无 job → state idle');
  ok('zhu_dl_status 无 job → {state:"idle"}');

  // ---------- 未知工具 ----------
  const unknown = await call(6, 'zhu_dl_nope', {});
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /Unknown tool/, '未知工具报 Unknown tool');
  ok('未知工具 → isError + Unknown tool');

  // ---------- 非法参数（CODE 可识别） ----------
  const badDoi = await call(7, 'zhu_dl_download', { dois: ['not-a-doi'] });
  assert.equal(badDoi.isError, true);
  assert.match(badDoi.text, /^ERROR: INVALID_ARGS: /, `坏 DOI → INVALID_ARGS（实际: ${badDoi.text.slice(0, 80)}）`);
  const badOut = await call(8, 'zhu_dl_download', { dois: ['10.1111/x'], outDir: 'relative/dir' });
  assert.equal(badOut.isError, true);
  assert.match(badOut.text, /^ERROR: INVALID_ARGS: /, '相对 outDir → INVALID_ARGS');
  const badConc = await call(9, 'zhu_dl_download', { dois: ['10.1111/x'], concurrency: 99 });
  assert.equal(badConc.isError, true);
  assert.match(badConc.text, /^ERROR: INVALID_ARGS: /, '并发 99 → INVALID_ARGS（范围校验在 bridge）');
  const badInclude = await call(10, 'zhu_dl_status', { includeItems: 'everything' });
  assert.equal(badInclude.isError, true);
  assert.match(badInclude.text, /^ERROR: INVALID_ARGS: /, 'includeItems 枚举外 → INVALID_ARGS');
  const noJob = await call(11, 'zhu_dl_open_manual', {});
  assert.equal(noJob.isError, true);
  assert.match(noJob.text, /^ERROR: NO_JOB: /, '无 job 时 open_manual → NO_JOB');
  ok('非法参数 → ERROR: <CODE>: 可识别');

  // ---------- 关闭 stdin → 5s 内退出码 0 ----------
  const t0 = Date.now();
  child.stdin.end();
  const deadline = Date.now() + 5000;
  while (!exited && Date.now() < deadline) await sleep(100);
  assert.ok(exited, '关闭 stdin 后 5s 内退出');
  assert.equal(exitCode, 0, `退出码 0（实际 ${exitCode}）`);
  const exitMs = Date.now() - t0;
  ok(`关闭 stdin → ${exitMs}ms 内退出码 0`);
} catch (e) {
  protocolFailures.push(e?.stack || String(e));
} finally {
  if (!exited) { child.stdin.end(); await sleep(300); child.kill(); }
  if (protocolFailures.length > 0) {
    console.error(`\n协议测试失败（${protocolFailures.length} 处）:`);
    for (const f of protocolFailures) console.error('  - ' + f.split('\n').slice(0, 6).join('\n    '));
    process.exitCode = 1;
  } else {
    console.log(`\n协议测试全部通过（${passed.length} 组断言）`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
