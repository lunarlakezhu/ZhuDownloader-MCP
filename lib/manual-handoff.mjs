// 人工接管与下载捕获（MCP 步骤1）：把"打开文章页让用户自己下"变成可闭环——
// 用户在下载器专用持久 Edge 里点下的 PDF 直接成为 <outDir>/<DOI>.pdf 并回调上报。
//
// 边界与不变量：
// - 复用 getVisibleBrowserContext() 的持久 context：人工标签页与 24 条策略共享 cookie/登录态，
//   用户在此登录后 retry 直接受益。
// - 每个 DOI 一个标签页，不按 origin 去重（openInDownloadBrowser 是"登录一站开一页"，
//   语义不同，勿混用）；同 DOI 已有跟踪页时 bringToFront 复用，不重复开。
// - 只安装一次 context 级监听（按 context 记账，openManualArticles 可多次调用/分页打开）；
//   只处理能映射到人工条目的下载（经 opener 链追溯弹窗/PDF 新标签），策略自身的下载
//   页面不在映射内，绝不干扰。
// - 只捕获浏览器"下载"事件：Ctrl+S / 打印成 PDF 不触发本路径，走 zhu_dl_collect 归档。
// - 非法产物（HTML 登录页等）当场删除并记 not-pdf，绝不把假 PDF 留在输出目录。
import fs from 'fs';
import path from 'path';
import { getVisibleBrowserContext, sanitize, isPdfFile, appendLog } from './downloader.mjs';

const GOTO_TIMEOUT_MS = 20000;
const SAVE_TIMEOUT_MS = 120000; // 单个下载件 saveAs 上限；超时按捕获失败收场不悬挂
const OPENER_CHAIN_DEPTH = 6;   // 弹窗套娃层数上限（实际 1-2 层）
const sleep = ms => new Promise(r => setTimeout(r, ms));

let tmpSeq = 0;

// 每个持久 context 一份捕获状态：pageMap(Page → entry) 跨多次调用累积（分页打开/同 DOI 复用）。
// context 关闭后 WeakMap 自动失效，监听随 context 一起消亡，无需手动注销。
const captureStates = new WeakMap();

/** 归一化人工打开地址：只接受 http/https；非 localhost 的 http 自动升级 https（与
 *  openInDownloadBrowser 一致）。返回可直接 goto 的 href。 */
function normalizeEntryUrl(input) {
  let u;
  try { u = new URL(String(input)); } catch { throw new Error(`无效的页面地址: ${input}`); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error(`不支持的页面地址: ${u.protocol}`);
  if (u.protocol === 'http:' && !['127.0.0.1', 'localhost'].includes(u.hostname)) u.protocol = 'https:';
  return u.href;
}

/** 页面 → 人工条目：先查本页，再沿 opener 链追溯（target=_blank 弹窗 / PDF 新标签）。 */
function entryForPage(page, st) {
  let p = page;
  for (let depth = 0; depth < OPENER_CHAIN_DEPTH && p; depth++) {
    const hit = st.pageMap.get(p);
    if (hit) return hit;
    try { p = p.opener(); } catch { return null; }
  }
  return null;
}

function trackPage(st, page, entry) {
  st.pageMap.set(page, entry);
  page.on('close', () => { try { st.pageMap.delete(page); } catch { /* 页面已销毁 */ } });
}

/** 捕获一个下载件（同一 DOI 串行，避免并发 rename 互踩）。
 *  顺序：saveAs 到 .part（120s 上限）→ failure 检查 → %PDF 头校验 → 原子替换 → 落日志 → 回调。 */
async function captureDownload(download, entry) {
  const { doi, outDir, publisher } = entry;
  const finalPath = path.join(outDir, `${sanitize(doi)}.pdf`);
  tmpSeq += 1;
  const tmpPath = `${finalPath}.${Date.now().toString(36)}${tmpSeq.toString(36)}.part`;
  const recordFail = reason => {
    appendLog(outDir, doi, publisher || '-', '需人工', `人工下载未捕获: ${reason}`);
    entry.onCaptureFailed?.({ doi, reason });
  };
  try {
    let timedOut = false;
    await Promise.race([
      download.saveAs(tmpPath),
      sleep(SAVE_TIMEOUT_MS).then(() => { timedOut = true; }),
    ]);
    if (timedOut) { try { await download.cancel(); } catch { /* 已结束的下载无需取消 */ } recordFail(`saveAs超时(${SAVE_TIMEOUT_MS / 1000}s)`); return; }
    // playwright ≥1.5x 的 failure() 是异步 API（Promise<null|string>）：下载已失败时 resolve 出
    // 错误串，正常完成时 resolve null。同步 truthy 判断会把 Promise 对象误判为失败。
    const failure = await download.failure().catch(() => null);
    if (failure) { try { fs.rmSync(tmpPath, { force: true }); } catch { /* 临时件不存在则忽略 */ } recordFail(`下载失败: ${failure}`); return; }
    if (!isPdfFile(tmpPath)) {
      // 内容非 PDF（多半是登录页/错误页 HTML）：绝不留假 PDF 在输出目录，临时件当场删除
      try { fs.rmSync(tmpPath, { force: true }); } catch { /* 临时件不存在则忽略 */ }
      recordFail('not-pdf(内容非PDF，可能是登录页)');
      return;
    }
    try {
      fs.renameSync(tmpPath, finalPath);
    } catch {
      // Windows 下目标被占用（如已在 PDF 阅读器打开）时 rename 覆盖失败：先删再 rename
      fs.rmSync(finalPath, { force: true });
      fs.renameSync(tmpPath, finalPath);
    }
    const bytes = fs.statSync(finalPath).size;
    appendLog(outDir, doi, publisher || '-', '成功(人工)', path.basename(finalPath));
    entry.onCaptured?.({ doi, path: finalPath, bytes, publisher: publisher || '' });
  } catch (e) {
    try { fs.rmSync(tmpPath, { force: true }); } catch { /* 临时件不存在则忽略 */ }
    recordFail(`捕获异常: ${(e?.message || String(e)).substring(0, 100)}`);
  }
}

function installContextListeners(ctx, st) {
  if (st.installed) return;
  st.installed = true;
  // 弹窗 / PDF 新标签：经 opener 链映射回人工条目后才登记；策略自建的页面 opener 为空，不受影响
  ctx.on('page', page => {
    const entry = entryForPage(page, st);
    if (entry) trackPage(st, page, entry);
  });
  ctx.on('download', download => {
    let page = null;
    try { page = download.page(); } catch { return; } // 发起页已销毁，无从映射
    const entry = page ? entryForPage(page, st) : null;
    if (!entry) return; // 策略自身的下载或其他无关标签：绝不干预
    entry.chain = entry.chain.then(() => captureDownload(download, entry)).catch(() => {});
  });
}

/**
 * 在下载器专用持久 Edge 中逐篇打开文章页，供用户自行登录/过验证/点下载；用户点下的
 * PDF 经 context 级下载监听捕获到 outDir（详见模块头注释）。
 * @param {Array<{doi: string, url?: string, outDir: string, publisher?: string}>} entries
 * @param {{onCaptured?: ({doi,path,bytes,publisher}) => void,
 *          onCaptureFailed?: ({doi,reason}) => void,
 *          onPage?: (page, entry) => void|Promise<void>}} [opts]
 *   onPage 为每篇新开页面（非复用）的钩子，测试用它真实点击下载链接；钩子抛错按该篇失败计。
 * @returns {Promise<{opened: Array<{doi,url,reused}>, failed: Array<{doi,url,error}>, capture: boolean}>}
 */
export async function openManualArticles(entries, { onCaptured, onCaptureFailed, onPage } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { opened: [], failed: [], capture: false };
  }
  const ctx = await getVisibleBrowserContext();
  let st = captureStates.get(ctx);
  if (!st) { st = { pageMap: new Map(), installed: false }; captureStates.set(ctx, st); }
  installContextListeners(ctx, st);

  const tasks = entries.map(entry => (async () => {
    const url = normalizeEntryUrl(entry.url ?? `https://doi.org/${entry.doi}`);
    const outDir = entry.outDir;
    if (!path.isAbsolute(outDir)) throw new Error('outDir 须为绝对路径');
    fs.mkdirSync(outDir, { recursive: true });

    // 同 DOI 已有跟踪页：bringToFront 复用，不重复开（"每个 DOI 一个标签页"）
    for (const [page, mapped] of st.pageMap) {
      if (mapped.doi === entry.doi && !page.isClosed()) {
        await page.bringToFront().catch(() => {});
        return { doi: entry.doi, url, reused: true };
      }
    }

    const node = {
      doi: entry.doi, url, outDir, publisher: entry.publisher || '',
      onCaptured, onCaptureFailed, chain: Promise.resolve(),
    };
    const page = await ctx.newPage();
    trackPage(st, page, node);
    try {
      await page.goto(url, { waitUntil: 'commit', timeout: GOTO_TIMEOUT_MS });
    } catch (e) {
      // 慢站 domcontentloaded 不触发是常态：地址已到目标 origin 就保留给用户继续操作
      let current = null;
      try { current = new URL(page.url()); } catch { /* about:blank */ }
      if (!current || current.origin !== new URL(url).origin) {
        st.pageMap.delete(page);
        await page.close().catch(() => {});
        throw new Error(`文章页未能打开: ${(e?.message || String(e)).substring(0, 100)}`);
      }
    }
    await page.bringToFront().catch(() => {});
    await onPage?.(page, { ...node, chain: undefined });
    return { doi: entry.doi, url, reused: false };
  })());

  const settled = await Promise.allSettled(tasks);
  const opened = [];
  const failed = [];
  settled.forEach((r, i) => {
    const { doi, url } = entries[i];
    if (r.status === 'fulfilled') opened.push(r.value);
    else failed.push({ doi, url: url || '', error: String(r.reason?.message || r.reason).substring(0, 160) });
  });
  return { opened, failed, capture: st.installed };
}
