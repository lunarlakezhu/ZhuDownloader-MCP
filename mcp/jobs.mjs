// JobManager — MCP 的核心状态机（施工计划步骤2）：把 BatchRunner 的"一次性 run"包装成
// 可查询、可长轮询、可重试、可跨重启诊断的 job。进程内执行（不 fork、不复用 webui HTTP），
// 浏览器 context 与 job 同生命周期——人工接管与"同会话重试"零 IPC。
//
// 依赖注入：createJobManager({ core, runnerFactory, openManualFn, stateDir })。生产路径
// loadCore() 懒加载核心模块（playwright 缺失时转 DEPENDENCY_MISSING，guide/tools/list 仍可用）；
// 测试注入假实现，全程离线、零浏览器。
//
// 错误码契约：ERROR: <CODE>: <message>，CODE ∈ BUSY / NO_JOB / INVALID_ARGS / BROWSER_BUSY /
// DEPENDENCY_MISSING / BATCH_FAILED（与 tools 桥 mcp/bridge.mjs 共用 McpError）。
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'node:url';
import { parseList } from '../lib/listparse.mjs';
import { writeDownloadProgress } from '../lib/progress.mjs';
// cf-assist.mjs 只有 node: 内建依赖，静态导入安全；redactUrl 供状态展示去查询串（脱敏）
import { redactUrl } from '../lib/cf-assist.mjs';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(MODULE_DIR);

const DOI_RE = /^10\.\d{4,9}\/\S+$/i;
// 打开也没用的确定性失败（下载器 downloader.mjs 的 unknown 分支 / SAGE 无备选地址）
const NOT_OPENABLE_RE = /DOI未注册|DOI无法解析|不支持的出版商|无备选地址/;
const PROBLEMS_MAX = 30;
const MAX_WAIT_SECONDS = 45;
const DEFAULT_MANUAL_LIMIT = 8;
const sleep = ms => new Promise(r => setTimeout(r, ms));

export class McpError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    this.details = details;
  }
}

export function errorText(err) {
  return `ERROR: ${err?.code || 'INTERNAL'}: ${err?.message || err}`;
}

/** 宽松归一：容忍 https://doi.org/ 与 doi: 前缀、行尾悬挂标点；无效返回 null。 */
export function normalizeDoi(raw) {
  let s = String(raw ?? '').trim();
  s = s.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:/i, '').replace(/^info:doi\//i, '');
  s = s.replace(/[.,;:)\]]+$/, '');
  return DOI_RE.test(s) ? s : null;
}

function clampInt(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** runner 是否在跑。BatchRunner 的 isRunning 是 getter（属性），测试假实现是方法——
 *  两种形态都兼容；调用形态写错会让 TypeError 静默炸掉退出路径（s7 实测教训）。 */
function isRunnerRunning(runner) {
  if (!runner) return false;
  try {
    const v = runner.isRunning;
    return typeof v === 'function' ? Boolean(v.call(runner)) : Boolean(v);
  } catch { return false; }
}

/** target 是否位于 base 内（含相等）。Windows 大小写不敏感。 */
function isWithin(base, target) {
  const norm = p => path.resolve(String(p)).replace(/[\\/]+$/, '');
  const cmp = process.platform === 'win32' ? (p => p.toLowerCase()) : (p => p);
  const b = cmp(norm(base));
  const t = cmp(norm(target));
  return t === b || t.startsWith(b + '\\') || t.startsWith(b + '/');
}

// outDir 护栏：agent 最容易乱写输出目录——写进安装/开发目录会污染源码、打包与 git，
// 写进系统目录/驱动器根/用户主目录根是事故。一律拒绝并给出可执行的下一步。
function resolveOutDir(raw) {
  let out;
  if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
    const s = String(raw);
    if (!path.isAbsolute(s)) {
      throw new McpError('INVALID_ARGS', `outDir 须为绝对路径: ${s}（如 D:\\Papers 或默认 ~/Downloads/ZhuDownLoader）`);
    }
    out = path.resolve(s);
  } else {
    out = path.resolve(process.env.ZHU_DL_DEFAULT_OUT || path.join(os.homedir(), 'Downloads', 'ZhuDownLoader'));
  }
  const deny = why => {
    throw new McpError('INVALID_ARGS', `outDir 不可用（${why}）。请换用户目录，例如 ~/Downloads/ZhuDownLoader 或 D:\\Papers；当前值: ${out}`);
  };
  if (path.parse(out).root === out) deny('是驱动器根目录');
  if (isWithin(REPO_ROOT, out)) deny('位于 ZhuDownLoader 安装/开发目录内，会污染源码、打包与 git');
  if (out === path.resolve(os.homedir())) deny('是用户主目录根，PDF 会散落主目录');
  for (const sysDir of [process.env.SystemRoot, 'C:\\Program Files', 'C:\\Program Files (x86)'].filter(Boolean)) {
    if (isWithin(sysDir, out)) deny('位于 Windows 系统目录内');
  }
  return out;
}

function atomicWriteJson(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/** 懒加载核心模块。playwright 缺失（分享包未装依赖/新电脑）转 DEPENDENCY_MISSING。 */
async function loadCore() {
  try {
    const [batch, downloader, manual, cfAssist] = await Promise.all([
      import('../webui/batch.mjs'),
      import('../lib/downloader.mjs'),
      import('../lib/manual-handoff.mjs'),
      import('../lib/cf-assist.mjs'),
    ]);
    return {
      BatchRunner: batch.BatchRunner,
      existingPdf: downloader.existingPdf,
      appendLog: downloader.appendLog,
      sanitize: downloader.sanitize,
      isPdfFile: downloader.isPdfFile,
      closeBrowserSession: downloader.closeBrowserSession,
      getVisibleBrowserContext: downloader.getVisibleBrowserContext,
      isBrowserSessionOpen: downloader.isBrowserSessionOpen,
      getBrowserProfileDir: downloader.getBrowserProfileDir,
      openManualArticles: manual.openManualArticles,
      cfAssistRunBegin: cfAssist.cfAssistRunBegin,
      cfAssistRunEndSync: cfAssist.cfAssistRunEndSync,
    };
  } catch (e) {
    if (e?.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find package|playwright/i.test(String(e?.message || e))) {
      throw new McpError('DEPENDENCY_MISSING',
        `核心依赖缺失(${String(e?.message || e).substring(0, 80)})。请在 ZhuDownLoader 目录执行 npm ci && npx playwright install chromium，或双击 一键安装环境.bat 后重启 MCP 服务。`);
    }
    throw e;
  }
}

export function createJobManager({ core = null, runnerFactory = null, openManualFn = null, stateDir = null } = {}) {
  let coreRef = core ?? null; // 注入的假实现；生产路径首次调用时 loadCore()

  const st = {
    jobs: new Map(),          // jobId → job 记录
    lastJobId: '',
    activeRunner: null,
    activeRunPromise: null,
    activeRunBegan: false,    // cfAssistRunBegin 是否已写（决定退出时要不要 EndSync）
    initDone: false,
    waiters: new Set(),       // 长轮询唤醒器
    stateDir: stateDir || process.env.ZHU_DL_MCP_STATE_DIR || path.join(REPO_ROOT, '.mcp-state'),
  };

  async function ensureCore() {
    if (coreRef) return coreRef;
    coreRef = await loadCore();
    return coreRef;
  }

  function bump(job) {
    job.version += 1;
    for (const wake of st.waiters) wake();
  }

  function currentJob(jobId) {
    const id = jobId || st.lastJobId;
    const job = id ? st.jobs.get(id) : null;
    if (!job) {
      throw new McpError('NO_JOB', id
        ? `找不到 job ${id}；用 zhu_dl_status（不带 jobId）查看最近批次`
        : '尚无任何下载批次；先用 zhu_dl_download 发起');
    }
    return job;
  }

  function jobCounts(items) {
    const count = key => items.filter(it => it.status === key).length;
    return {
      ok: count('ok'), failed: count('failed'), manual: count('manual'), exists: count('exists'),
      running: items.filter(it => it.state === 'running').length,
      pending: items.filter(it => it.state === 'pending').length,
      done: items.filter(it => it.state === 'done').length,
      total: items.length,
    };
  }

  function writeJobFile(job) {
    try {
      atomicWriteJson(path.join(job.outDir, '_mcp_job.json'), {
        jobId: job.jobId, state: job.state, outDir: job.outDir,
        startedAt: job.startedAt, endedAt: job.endedAt ?? null,
        counts: job.counts, summary: job.summary, error: job.error || undefined,
        manualOpened: job.manual.opened, captures: job.captures,
      });
    } catch { /* 输出目录不可写时不阻断 */ }
  }

  function writeLastJob(job) {
    try {
      atomicWriteJson(path.join(st.stateDir, 'last-job.json'),
        { jobId: job.jobId, outDir: job.outDir, updatedAt: new Date().toISOString() });
    } catch { /* 状态目录不可写不阻断 */ }
  }

  // ---------- 条目翻转（人工捕获 / collect 归档共用） ----------

  function captureFlip(job, { doi, path: p, bytes, publisher }, source) {
    const key = String(doi).toLowerCase();
    const it = job.items.find(x => x.doi.toLowerCase() === key);
    if (!it || it.status === 'ok') return false;
    it.status = 'ok';
    it.state = 'done';
    it.note = source === 'collect' ? '人工文件已归档(collect)' : '人工下载已捕获';
    it.path = p || '';
    it.bytes = bytes || 0;
    it.reason = '';
    it.permanent = false;
    if (publisher) it.publisher = publisher;
    it.endedAt = it.endedAt || Date.now();
    try { writeDownloadProgress(job.outDir, job.items, job.meta || {}); } catch { /* 落盘失败不阻断 */ }
    return true;
  }

  function handleCaptured(job, cap, source) {
    const flipped = captureFlip(job, cap, source);
    job.captures.push({
      doi: cap.doi, path: cap.path, bytes: cap.bytes || 0,
      publisher: cap.publisher || '', source, flipped, at: Date.now(),
    });
    bump(job);
  }

  function handleCaptureFailed(job, f) {
    const key = String(f?.doi).toLowerCase();
    const it = job.items.find(x => x.doi.toLowerCase() === key);
    if (it) it.note = `人工捕获失败: ${f?.reason || '未知'}`;
    bump(job);
  }

  // ---------- 人工打开（open_manual 工具与批次结束自动打开共用） ----------

  function manualCandidates(job, { includeFailed = true, includePermanent = false } = {}) {
    return job.items
      .filter(it => {
        if (it.status === 'manual') return true;
        if (it.status === 'failed' && includeFailed) {
          if (it.permanent && !includePermanent) return false;
          return !NOT_OPENABLE_RE.test(it.reason || '');
        }
        return false;
      })
      .sort((a, b) => a.idx - b.idx);
  }

  function manualInfo(job) {
    // pending = 默认可选集（manual + 可打开 failed）中尚未变成 ok 的条目：
    // "已打开"不减少 pending（用户还没处理），只有捕获/collect 翻成 ok 才减少。
    const pending = manualCandidates(job).filter(it => it.status !== 'ok');
    return {
      pending: pending.map(it => ({ doi: it.doi, url: redactUrl(it.resolveUrl || `https://doi.org/${it.doi}`) })),
      pendingCount: pending.length,
      opened: job.manual.opened,
      lastResult: job.manual.lastResult ?? null,
      lastError: job.manual.lastError ?? null,
    };
  }

  async function doOpenManual(job, targets, source) {
    const c = coreRef;
    const entries = targets.map(it => ({
      doi: it.doi,
      url: it.resolveUrl || `https://doi.org/${it.doi}`,
      outDir: job.outDir,
      publisher: it.publisher || '',
    }));
    const openFn = openManualFn ?? c.openManualArticles;
    const r = await openFn(entries, {
      onCaptured: cap => handleCaptured(job, cap, source),
      onCaptureFailed: f => handleCaptureFailed(job, f),
    });
    for (const o of r?.opened ?? []) {
      job.manual.opened.push({ doi: o.doi, url: o.url, reused: Boolean(o.reused), openedAt: Date.now() });
    }
    bump(job);
    return { opened: r?.opened ?? [], failed: r?.failed ?? [], capture: r?.capture !== false };
  }

  // ---------- 事件 → job 记录 ----------

  function handleEvent(job, event) {
    if (event.type === 'start') {
      job.items = event.items.map(it => ({ ...it }));
      job.meta = { ...event.meta };
      job.total = event.meta?.total ?? job.items.length;
    } else if (event.type === 'item') {
      const idx = event.item?.idx;
      if (idx >= 1 && idx <= job.items.length) Object.assign(job.items[idx - 1], event.item);
    } else if (event.type === 'done') {
      // 只记 summary：state 留给 finishJob 收尾完成后置 'finished'（保证 finished ⇒ 已完全收场）
      job.summary = { ...event.summary };
    }
    bump(job);
  }

  async function finishJob(job, summary) {
    const c = coreRef;
    job.summary = summary ?? job.summary ?? null;
    job.counts = jobCounts(job.items);
    c.cfAssistRunEndSync?.({
      interrupted: Boolean(job.summary?.aborted),
      summary: { ok: job.counts.ok, failed: job.counts.failed, manual: job.counts.manual, exists: job.counts.exists },
    });
    // 批次结束不关窗（closeBrowserOnFinish=false）：有问题留给人工，无问题才收窗。
    // 注意：'finished' 必须等收窗/自动打开完成后再置位——观测方（长轮询）读到 finished 时
    // _mcp_job.json 必须已落盘、浏览器状态已定（此前的竞态让 e2e 提前读文件报 ENOENT）。
    const openable = manualCandidates(job);
    if (job.autoOpenManual && openable.length > 0) {
      try {
        job.manual.lastResult = await doOpenManual(job, openable.slice(0, job.manualLimit), 'auto');
      } catch (e) {
        job.manual.lastError = String(e?.message || e).substring(0, 160);
      }
    } else if (job.counts.failed === 0 && job.counts.manual === 0) {
      await c.closeBrowserSession?.().catch(() => {});
    }
    job.state = 'finished';
    job.endedAt = Date.now();
    writeJobFile(job);
    bump(job);
  }

  // ---------- 对外操作 ----------

  async function startJob(opts = {}) {
    const c = await ensureCore();
    if (isRunnerRunning(st.activeRunner)) {
      throw new McpError('BUSY', `已有批次在运行(jobId=${st.lastJobId})；等待结束（zhu_dl_status 长轮询）或 zhu_dl_stop 优雅停止`);
    }

    // 1. DOI 归集与校验
    const rawDois = [];
    const invalid = [];
    let skipped = Number(opts.skipped) || 0;
    for (const raw of opts.dois ?? []) {
      const d = normalizeDoi(raw);
      if (d) rawDois.push(d); else invalid.push(String(raw));
    }
    if (typeof opts.listText === 'string' && opts.listText.trim()) {
      const r = parseList(opts.listText);
      rawDois.push(...r.dois);
      skipped += r.skipped;
    }
    if (opts.listPath) {
      const p = String(opts.listPath);
      let text = '';
      try { text = fs.readFileSync(p, 'utf8'); } catch {
        throw new McpError('INVALID_ARGS', `清单文件不可读: ${p}`);
      }
      const r = parseList(text);
      rawDois.push(...r.dois);
      skipped += r.skipped;
    }
    const seen = new Set();
    const dois = [];
    for (const d of rawDois) {
      const k = d.toLowerCase();
      if (!seen.has(k)) { seen.add(k); dois.push(d); }
    }
    if (dois.length === 0) {
      throw new McpError('INVALID_ARGS',
        `未识别到任何 DOI${invalid.length ? `；无效 DOI: ${invalid.slice(0, 10).join(', ')}` : ''}（DOI 形如 10.xxxx/suffix，容忍 https://doi.org/ 与 doi: 前缀）`,
        { invalid });
    }

    // 2. outDir（含护栏：拒绝安装/开发目录、系统目录、驱动器根、主目录根；默认 ~/Downloads/ZhuDownLoader）
    const outDir = resolveOutDir(opts.outDir);
    const concurrency = clampInt(opts.concurrency, 1, 4, 2);
    const retries = clampInt(opts.retries, 0, 3, 1);
    const itemTimeoutMin = clampInt(opts.itemTimeoutMin, 0, 120, 10);
    const itemTimeoutMs = itemTimeoutMin > 0 ? itemTimeoutMin * 60000 : Infinity;
    const autoOpenManual = opts.autoOpenManual !== false;
    const manualLimit = clampInt(opts.manualLimit, 1, 16, DEFAULT_MANUAL_LIMIT);

    // 3. profile 预检：网页版/CLI/残留 Edge 占用时给出可执行的下一步，而不是让批次在第一篇上炸
    if (!c.isBrowserSessionOpen?.()) {
      try {
        await c.getVisibleBrowserContext?.();
      } catch (e) {
        throw new McpError('BROWSER_BUSY',
          `持久浏览器 profile 被占用(${String(e?.message || e).substring(0, 80)})。请关闭网页版与其他下载器实例、以及残留的下载器 Edge 窗口后重试。profile: ${c.getBrowserProfileDir?.() || ''}`);
      }
    }

    // 4. job 记录 + runner
    const jobId = `mcp-${Date.now().toString(36)}-${process.pid}`;
    const job = {
      jobId, version: 1, state: 'running', outDir,
      progressFile: path.join(outDir, '_download_progress.json'),
      items: [], counts: { total: dois.length }, summary: null, meta: null,
      manual: { opened: [], lastResult: null, lastError: null }, captures: [],
      error: '', autoOpenManual, manualLimit, itemTimeoutMin,
      concurrency, retries, startedAt: Date.now(), endedAt: null, restored: false,
    };
    st.jobs.set(jobId, job);
    st.lastJobId = jobId;

    const runner = runnerFactory
      ? runnerFactory({ onEvent: e => handleEvent(job, e) })
      : new c.BatchRunner({ onEvent: e => handleEvent(job, e) });
    st.activeRunner = runner;

    writeLastJob(job);
    c.cfAssistRunBegin?.({ runId: jobId, label: 'mcp_download', total: dois.length, progressFile: job.progressFile });
    st.activeRunBegan = true;

    // 5. 异步执行（不阻塞返回）；结束处理在 finishJob
    const listText = dois.join('\n');
    st.activeRunPromise = (async () => {
      try {
        const summary = await runner.run(listText, {
          outDir, concurrency, retries, itemTimeoutMs, closeBrowserOnFinish: false,
        });
        await finishJob(job, summary);
      } catch (e) {
        // shutdown 已标 interrupted（宿主退出）时不得改写成 error——跨重启恢复语义以 interrupted 为准
        if (job.state !== 'interrupted') {
          job.state = 'error';
          job.error = String(e?.message || e).substring(0, 200);
          job.endedAt = Date.now();
          job.counts = jobCounts(job.items);
          try { c.cfAssistRunEndSync?.({ interrupted: true, summary: job.counts }); } catch { /* 尽力而为 */ }
          writeJobFile(job);
        }
      } finally {
        if (st.activeRunner === runner) { st.activeRunner = null; st.activeRunPromise = null; }
        bump(job);
      }
    })();

    return {
      jobId, state: 'running', total: dois.length, skipped,
      outDir, progressFile: job.progressFile,
      concurrency, retries, itemTimeoutMin, autoOpenManual, manualLimit,
      next: `zhu_dl_status({jobId:"${jobId}", waitSeconds:20, sinceVersion:1}) 长轮询进度`,
    };
  }

  function cropItem(it) {
    return {
      idx: it.idx, doi: it.doi, status: it.status, state: it.state, phase: it.phase || '',
      publisher: it.publisher || '', reason: it.reason || '', note: it.note || '',
      attempt: it.attempt || 0, bytes: it.bytes || 0, path: it.path || '',
      resolveUrl: redactUrl(it.resolveUrl || ''), permanent: Boolean(it.permanent),
      durationMs: it.durationMs || 0,
    };
  }

  function nextHint(job, counts) {
    const problems = counts.failed + counts.manual;
    if (job.state === 'running') {
      return counts.done < counts.total
        ? `批次进行中；zhu_dl_status({jobId:"${job.jobId}", waitSeconds:20, sinceVersion:${job.version}}) 长轮询`
        : `收尾中（可能正在自动打开人工页面）；稍候再 zhu_dl_status`;
    }
    if (job.state === 'interrupted') {
      return `批次曾中断；zhu_dl_retry({jobId:"${job.jobId}"}) 重跑未完成条目（已存在的会自动跳过）`;
    }
    if (job.state === 'error') return `批次出错: ${job.error}；检查 outDir 与依赖后重试`;
    const info = manualInfo(job);
    if (info.pendingCount > 0) {
      return `用户在已打开的浏览器标签页里登录/过验证/点下载；之后 zhu_dl_status 确认 captures，剩余问题用 zhu_dl_open_manual 或 zhu_dl_retry`;
    }
    if (problems > 0) {
      return `有 ${problems} 条需人工/失败；zhu_dl_open_manual 打开页面（默认跳过打开也没用的确定性失败）或 zhu_dl_retry 重试`;
    }
    return '全部完成；zhu_dl_close 关闭下载器浏览器释放 profile';
  }

  async function status({ jobId, waitSeconds = 0, sinceVersion = 0, includeItems = 'problems' } = {}) {
    if (!jobId && !st.lastJobId) return { state: 'idle', next: '尚无批次；zhu_dl_download 发起' };
    const job = currentJob(jobId);

    const waitMs = Math.min(MAX_WAIT_SECONDS, Math.max(0, Number(waitSeconds) || 0)) * 1000;
    if (waitMs > 0 && sinceVersion > 0 && job.version <= sinceVersion) {
      await new Promise(resolve => {
        const wake = () => { clearTimeout(timer); st.waiters.delete(wake); resolve(); };
        const timer = setTimeout(wake, waitMs);
        st.waiters.add(wake);
      });
    }

    const counts = jobCounts(job.items);
    const problemItems = job.items.filter(it => it.status === 'failed' || it.status === 'manual');
    const payload = {
      jobId: job.jobId, state: job.state, version: job.version,
      changed: job.version !== (Number(sinceVersion) || 0),
      outDir: job.outDir, progressFile: job.progressFile,
      counts,
      running: job.items.filter(it => it.state === 'running')
        .map(it => ({ doi: it.doi, phase: it.phase || '', note: it.note || '', attempt: it.attempt || 0 })),
      problemsTotal: problemItems.length,
      manual: manualInfo(job),
      captures: job.captures,
      browserOpen: coreRef?.isBrowserSessionOpen?.() ?? false,
      summary: job.state === 'finished' ? job.summary : null,
      error: job.error || null,
      next: nextHint(job, counts),
    };
    // includeItems 裁剪：默认 problems（失败+需人工，最多 30 条）；all 才回全量；none 只回计数
    if (includeItems === 'problems') {
      payload.problems = problemItems.slice(0, PROBLEMS_MAX).map(cropItem);
      payload.problemsTruncated = problemItems.length > PROBLEMS_MAX;
    } else if (includeItems === 'all') {
      payload.items = job.items.map(cropItem);
    }
    return payload;
  }

  async function openManual({ jobId, dois, includeFailed = true, includePermanent = false, limit = DEFAULT_MANUAL_LIMIT, cursor = 0 } = {}) {
    await ensureCore();
    if (isRunnerRunning(st.activeRunner)) {
      throw new McpError('BUSY', `批次运行中(${st.lastJobId})不能打开人工页面；等批次结束（zhu_dl_status 长轮询）`);
    }
    const job = currentJob(jobId);
    let targets;
    if (Array.isArray(dois) && dois.length > 0) {
      const missing = [];
      targets = dois.map(raw => {
        const key = normalizeDoi(raw)?.toLowerCase() ?? String(raw).toLowerCase();
        const hit = job.items.find(it => it.doi.toLowerCase() === key);
        if (!hit) missing.push(String(raw));
        return hit;
      }).filter(Boolean);
      if (missing.length) {
        throw new McpError('INVALID_ARGS', `dois 不在 job ${job.jobId} 中: ${missing.slice(0, 10).join(', ')}`);
      }
    } else {
      targets = manualCandidates(job, { includeFailed, includePermanent });
    }
    const lim = clampInt(limit, 1, 16, DEFAULT_MANUAL_LIMIT);
    const cur = clampInt(cursor, 0, 1e6, 0);
    const page = targets.slice(cur, cur + lim);
    const result = await doOpenManual(job, page, 'open_manual');
    const remaining = Math.max(0, targets.length - cur - page.length);
    return {
      jobId: job.jobId,
      opened: result.opened.map(o => ({ ...o, url: redactUrl(o.url) })),
      failed: result.failed, capture: result.capture,
      totalOpenable: targets.length, cursor: cur, limit: lim, remaining,
      manual: manualInfo(job),
      next: result.failed.length > 0
        ? '有未能打开的条目（原因见 failed）'
        : remaining > 0
          ? `还剩 ${remaining} 条；zhu_dl_open_manual({cursor:${cur + lim}}) 继续打开下一批`
          : '用户在浏览器里登录/过验证/点下载；zhu_dl_status 观察 captures',
    };
  }

  async function retry({ jobId, dois, concurrency = 2, retries = 1 } = {}) {
    await ensureCore();
    if (isRunnerRunning(st.activeRunner)) {
      throw new McpError('BUSY', `批次运行中(${st.lastJobId})不能重试；等结束或 zhu_dl_stop`);
    }
    const job = currentJob(jobId);
    let redo;
    if (Array.isArray(dois) && dois.length > 0) {
      const missing = [];
      redo = dois.map(raw => {
        const key = normalizeDoi(raw)?.toLowerCase() ?? String(raw).toLowerCase();
        const hit = job.items.find(it => it.doi.toLowerCase() === key);
        if (!hit) missing.push(String(raw));
        return hit;
      }).filter(Boolean);
      if (missing.length) {
        throw new McpError('INVALID_ARGS', `dois 不在 job ${job.jobId} 中: ${missing.slice(0, 10).join(', ')}`);
      }
    } else {
      redo = job.items.filter(it => it.status === 'manual' || it.status === 'failed');
    }
    redo = redo.filter(it => !coreRef.existingPdf(it.doi, job.outDir));
    if (redo.length === 0) {
      throw new McpError('INVALID_ARGS', '没有需要重试的条目（剩余问题都已成功或 PDF 已存在）');
    }
    return startJob({
      dois: redo.map(it => it.doi),
      outDir: job.outDir,
      concurrency, retries,
      itemTimeoutMin: job.itemTimeoutMin,
      autoOpenManual: job.autoOpenManual,
      manualLimit: job.manualLimit,
    });
  }

  async function collect({ jobId, scanDirs = [], adopt = false } = {}) {
    await ensureCore();
    const job = currentJob(jobId);
    const c = coreRef;
    const result = { jobId: job.jobId, outDir: job.outDir, found: [], adopted: [], notPdf: [], ambiguous: [], flipped: [] };

    // 1. outDir 复查：用户手动放进输出目录的 PDF 直接认领
    for (const it of job.items) {
      if (it.status === 'ok' || it.status === 'exists') continue;
      const p = c.existingPdf(it.doi, job.outDir);
      if (p) {
        const bytes = fs.statSync(p).size;
        const flipped = captureFlip(job, { doi: it.doi, path: p, bytes }, 'collect-found');
        result.found.push({ doi: it.doi, path: p, bytes, flipped });
        if (flipped) result.flipped.push(it.doi);
      }
    }

    // 2. 外部目录扫描：只扫一级 *.pdf，文件名含 sanitize(doi) 或 DOI 原文才算候选
    const dirs = Array.isArray(scanDirs) ? scanDirs : [];
    if (dirs.length > 0) {
      const files = [];
      for (const dir of dirs) {
        let entries;
        try { entries = fs.readdirSync(String(dir), { withFileTypes: true }); } catch {
          throw new McpError('INVALID_ARGS', `扫描目录不可读: ${dir}`);
        }
        for (const e of entries) {
          if (e.isFile() && e.name.toLowerCase().endsWith('.pdf')) {
            files.push({ name: e.name, full: path.join(String(dir), e.name) });
          }
        }
      }
      for (const it of job.items) {
        if (it.status === 'ok' || it.status === 'exists') continue;
        const sani = c.sanitize(it.doi).toLowerCase();
        const rawLower = it.doi.toLowerCase();
        const matches = files.filter(f => {
          const n = f.name.toLowerCase();
          return n.includes(sani) || n.includes(rawLower);
        });
        if (matches.length === 0) continue;
        if (matches.length > 1) {
          result.ambiguous.push({ doi: it.doi, files: matches.map(m => m.full) });
          continue;
        }
        const f = matches[0];
        if (!c.isPdfFile(f.full)) {
          result.notPdf.push({ doi: it.doi, file: f.full });
          continue;
        }
        if (adopt) {
          // 复制不移动：绝不静默动用户原文件
          const dest = path.join(job.outDir, `${c.sanitize(it.doi)}.pdf`);
          fs.copyFileSync(f.full, dest);
          const bytes = fs.statSync(dest).size;
          captureFlip(job, { doi: it.doi, path: dest, bytes }, 'collect');
          c.appendLog(job.outDir, it.doi, it.publisher || '-', '成功(人工)', path.basename(dest));
          result.adopted.push({ doi: it.doi, from: f.full, path: dest, bytes });
          result.flipped.push(it.doi);
        } else {
          result.found.push({ doi: it.doi, file: f.full, adoptable: true });
        }
      }
    }

    bump(job);
    return {
      ...result,
      counts: jobCounts(job.items),
      next: result.ambiguous.length > 0
        ? `有 ${result.ambiguous.length} 条多文件命中（ambiguous），改清单文件名后重扫；绝不猜`
        : (result.adopted.length + result.found.length) > 0
          ? '已归档/发现的条目见上；确认后 zhu_dl_status 或 zhu_dl_close'
          : '未发现可归档文件；确认 PDF 位置后重扫',
    };
  }

  async function stop({ jobId } = {}) {
    const job = currentJob(jobId);
    if (!isRunnerRunning(st.activeRunner)) {
      return { jobId: job.jobId, state: job.state, note: '无运行中的批次，无需停止' };
    }
    st.activeRunner.stop();
    return { jobId: job.jobId, state: 'stopping', note: '优雅停止中：进行中的一篇跑完后收场，不再领取新任务' };
  }

  async function close({ force = false } = {}) {
    const c = await ensureCore();
    if (isRunnerRunning(st.activeRunner)) {
      if (!force) {
        throw new McpError('BROWSER_BUSY', `批次运行中(${st.lastJobId})，不能关闭浏览器；先 zhu_dl_stop，或传 force=true 停批后关闭`);
      }
      st.activeRunner.stop();
      await Promise.race([
        st.activeRunPromise?.catch(() => {}),
        sleep(8000),
      ]);
    }
    await c.closeBrowserSession();
    return { closed: true, browserOpen: c.isBrowserSessionOpen?.() ?? false };
  }

  /** 进程退出路径（server 的 SIGINT/SIGTERM/stdin EOF 调用）：停批 → 限时等收尾落定 →
   *  未完成才标 interrupted → 限时收窗 → run.json 收口。
   *  关键：activeRunPromise 含 finishJob（收窗/自动打开人工页），宿主退出可能正好落在
   *  收尾的 1-2s 窗口——必须等它落定后写 _mcp_job.json，否则文件永远缺失（s7 实测）。 */
  async function shutdown({ timeoutMs = 4000 } = {}) {
    try {
      if (isRunnerRunning(st.activeRunner)) st.activeRunner.stop();
      if (st.activeRunPromise) {
        await Promise.race([st.activeRunPromise.catch(() => {}), sleep(timeoutMs)]);
      }
      const job = st.jobs.get(st.lastJobId);
      const interrupted = Boolean(job && job.state === 'running'); // 收场未完成 → 如实标中断
      if (interrupted) {
        job.state = 'interrupted';
        job.endedAt = Date.now();
        job.counts = jobCounts(job.items);
        writeJobFile(job);
      }
      if (st.activeRunBegan) {
        await Promise.race([coreRef?.closeBrowserSession?.().catch(() => {}), sleep(Math.min(1500, timeoutMs))]);
        coreRef?.cfAssistRunEndSync?.({ interrupted, summary: interrupted ? (job?.counts ?? null) : null });
      }
    } catch { /* 退出路径尽力而为 */ }
  }

  // ---------- 跨重启恢复 ----------

  async function init() {
    if (st.initDone) return;
    st.initDone = true;
    const last = readJson(path.join(st.stateDir, 'last-job.json'));
    if (!last?.jobId || !last?.outDir) return;
    const jobFile = readJson(path.join(last.outDir, '_mcp_job.json'));
    if (!jobFile || jobFile.jobId !== last.jobId) return; // 状态文件缺失/错位：不恢复
    if (st.jobs.has(last.jobId)) return;
    const rows = readJson(path.join(last.outDir, '_download_progress.json'))?.items ?? [];
    const terminal = ['ok', 'failed', 'manual', 'exists'];
    const items = rows.map((r, i) => ({
      idx: i + 1, doi: r.doi, publisher: r.publisher || '',
      state: terminal.includes(r.status) ? 'done' : 'pending', phase: '',
      attempt: r.attempt || 0, startedAt: 0, endedAt: 0, durationMs: r.elapsedMs || 0,
      status: r.status || '', reason: r.note || '', note: '', path: '', bytes: r.bytes || 0,
      resolveUrl: r.resolveUrl || `https://doi.org/${r.doi}`,
      permanent: Boolean(r.permanent),
    }));
    const wasRunning = jobFile.state === 'running';
    const job = {
      jobId: last.jobId, version: 1, state: wasRunning ? 'interrupted' : (jobFile.state || 'interrupted'),
      outDir: last.outDir, progressFile: path.join(last.outDir, '_download_progress.json'),
      items, counts: jobCounts(items), summary: jobFile.summary ?? null,
      meta: { outDir: last.outDir, concurrency: null, startedAt: jobFile.startedAt ?? 0 },
      manual: { opened: Array.isArray(jobFile.manualOpened) ? jobFile.manualOpened : [], lastResult: null, lastError: null },
      captures: Array.isArray(jobFile.captures) ? jobFile.captures : [],
      error: jobFile.error || '', autoOpenManual: true, manualLimit: DEFAULT_MANUAL_LIMIT,
      itemTimeoutMin: null, concurrency: null, retries: null,
      startedAt: jobFile.startedAt ?? 0, endedAt: jobFile.endedAt ?? null, restored: true,
    };
    st.jobs.set(job.jobId, job);
    st.lastJobId = job.jobId;
    if (wasRunning) {
      // 上个宿主没走完就退了：如实标 interrupted 并写回（验收矩阵"宿主退出"）
      jobFile.state = 'interrupted';
      jobFile.endedAt = jobFile.endedAt ?? Date.now();
      atomicWriteJson(path.join(job.outDir, '_mcp_job.json'), jobFile);
    }
  }

  return {
    init, startJob, status, openManual, retry, collect, stop, close, shutdown,
    get lastJobId() { return st.lastJobId; },
    get isRunning() { return isRunnerRunning(st.activeRunner); },
    _job(jobId) { return currentJob(jobId); }, // 测试检查内部状态用
  };
}
