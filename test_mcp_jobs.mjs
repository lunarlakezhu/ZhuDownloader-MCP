// JobManager 离线测试（MCP 步骤2验收）：注入假 runner / 假 openManual / 假浏览器，不联网、不启动浏览器。
// 覆盖 10 场景：单DOI、混合+人工选中、limit/cursor 分页、捕获回调、retry、BUSY/stop、
// 长轮询、持久化与重启恢复、collect 分支、close。
// 运行: node test_mcp_jobs.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJobManager, McpError } from './mcp/jobs.mjs';
import {
  existingPdf as realExistingPdf, appendLog as realAppendLog,
  sanitize as realSanitize, isPdfFile as realIsPdfFile,
} from './lib/downloader.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const passed = [];
const ok = msg => { console.log(`✓ ${msg}`); passed.push(msg); };

function expectMcpError(promise, code, what) {
  return promise.then(
    () => { throw new Error(`${what}: 应抛 McpError(${code})，实际正常返回`); },
    e => {
      assert.ok(e instanceof McpError, `${what}: 错误应为 McpError，实际 ${e?.constructor?.name}`);
      assert.equal(e.code, code, `${what}: 错误码应为 ${code}，实际 ${e.code}`);
    },
  );
}

// ---------- 假核心（浏览器/close/cf-assist 用记录器；fs 纯函数用真实现） ----------

function makeRecord() {
  return {
    browserOpen: false, launchFails: false, closeCalls: 0,
    runBegin: [], runEnd: [], runCalls: [], openCalls: [],
  };
}

function makeCore(record) {
  return {
    existingPdf: realExistingPdf,
    appendLog: realAppendLog,
    sanitize: realSanitize,
    isPdfFile: realIsPdfFile,
    closeBrowserSession: async () => { record.closeCalls += 1; record.browserOpen = false; },
    getVisibleBrowserContext: async () => {
      if (record.launchFails) throw new Error('另一个 Edge 实例已占用 profile');
      record.browserOpen = true;
      return { fake: true };
    },
    isBrowserSessionOpen: () => record.browserOpen,
    getBrowserProfileDir: () => '<fake-profile-dir>',
    cfAssistRunBegin: r => record.runBegin.push(r),
    cfAssistRunEndSync: r => record.runEnd.push(r),
  };
}

// ---------- 假 runner（BatchRunner 事件契约：start/item/done） ----------

function makeRunnerFactory(script, record, { perItemMs = 15 } = {}) {
  return function runnerFactory({ onEvent }) {
    let running = false;
    let aborted = false;
    const clone = x => JSON.parse(JSON.stringify(x));
    return {
      isRunning: () => running,
      stop() { aborted = true; },
      async run(text, opts) {
        running = true;
        record.runCalls.push({ text, opts: { ...opts } });
        const dois = text.split('\n').filter(Boolean);
        const items = dois.map((doi, i) => ({
          idx: i + 1, doi, publisher: '', state: 'pending', phase: '',
          attempt: 0, startedAt: 0, endedAt: 0, durationMs: 0,
          status: '', reason: '', note: '', path: '', bytes: 0, resolveUrl: '', permanent: false,
        }));
        const meta = {
          outDir: opts.outDir, concurrency: opts.concurrency, retries: opts.retries,
          startedAt: Date.now(), total: items.length, skipped: 0,
        };
        onEvent({ type: 'start', meta, items: clone(items) });
        for (const it of items) {
          if (aborted) break;
          it.state = 'running';
          it.startedAt = Date.now();
          onEvent({ type: 'item', item: clone(it) });
          await sleep(perItemMs);
          if (aborted) break;
          const s = script[it.doi] ?? { status: 'ok' };
          it.publisher = s.publisher ?? 'fake';
          it.status = s.status;
          it.reason = s.reason ?? '';
          it.permanent = Boolean(s.permanent);
          it.resolveUrl = s.resolveUrl ?? `https://example.org/${it.doi}`;
          it.path = s.status === 'ok' ? path.join(opts.outDir, `${realSanitize(it.doi)}.pdf`) : '';
          it.bytes = s.bytes ?? 0;
          it.state = 'done';
          onEvent({ type: 'item', item: clone(it) });
        }
        const count = key => items.filter(i => i.status === key).length;
        const summary = {
          ok: count('ok'), failed: count('failed'), manual: count('manual'), exists: count('exists'),
          total: items.length, aborted,
          outDir: opts.outDir,
        };
        running = false;
        onEvent({ type: 'done', summary });
        return summary;
      },
    };
  };
}

/** 轮询直到 job 到终态（fake runner 每篇 15ms，超时 5s 足够）。 */
async function untilFinished(mgr, jobId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = await mgr.status({ jobId });
    if (s.state === 'error') throw new Error(`job error: ${s.error}`);
    if (s.state === 'finished') return s;
    if (Date.now() > deadline) throw new Error(`等待 job 结束超时: ${JSON.stringify({ state: s.state, counts: s.counts })}`);
    await sleep(30);
  }
}

/** 假 openManualArticles：记录 entries 与回调，返回可打开结果。 */
function makeOpenManualFn(record) {
  return async (entries, opts) => {
    record.openCalls.push({ entries, opts });
    return {
      opened: entries.map(e => ({ doi: e.doi, url: e.url, reused: false })),
      failed: [], capture: true,
    };
  };
}

function freshTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ================================================================

// ---------- 场景1：单 DOI start→running→finished ----------

{
  const record = makeRecord();
  const core = makeCore(record);
  const stateDir1 = freshTmp('zhu-jobs-state-');
  const mgr = createJobManager({
    core, runnerFactory: makeRunnerFactory({ '10.1001/a': { status: 'ok', bytes: 123 } }, record),
    openManualFn: makeOpenManualFn(record),
    stateDir: stateDir1,
  });
  await mgr.init();
  const dir1 = freshTmp('zhu-jobs-out-');
  const started = await mgr.startJob({ dois: ['https://doi.org/10.1001/a'], outDir: dir1 });
  assert.equal(started.state, 'running');
  assert.equal(started.total, 1, 'URL 前缀容忍并计 1 篇');
  assert.equal(started.skipped, 0);
  assert.match(started.jobId, /^mcp-/);
  const st1 = await untilFinished(mgr, started.jobId);
  assert.equal(st1.state, 'finished');
  assert.equal(st1.counts.ok, 1);
  assert.equal(st1.counts.total, 1);
  assert.equal(st1.problems.length, 0);
  assert.equal(st1.browserOpen, false, '无问题时批次结束应已收窗');
  assert.equal(record.closeCalls, 1, '无问题批次 → closeBrowserSession 一次');
  assert.equal(record.runBegin.length, 1, 'cfAssistRunBegin 已写');
  assert.equal(record.runEnd.length, 1, 'cfAssistRunEndSync 已写');
  const all = await mgr.status({ jobId: started.jobId, includeItems: 'all' });
  assert.ok(all.items[0].path.endsWith('.pdf'), 'item path 落到 outDir 文件名');
  const jobFile = JSON.parse(fs.readFileSync(path.join(dir1, '_mcp_job.json'), 'utf8'));
  assert.equal(jobFile.state, 'finished');
  assert.equal(jobFile.jobId, started.jobId);
  const lastJob = JSON.parse(fs.readFileSync(path.join(stateDir1, 'last-job.json'), 'utf8'));
  assert.equal(lastJob.jobId, started.jobId);
  assert.equal(lastJob.outDir, dir1);
  ok('场景1 单DOI：running→finished、counts/path/收窗/_mcp_job.json/last-job.json/cf-run 生命周期');
}

// ---------- 场景2：混合批次 + open_manual 默认选中（排除未注册/已存在） ----------

{
  const record = makeRecord();
  const core = makeCore(record);
  const mgr = createJobManager({
    core, runnerFactory: makeRunnerFactory({
      '10.2002/a': { status: 'ok' },
      '10.2002/b': { status: 'failed', reason: '网络抖动(ECONNRESET)', permanent: false },
      '10.2002/man': { status: 'manual', reason: 'Cloudflare验证' },
      '10.2002/have': { status: 'exists' },
      '10.2002/bad': { status: 'failed', reason: 'DOI未注册或编号有误(解析状态404)', permanent: true },
    }, record),
    openManualFn: makeOpenManualFn(record),
    stateDir: freshTmp('zhu-jobs-state-'),
  });
  await mgr.init();
  const dir2 = freshTmp('zhu-jobs-out-');
  const j2 = await mgr.startJob({ dois: ['10.2002/a', '10.2002/b', '10.2002/man', '10.2002/have', '10.2002/bad'], outDir: dir2, autoOpenManual: false });
  const st2 = await untilFinished(mgr, j2.jobId);
  assert.equal(st2.counts.ok, 1);
  assert.equal(st2.counts.failed, 2);
  assert.equal(st2.counts.manual, 1);
  assert.equal(st2.counts.exists, 1);
  assert.equal(record.closeCalls, 0, '有问题批次结束不收窗');
  const om = await mgr.openManual({ jobId: j2.jobId });
  const openedDois = om.opened.map(o => o.doi).sort();
  assert.deepEqual(openedDois, ['10.2002/b', '10.2002/man'], '默认选中 manual + 可打开 failed');
  assert.ok(!openedDois.includes('10.2002/bad'), 'DOI未注册(永久) 不打开');
  assert.ok(!openedDois.includes('10.2002/have'), '已存在不打开');
  assert.equal(om.totalOpenable, 2);
  assert.equal(record.openCalls.at(-1).entries[0].outDir, dir2, '打开条目带 outDir');
  assert.ok(record.openCalls.at(-1).entries.every(e => e.url.startsWith('http')), '条目带 URL');
  ok('场景2 混合批次：open_manual 默认选中排除未注册/已存在');
}

// ---------- 场景3：limit/cursor 分页 12 个问题 ----------

{
  const record = makeRecord();
  const core = makeCore(record);
  const script = {};
  const dois = [];
  for (let i = 1; i <= 12; i++) {
    const doi = `10.3003/m${String(i).padStart(2, '0')}`;
    script[doi] = { status: 'manual', reason: 'Cloudflare验证' };
    dois.push(doi);
  }
  const mgr = createJobManager({
    core, runnerFactory: makeRunnerFactory(script, record),
    openManualFn: makeOpenManualFn(record),
    stateDir: freshTmp('zhu-jobs-state-'),
  });
  await mgr.init();
  const dir3 = freshTmp('zhu-jobs-out-');
  const j3 = await mgr.startJob({ dois, outDir: dir3, autoOpenManual: false });
  await untilFinished(mgr, j3.jobId);
  const p1 = await mgr.openManual({ jobId: j3.jobId, limit: 5 });
  assert.equal(p1.opened.length, 5);
  assert.equal(p1.remaining, 7);
  assert.equal(p1.cursor, 0);
  const p2 = await mgr.openManual({ jobId: j3.jobId, limit: 5, cursor: 5 });
  assert.equal(p2.opened.length, 5);
  assert.equal(p2.remaining, 2);
  const p3 = await mgr.openManual({ jobId: j3.jobId, limit: 5, cursor: 10 });
  assert.equal(p3.opened.length, 2);
  assert.equal(p3.remaining, 0);
  const openedDois = record.openCalls.flatMap(c => c.entries.map(e => e.doi));
  assert.equal(new Set(openedDois).size, 12, '三批合计恰好 12 个不同 DOI');
  ok('场景3 分页：5/5/2、remaining 递减、无重复打开');
}

// ---------- 场景4：捕获回调 → item 变 ok / pending 减少 / progress 同步 / version 增加 ----------

{
  const record = makeRecord();
  const core = makeCore(record);
  const mgr = createJobManager({
    core, runnerFactory: makeRunnerFactory({ '10.4004/man': { status: 'manual', reason: 'Cloudflare验证' } }, record),
    openManualFn: makeOpenManualFn(record),
    stateDir: freshTmp('zhu-jobs-state-'),
  });
  await mgr.init();
  const dir4 = freshTmp('zhu-jobs-out-');
  const j4 = await mgr.startJob({ dois: ['10.4004/man'], outDir: dir4, autoOpenManual: false });
  const before = await untilFinished(mgr, j4.jobId);
  const versionBefore = before.version;
  assert.equal(before.manual.pendingCount, 1);
  await mgr.openManual({ jobId: j4.jobId });
  assert.equal(before.manual.pendingCount, 1, '打开不减少 pending（用户还没处理）');
  const capturePath = path.join(dir4, '10.4_man.pdf');
  fs.writeFileSync(capturePath, '%PDF-fake-captured');
  const openCall = record.openCalls.at(-1);
  openCall.opts.onCaptured({ doi: '10.4004/man', path: capturePath, bytes: 17, publisher: 'fake' });
  const after = await mgr.status({ jobId: j4.jobId, includeItems: 'all' });
  const item = after.items[0];
  assert.equal(item.status, 'ok', '捕获后条目翻成 ok');
  assert.equal(item.note, '人工下载已捕获');
  assert.equal(item.path, capturePath);
  assert.equal(after.manual.pendingCount, 0, '捕获减少 pending');
  assert.equal(after.captures.length, 1);
  assert.equal(after.captures[0].doi, '10.4004/man');
  assert.equal(after.captures[0].flipped, true);
  assert.ok(after.version > versionBefore, '捕获推进 version');
  const progress = JSON.parse(fs.readFileSync(path.join(dir4, '_download_progress.json'), 'utf8'));
  assert.equal(progress.items[0].status, 'ok', 'progress JSON 与捕获同步');
  ok('场景4 捕获回调：ok/pending/version/progress 同步');
}

// ---------- 场景5：retry 默认选 manual+failed、剔除已存在；新 job 与旧 job 并存 ----------

{
  const record = makeRecord();
  const core = makeCore(record);
  const mgr = createJobManager({
    core, runnerFactory: makeRunnerFactory({
      '10.5005/ok1': { status: 'ok' },
      '10.5005/net': { status: 'failed', reason: '网络抖动', permanent: false },
      '10.5005/man': { status: 'manual', reason: 'Cloudflare验证' },
    }, record),
    openManualFn: makeOpenManualFn(record),
    stateDir: freshTmp('zhu-jobs-state-'),
  });
  await mgr.init();
  const dir5 = freshTmp('zhu-jobs-out-');
  const jA = await mgr.startJob({ dois: ['10.5005/ok1', '10.5005/net', '10.5005/man'], outDir: dir5, autoOpenManual: false });
  await untilFinished(mgr, jA.jobId);
  const r1 = await mgr.retry({ jobId: jA.jobId });
  assert.notEqual(r1.jobId, jA.jobId, 'retry 产出新 jobId');
  await untilFinished(mgr, r1.jobId);
  assert.equal(record.runCalls[1].text, '10.5005/net\n10.5005/man', '默认重跑剩余 manual+failed（按 idx 序）');
  const oldStatus = await mgr.status({ jobId: jA.jobId });
  assert.equal(oldStatus.state, 'finished', '旧 job 仍可查询');
  assert.equal(oldStatus.counts.ok, 1);

  // 第二轮仍失败后，net 的 PDF 被手工放好 → 再 retry 剔除已存在
  fs.writeFileSync(path.join(dir5, '10.5005_net.pdf'), '%PDF-manually-placed');
  const r2 = await mgr.retry({ jobId: r1.jobId });
  await untilFinished(mgr, r2.jobId);
  assert.equal(record.runCalls[2].text, '10.5005/man', '已存在的 net 被剔除');
  ok('场景5 retry：默认列表/剔除已存在/新旧 job 并存');
}

// ---------- 场景6：运行中 start→BUSY；stop → summary.aborted ----------

{
  const record = makeRecord();
  const core = makeCore(record);
  const mgr = createJobManager({
    core, runnerFactory: makeRunnerFactory({
      '10.6006/a': { status: 'ok' }, '10.6006/b': { status: 'ok' }, '10.6006/c': { status: 'ok' },
    }, record, { perItemMs: 120 }),
    openManualFn: makeOpenManualFn(record),
    stateDir: freshTmp('zhu-jobs-state-'),
  });
  await mgr.init();
  const dir6 = freshTmp('zhu-jobs-out-');
  const j6 = await mgr.startJob({ dois: ['10.6006/a', '10.6006/b', '10.6006/c'], outDir: dir6, autoOpenManual: false });
  await expectMcpError(mgr.startJob({ dois: ['10.6006/x'], outDir: dir6 }), 'BUSY', '运行中再次 start');
  await expectMcpError(mgr.openManual({ jobId: j6.jobId }), 'BUSY', '运行中 open_manual');
  await expectMcpError(mgr.retry({ jobId: j6.jobId }), 'BUSY', '运行中 retry');
  const stopR = await mgr.stop({ jobId: j6.jobId });
  assert.equal(stopR.state, 'stopping');
  const st6 = await untilFinished(mgr, j6.jobId);
  assert.equal(st6.summary.aborted, true, 'stop 后 summary.aborted');
  assert.ok(st6.counts.ok < 3, '停止后未跑完全部');
  ok('场景6 运行中互斥（BUSY）+ 优雅停止（aborted）');
}

// ---------- 场景7：长轮询（capture 后立即返回 changed:true；无变化按时超时） ----------

{
  const record = makeRecord();
  const core = makeCore(record);
  const mgr = createJobManager({
    core, runnerFactory: makeRunnerFactory({ '10.7007/man': { status: 'manual', reason: 'Cloudflare验证' } }, record),
    openManualFn: makeOpenManualFn(record),
    stateDir: freshTmp('zhu-jobs-state-'),
  });
  await mgr.init();
  const dir7 = freshTmp('zhu-jobs-out-');
  const j7 = await mgr.startJob({ dois: ['10.7007/man'], outDir: dir7, autoOpenManual: false });
  const fin = await untilFinished(mgr, j7.jobId);
  void fin;
  await mgr.openManual({ jobId: j7.jobId });
  // openManual 自身会 bump version：取打开后的最新版本作为轮询基准
  const afterOpen = await mgr.status({ jobId: j7.jobId });
  const versionBefore = afterOpen.version;

  // 先挂起长轮询（sinceVersion=旧版本），200ms 后触发捕获 → 应立即醒来
  const waitP = mgr.status({ jobId: j7.jobId, waitSeconds: 10, sinceVersion: versionBefore });
  await sleep(200);
  fs.writeFileSync(path.join(dir7, '10.7_man.pdf'), '%PDF-x');
  record.openCalls.at(-1).opts.onCaptured({ doi: '10.7007/man', path: path.join(dir7, '10.7_man.pdf'), bytes: 5, publisher: 'fake' });
  const t0 = Date.now();
  const woke = await waitP;
  const wokeMs = Date.now() - t0;
  assert.equal(woke.changed, true, 'capture 后长轮询立即返回 changed:true');
  assert.ok(wokeMs < 2000, `长轮询应在捕获后立即醒来（实测 ${wokeMs}ms）`);

  // 无变化：按时超时返回 changed:false
  const cur = await mgr.status({ jobId: j7.jobId });
  const t1 = Date.now();
  const quiet = await mgr.status({ jobId: j7.jobId, waitSeconds: 1, sinceVersion: cur.version });
  const quietMs = Date.now() - t1;
  assert.equal(quiet.changed, false);
  assert.ok(quietMs >= 900, `无变化应等满 waitSeconds（实测 ${quietMs}ms）`);
  ok('场景7 长轮询：捕获唤醒 + 无变化超时');
}

// ---------- 场景8：持久化与重启恢复（running → interrupted） ----------

{
  const record = makeRecord();
  const core = makeCore(record);
  const stateDir8 = freshTmp('zhu-jobs-state-');
  const mgr = createJobManager({
    core, runnerFactory: makeRunnerFactory({ '10.8008/a': { status: 'ok' } }, record),
    openManualFn: makeOpenManualFn(record),
    stateDir: stateDir8,
  });
  await mgr.init();
  const dir8 = freshTmp('zhu-jobs-out-');
  const j8 = await mgr.startJob({ dois: ['10.8008/a'], outDir: dir8, autoOpenManual: false });
  await untilFinished(mgr, j8.jobId);
  const lastJob = JSON.parse(fs.readFileSync(path.join(stateDir8, 'last-job.json'), 'utf8'));
  assert.equal(lastJob.jobId, j8.jobId);
  assert.equal(lastJob.outDir, dir8);

  // 模拟宿主崩溃：last-job 指向一个 state=running 的 _mcp_job.json
  const crashDir = freshTmp('zhu-jobs-crash-');
  fs.writeFileSync(path.join(crashDir, '_mcp_job.json'), JSON.stringify({
    jobId: 'mcp-crashed', state: 'running', outDir: crashDir, startedAt: Date.now() - 60000,
  }));
  fs.writeFileSync(path.join(crashDir, '_download_progress.json'), JSON.stringify({
    items: [{ doi: '10.8008/x', status: 'running', attempt: 1, bytes: 0, note: '', publisher: 'elsevier', resolveUrl: '' }],
  }));
  fs.writeFileSync(path.join(stateDir8, 'last-job.json'), JSON.stringify({ jobId: 'mcp-crashed', outDir: crashDir }));
  const mgr2 = createJobManager({
    core: makeCore(makeRecord()), runnerFactory: makeRunnerFactory({}, record),
    openManualFn: makeOpenManualFn(record), stateDir: stateDir8,
  });
  await mgr2.init();
  const restored = await mgr2.status({});
  assert.equal(restored.jobId, 'mcp-crashed', '重启后恢复最近 job');
  assert.equal(restored.state, 'interrupted', 'running → interrupted');
  assert.equal(restored.counts.total, 1);
  const restoredAll = await mgr2.status({ includeItems: 'all' });
  assert.equal(restoredAll.items[0].doi, '10.8008/x', 'progress 恢复条目');
  assert.equal(restoredAll.items[0].resolveUrl, 'https://doi.org/10.8008/x', '缺 resolveUrl 回落 doi.org');
  const jobFileAfter = JSON.parse(fs.readFileSync(path.join(crashDir, '_mcp_job.json'), 'utf8'));
  assert.equal(jobFileAfter.state, 'interrupted', '_mcp_job.json 已写回 interrupted');
  ok('场景8 持久化：last-job/_mcp_job 正确，重启恢复 running→interrupted');
}

// ---------- 场景9：collect 的 found/adopted/ambiguous/not-pdf 分支 ----------

{
  const record = makeRecord();
  const core = makeCore(record);
  const mgr = createJobManager({
    core, runnerFactory: makeRunnerFactory({
      '10.9009/a': { status: 'manual', reason: 'Cloudflare验证' },
      '10.9009/b': { status: 'failed', reason: '内容非PDF(3KB)', permanent: true },
      '10.9009/c': { status: 'failed', reason: '网络抖动', permanent: false },
      '10.9009/d': { status: 'failed', reason: '网络抖动', permanent: false },
    }, record),
    openManualFn: makeOpenManualFn(record),
    stateDir: freshTmp('zhu-jobs-state-'),
  });
  await mgr.init();
  const dir9 = freshTmp('zhu-jobs-out-');
  const scanDir = freshTmp('zhu-jobs-scan-');
  const j9 = await mgr.startJob({ dois: ['10.9009/a', '10.9009/b', '10.9009/c', '10.9009/d'], outDir: dir9, autoOpenManual: false });
  await untilFinished(mgr, j9.jobId);
  // 用户外部文件：a=合法PDF唯一命中；b=PDF 扩展名但内容是 HTML；c=同名两份；d=无文件
  fs.writeFileSync(path.join(scanDir, '10.9009_a-我的论文.pdf'), '%PDF-1.4 valid');
  fs.writeFileSync(path.join(scanDir, '10.9009_b.pdf'), '<html>login</html>');
  fs.writeFileSync(path.join(scanDir, '10.9009_c-one.pdf'), '%PDF-1.4 one');
  fs.writeFileSync(path.join(scanDir, '10.9009_c-two.pdf'), '%PDF-1.4 two');

  const dry = await mgr.collect({ jobId: j9.jobId, scanDirs: [scanDir], adopt: false });
  assert.equal(dry.found.filter(f => f.adoptable).length, 1, 'a 唯一命中（未 adopt 只报 found）');
  assert.equal(dry.notPdf.length, 1, 'b 报 not-pdf');
  assert.equal(dry.ambiguous.length, 1, 'c 报 ambiguous');
  assert.equal(dry.adopted.length, 0, '未 adopt 不复制');
  assert.ok(!dry.found.some(f => f.doi === '10.9009/d'), 'd 无候选');

  const adopted = await mgr.collect({ jobId: j9.jobId, scanDirs: [scanDir], adopt: true });
  assert.equal(adopted.adopted.length, 1);
  assert.equal(adopted.adopted[0].doi, '10.9009/a');
  assert.ok(fs.existsSync(adopted.adopted[0].path), '已复制进 outDir');
  assert.ok(fs.existsSync(path.join(scanDir, '10.9009_a-我的论文.pdf')), '用户原文件不移动');
  assert.ok(adopted.flipped.includes('10.9009/a'), '条目翻成 ok');
  const st9 = await mgr.status({ jobId: j9.jobId });
  assert.equal(st9.counts.ok, 1, 'a 翻 ok');
  ok('场景9 collect：found/adopted/not-pdf/ambiguous/原文件不动');
}

// ---------- 场景10：close 调 closeFn 一次并释放；运行中拒绝/force 停后关 ----------

{
  const record = makeRecord();
  const core = makeCore(record);
  const mgr = createJobManager({
    core, runnerFactory: makeRunnerFactory({
      '10.1010/a': { status: 'ok' }, '10.1010/b': { status: 'ok' }, '10.1010/c': { status: 'ok' },
    }, record, { perItemMs: 120 }),
    openManualFn: makeOpenManualFn(record),
    stateDir: freshTmp('zhu-jobs-state-'),
  });
  await mgr.init();
  const dir10 = freshTmp('zhu-jobs-out-');
  const j10 = await mgr.startJob({ dois: ['10.1010/a', '10.1010/b', '10.1010/c'], outDir: dir10, autoOpenManual: false });
  await expectMcpError(mgr.close({}), 'BROWSER_BUSY', '运行中 close 拒绝');
  await mgr.close({ force: true });
  // force 路径：close 自身收窗 + finishJob 的"无问题自动收窗"都会调 closeBrowserSession（幂等），≥1 即正确
  assert.ok(record.closeCalls >= 1, 'closeFn 至少调用一次');
  assert.equal(record.browserOpen, false, '引用已释放');
  const st10 = await untilFinished(mgr, j10.jobId);
  assert.equal(st10.summary.aborted, true, 'force 先停批');
  const closeCallsAfterForce = record.closeCalls;
  await mgr.close({});
  assert.equal(record.closeCalls, closeCallsAfterForce + 1, '浏览器已关闭态下再 close 幂等放行');
  assert.equal(record.browserOpen, false);
  ok('场景10 close：运行中拒绝/force 停批后关/幂等');
}

// ---------- 场景11（补充）：profile 被占 → BROWSER_BUSY；坏参 → INVALID_ARGS ----------

{
  const record = makeRecord();
  record.launchFails = true;
  const core = makeCore(record);
  const mgr = createJobManager({
    core, runnerFactory: makeRunnerFactory({}, record),
    openManualFn: makeOpenManualFn(record),
    stateDir: freshTmp('zhu-jobs-state-'),
  });
  await mgr.init();
  const dir11 = freshTmp('zhu-jobs-out-');
  await expectMcpError(mgr.startJob({ dois: ['10.1111/a'], outDir: dir11 }), 'BROWSER_BUSY', 'profile 被占');
  record.launchFails = false;
  await expectMcpError(mgr.startJob({ dois: ['not-a-doi'], outDir: dir11 }), 'INVALID_ARGS', '无效 DOI');
  await expectMcpError(mgr.startJob({ dois: ['10.1111/a'], outDir: 'relative/dir' }), 'INVALID_ARGS', '相对 outDir');
  await expectMcpError(mgr.startJob({ dois: [], listText: '# 只有注释', outDir: dir11 }), 'INVALID_ARGS', '空清单');
  ok('场景11 BROWSER_BUSY 预检 + INVALID_ARGS 参数校验');
}

// ---------- 场景12（补充）：outDir 护栏（agent 乱写输出目录的防线） ----------

{
  const record = makeRecord();
  const core = makeCore(record);
  const mgr = createJobManager({
    core, runnerFactory: makeRunnerFactory({ '10.1212/a': { status: 'ok' } }, record),
    openManualFn: makeOpenManualFn(record),
    stateDir: freshTmp('zhu-jobs-state-'),
  });
  await mgr.init();
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
  const bad = async (outDir, what) => {
    const r = await mgr.startJob({ dois: ['10.1212/a'], outDir }).then(
      () => { throw new Error(`${what}: 应拒绝，实际受理`); },
      e => {
        assert.ok(e instanceof McpError && e.code === 'INVALID_ARGS', `${what}: 应报 INVALID_ARGS，实际 ${e?.code || e}`);
        assert.match(e.message, /请换用户目录/, `${what}: 错误信息应含可执行建议`);
      },
    );
    void r;
  };
  await bad(path.join(repoRoot, 'lib', 'sub'), '安装/开发目录内（污染源码与打包）');
  await bad(path.join(repoRoot, '.mcp-state'), '状态目录内');
  await bad(path.parse(process.execPath).root, '驱动器根目录');
  await bad(os.homedir(), '用户主目录根');
  await bad(path.join(process.env.SystemRoot || 'C:\\Windows', 'Temp'), '系统目录内');

  // 合法嵌套用户目录正常受理并创建
  const legal = path.join(freshTmp('zhu-jobs-out-'), 'papers', '2026');
  const started = await mgr.startJob({ dois: ['10.1212/a'], outDir: legal });
  assert.equal(started.state, 'running');
  assert.equal(started.outDir, path.resolve(legal), '返回值回显最终 outDir');
  const st12 = await untilFinished(mgr, started.jobId);
  assert.equal(st12.counts.ok, 1);
  ok('场景12 outDir 护栏：安装目录/驱动器根/主目录根/系统目录拒绝，合法嵌套路径受理并回显');
}

console.log(`\n全部通过（${passed.length} 个场景）`);
