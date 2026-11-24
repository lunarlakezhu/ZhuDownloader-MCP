// 网页版批次运行器离线测试：用假下载函数验证编排语义（不联网）。
// 覆盖：已存在跳过、失败重试、「需人工」不重试、failed.txt 写入、优雅停止、空清单拒绝。
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { BatchRunner } from './webui/batch.mjs';

const passed = [];
const fail = msg => { console.error(`✗ ${msg}`); process.exit(1); };
const ok = msg => { console.log(`✓ ${msg}`); passed.push(msg); };

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 按 DOI 脚本化返回 downloadOne 形状的结果。 */
function fakeDownload(script, calls, delay = 20) {
  return async (doi, outDir, { onPhase } = {}) => {
    calls.push(doi);
    onPhase?.('resolving');
    await sleep(delay);
    onPhase?.('downloading', { publisher: 'nature', note: '假装在下载' });
    const s = script[doi] ?? { status: 'ok', publisher: 'nature', bytes: 2048 };
    return {
      doi, publisher: s.publisher ?? 'nature', status: s.status,
      path: s.status === 'ok' ? path.join(outDir, 'fake.pdf') : '',
      bytes: s.bytes ?? 0, durationMs: delay,
      reason: s.reason ?? '', resolveUrl: s.resolveUrl ?? `https://nature.com/${doi}`,
      permanent: s.permanent ?? false,
    };
  };
}

function makeRunner(script, events, existingFiles = new Set(), delay = 20) {
  const calls = [];
  const runner = new BatchRunner({
    onEvent: e => events.push(e),
    downloadFn: fakeDownload(script, calls, delay),
    existingFn: (doi, outDir) => {
      // 与生产 existingPdf 的契约一致：只在文件真实存在时返回路径
      if (!existingFiles.has(doi)) return null;
      const p = path.join(outDir, `${doi.replace(/[^a-zA-Z0-9.-]/g, '_')}.pdf`);
      fs.writeFileSync(p, '%PDF-fake');
      return p;
    },
  });
  return { runner, calls };
}

// ---------- 场景 1：混合批次 ----------

const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'zhu-batch-'));
const script1 = {
  '10.1001/ok': { status: 'ok', bytes: 4096 },
  '10.1001/bad': { status: 'failed', reason: '内容非PDF(3KB)' },
  '10.1001/man': { status: 'manual-required', reason: 'Cloudflare验证' },
};
const events1 = [];
const { runner: r1, calls: calls1 } = makeRunner(script1, events1, new Set(['10.1001/have']));
const summary1 = await r1.run(
  '# 注释行\n10.1001/ok  标题A\n10.1001/bad.\n10.1001/man\n10.1001/have\n这行没有DOI',
  { outDir: dir1, concurrency: 2, retries: 1 },
);

assert.strictEqual(summary1.total, 4, '去重与解析');
assert.strictEqual(summary1.skipped, 1, '跳过无法识别行');
assert.strictEqual(summary1.ok, 1);
assert.strictEqual(summary1.failed, 1);
assert.strictEqual(summary1.manual, 1);
assert.strictEqual(summary1.exists, 1);
assert.deepStrictEqual(summary1.redoDois, ['10.1001/bad', '10.1001/man'], 'failed.txt 内容 = 失败 + 需人工');
assert.ok(fs.readFileSync(path.join(dir1, 'failed.txt'), 'utf8').startsWith('10.1001/bad\n10.1001/man\n'), 'failed.txt 落盘');

const bad = r1.snapshot.items.find(it => it.doi === '10.1001/bad');
assert.strictEqual(bad.attempt, 2, '失败条目重试到上限');
assert.strictEqual(bad.status, 'failed');
const man = r1.snapshot.items.find(it => it.doi === '10.1001/man');
assert.strictEqual(man.attempt, 1, '需人工不重试');
const have = r1.snapshot.items.find(it => it.doi === '10.1001/have');
assert.strictEqual(have.status, 'exists', '已存在跳过且不调下载函数');
assert.strictEqual(calls1.filter(d => d === '10.1001/have').length, 0);
assert.strictEqual(r1.snapshot.state, 'finished');
assert.strictEqual(events1[0].type, 'start');
assert.strictEqual(events1.at(-1).type, 'done');
ok('场景1 混合批次：跳过/重试/人工/failed.txt/事件序列');

// ---------- 场景 2：批次结束后可再次发起（不残留 running 状态） ----------

const summary2 = await r1.run('10.1001/ok', { outDir: dir1, concurrency: 1, retries: 0 });
assert.strictEqual(summary2.ok, 1, '结束后重跑正常受理');
assert.strictEqual(r1.isRunning, false);
ok('场景2 批次结束后可再次发起');

// ---------- 场景 3：优雅停止 ----------

const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'zhu-batch-'));
const script3 = { '10.3001/a': { status: 'ok' }, '10.3001/b': { status: 'ok' }, '10.3001/c': { status: 'ok' } };
const events3 = [];
const { runner: r3 } = makeRunner(script3, events3, new Set(), 150);
const runP = r3.run('10.3001/a\n10.3001/b\n10.3001/c', { outDir: dir3, concurrency: 1, retries: 0 });
// 第一篇下载中（150ms）就停止：并发 1，b/c 不应再被领取；a 跑完（优雅）
await sleep(60);
assert.strictEqual(r3.isRunning, true);
r3.stop();
const summary3 = await runP;
assert.ok(summary3.aborted, 'summary 标记 aborted');
assert.strictEqual(summary3.ok, 1, '停止后只完成了进行中的那篇');
assert.strictEqual(r3.isRunning, false);
ok('场景3 优雅停止：进行中的跑完，其余不再领取');

// ---------- 场景 4：空清单 / 运行中拒绝新批次 ----------

const dir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'zhu-batch-'));
const events4 = [];
const { runner: r4 } = makeRunner({ '10.4001/slow': { status: 'ok' } }, events4);
await assert.rejects(
  () => r4.run('没有DOI的文本', { outDir: dir4, concurrency: 1, retries: 0 }),
  /未识别到任何 DOI/,
);
const run4 = r4.run('10.4001/slow', { outDir: dir4, concurrency: 1, retries: 0 });
await assert.rejects(
  () => r4.run('10.4001/other', { outDir: dir4, concurrency: 1, retries: 0 }),
  /已有批次在运行/,
  '运行中拒绝并发批次',
);
await run4;
ok('场景4 空清单拒绝 + 运行中互斥');

// ---------- 场景 5：closeBrowserOnFinish=false 不收浏览器（MCP 人工接管复用同一会话） ----------

const dir5 = fs.mkdtempSync(path.join(os.tmpdir(), 'zhu-batch-'));
const closeCalls = [];
const events5 = [];
const runner5 = new BatchRunner({
  onEvent: e => events5.push(e),
  downloadFn: fakeDownload({ '10.5001/a': { status: 'ok' } }, [], 20),
  closeBrowserFn: async () => { closeCalls.push(Date.now()); },
});
await runner5.run('10.5001/a', { outDir: dir5, concurrency: 1, retries: 0, closeBrowserOnFinish: false });
assert.strictEqual(closeCalls.length, 0, 'closeBrowserOnFinish=false 时不得收浏览器');
await runner5.run('10.5001/a', { outDir: dir5, concurrency: 1, retries: 0, closeBrowserOnFinish: true });
assert.strictEqual(closeCalls.length, 1, 'closeBrowserOnFinish=true 时收一次浏览器');
await runner5.run('10.5001/a', { outDir: dir5, concurrency: 1, retries: 0 });
assert.strictEqual(closeCalls.length, 2, '默认值仍为 true（网页版行为不变）');
ok('场景5 closeBrowserOnFinish 三态：false 保留 / true 收窗 / 默认收窗');

// ---------- 场景 6：单篇看门狗（挂起任务收场 + 批次继续 + 晚期回调不污染终态） ----------

const dir6 = fs.mkdtempSync(path.join(os.tmpdir(), 'zhu-batch-'));
const events6 = [];
// hangDoi 永久挂起；挂起后 80ms（看门狗 60ms 已收场）再触发一次 onPhase，验证守卫挡住晚期回调
const hangDownload = async (doi, outDir, { onPhase } = {}) => {
  if (doi === '10.6001/hang') {
    setTimeout(() => onPhase?.('downloading', { note: '晚期回调' }), 80);
    return new Promise(() => {});
  }
  return { doi, publisher: 'nature', status: 'ok', path: path.join(outDir, 'fake.pdf'), bytes: 10, durationMs: 5, resolveUrl: 'https://x/' };
};
const runner6 = new BatchRunner({ onEvent: e => events6.push(e), downloadFn: hangDownload });
const t6 = Date.now();
const summary6 = await runner6.run('10.6001/hang\n10.6001/after', { outDir: dir6, concurrency: 1, retries: 1, itemTimeoutMs: 60 });
const wall6 = Date.now() - t6;
assert.ok(wall6 < 15000, `批次应被看门狗收场而不是被挂起拖死（实测 ${wall6}ms）`);
const hangItem = runner6.snapshot.items.find(it => it.doi === '10.6001/hang');
assert.strictEqual(hangItem.status, 'failed', '挂起条目按超时失败收场');
assert.match(hangItem.reason, /单篇超时\(看门狗/, '原因写明看门狗超时');
assert.strictEqual(hangItem.permanent, true, '超时=确定性失败标记 permanent');
assert.strictEqual(hangItem.attempt, 1, '超时不重试');
assert.strictEqual(summary6.ok, 1, '批次继续处理后续条目');
assert.strictEqual(summary6.aborted, false);
await sleep(120); // 等晚期 onPhase 触发后再断言终态未被污染
const hangAfter = runner6.snapshot.items.find(it => it.doi === '10.6001/hang');
assert.strictEqual(hangAfter.state, 'done');
assert.strictEqual(hangAfter.status, 'failed', '晚期 onPhase 不得污染终态');
assert.notStrictEqual(hangAfter.note, '晚期回调', '晚期回调的 note 不得写入');
ok('场景6 单篇看门狗：挂起收场/批次继续/晚期回调被守卫挡住');

// ---------- 场景 7：permanent 落 item 且 progress JSON 含 resolveUrl/permanent 增量键 ----------

const dir7 = fs.mkdtempSync(path.join(os.tmpdir(), 'zhu-batch-'));
const events7 = [];
const { runner: r7 } = makeRunner({
  '10.7001/perm': { status: 'failed', reason: '不支持的出版商: example.com', permanent: true },
  '10.7001/ok': { status: 'ok', bytes: 1024, resolveUrl: 'https://example.org/article' },
}, events7);
const summary7 = await r7.run('10.7001/perm\n10.7001/ok', { outDir: dir7, concurrency: 2, retries: 1 });
const permItem = r7.snapshot.items.find(it => it.doi === '10.7001/perm');
assert.strictEqual(permItem.permanent, true, 'r.permanent 落到 item');
assert.strictEqual(permItem.attempt, 1, '确定性失败不重试');
const okItem = r7.snapshot.items.find(it => it.doi === '10.7001/ok');
assert.strictEqual(okItem.permanent, false, '成功条目 permanent=false');
const progress7 = JSON.parse(fs.readFileSync(path.join(dir7, '_download_progress.json'), 'utf8'));
const progPerm = progress7.items.find(x => x.doi === '10.7001/perm');
assert.strictEqual(progPerm.permanent, true, 'progress JSON 含 permanent 键');
assert.ok('resolveUrl' in progPerm, 'progress JSON 含 resolveUrl 键');
assert.strictEqual(summary7.failed, 1);
ok('场景7 permanent 落 item + progress 增量键 resolveUrl/permanent');

console.log(`\n全部通过（${passed.length} 个场景）`);
