// 人工接管与下载捕获 e2e（MCP 步骤1验收）：离线、真 Edge（可见窗口，可人工目检）、临时 profile。
// 本机 HTTP 服务提供文章页/合法 PDF/伪装成 PDF 的 HTML 登录页/popup 形态，断言：
// ①点击下载 → <outDir>/<sanitize(doi)>.pdf 落地、%PDF 头、onCaptured 回调、download.log 成功(人工)；
// ②HTML 假 PDF → 临时件被删、输出目录无假 PDF、not-pdf 记录；
// ③target=_blank 弹窗 → 经 opener 链映射仍能捕获；④同 DOI 再次打开 → bringToFront 复用。
// 运行: node test_mcp_manual_e2e.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// profile 必须指向临时目录且先于 downloader.mjs 首次加载（BROWSER_PROFILE_DIR 在模块加载时读取）
process.env.ZHU_BROWSER_PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zhu-manual-profile-'));

const { openManualArticles } = await import('./lib/manual-handoff.mjs');
const { closeBrowserSession, existingPdf } = await import('./lib/downloader.mjs');

const PDF_BODY = Buffer.concat([
  Buffer.from('%PDF-1.4\n%e2e manual capture test\n'),
  Buffer.alloc(2048, 0x20),
  Buffer.from('\n%%EOF\n'),
]);
const HTML_PAGE = body => `<!doctype html><meta charset="utf-8"><title>e2e</title>${body}`;

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/article-ok') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML_PAGE('<a id="dl" href="/paper-ok.pdf" download="paper.pdf">Download PDF</a>'));
  } else if (url === '/paper-ok.pdf' || url === '/paper-pop.pdf') {
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${path.basename(url)}"`,
      'Content-Length': PDF_BODY.length,
    });
    res.end(PDF_BODY);
  } else if (url === '/fake-start') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML_PAGE('<a id="dl" href="/fake.pdf">Download PDF</a>'));
  } else if (url === '/fake.pdf') {
    // 订阅文无权限的真实形态：端点自称 PDF，实际回 HTML 登录页（attachment 触发下载事件）
    const body = Buffer.from('<!doctype html><html><body>Login Required</body></html>');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Disposition': 'attachment; filename="fake.pdf"',
      'Content-Length': body.length,
    });
    res.end(body);
  } else if (url === '/popup-article') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML_PAGE('<a id="pop" target="_blank" href="/paper-pop.pdf">Open PDF in new tab</a>'));
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhu-manual-out-'));
const captured = [];
const captureFailed = [];
const shared = {
  onCaptured: c => captured.push(c),
  onCaptureFailed: f => captureFailed.push(f),
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, what, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(100);
  }
  throw new Error(`等待超时: ${what}`);
}

let passed = 0;
try {
  // ---------- 用例1：正常点击下载 → 捕获为 <outDir>/<DOI>.pdf ----------
  const r1 = await openManualArticles(
    [{ doi: '10.9999/manual-e2e-ok', url: `http://127.0.0.1:${port}/article-ok`, outDir, publisher: 'e2e' }],
    { ...shared, onPage: async page => { await page.click('#dl'); } },
  );
  assert.equal(r1.failed.length, 0, `用例1 打开失败: ${JSON.stringify(r1.failed)}`);
  assert.equal(r1.opened.length, 1);
  assert.equal(r1.opened[0].reused, false);
  assert.equal(r1.capture, true, '捕获监听应已安装');
  const okPdf = path.join(outDir, '10.9999_manual-e2e-ok.pdf');
  await waitFor(() => fs.existsSync(okPdf), '正常下载捕获落盘');
  const head = Buffer.alloc(4);
  {
    const fd = fs.openSync(okPdf, 'r');
    try { fs.readSync(fd, head, 0, 4, 0); } finally { fs.closeSync(fd); }
  }
  assert.equal(head.toString(), '%PDF', '落盘文件头为 %PDF');
  await waitFor(() => captured.some(c => c.doi === '10.9999/manual-e2e-ok'), 'onCaptured 回调');
  const cap = captured.find(c => c.doi === '10.9999/manual-e2e-ok');
  assert.equal(cap.bytes, PDF_BODY.length, 'onCaptured 报告字节数');
  assert.equal(cap.path, okPdf);
  assert.equal(cap.publisher, 'e2e');
  const log1 = fs.readFileSync(path.join(outDir, 'download.log'), 'utf8');
  assert.match(log1, /10\.9999\/manual-e2e-ok → E2E → 成功\(人工\)/, 'download.log 记录成功(人工)');
  console.log('✓ 用例1 点击下载 → 捕获为 <DOI>.pdf（%PDF 头/回调/日志）');
  passed += 1;

  // ---------- 用例2：伪装成 PDF 的 HTML → not-pdf，无假 PDF 留存 ----------
  const r2 = await openManualArticles(
    [{ doi: '10.9999/manual-e2e-bad', url: `http://127.0.0.1:${port}/fake-start`, outDir, publisher: 'e2e' }],
    { ...shared, onPage: async page => { await page.click('#dl'); } },
  );
  assert.equal(r2.failed.length, 0, `用例2 打开失败: ${JSON.stringify(r2.failed)}`);
  await waitFor(
    () => captureFailed.some(f => f.doi === '10.9999/manual-e2e-bad' && f.reason.includes('not-pdf')),
    'not-pdf 记录',
  );
  assert.equal(existingPdf('10.9999/manual-e2e-bad', outDir), null, '输出目录不得出现假 PDF');
  const leftovers = fs.readdirSync(outDir)
    .filter(n => n.endsWith('.part') || n.endsWith('.pdf'));
  assert.deepEqual(
    leftovers.sort(),
    ['10.9999_manual-e2e-ok.pdf'],
    `临时 .part 必须被清理，PDF 仅剩用例1 产物（实际: ${JSON.stringify(leftovers)}）`,
  );
  assert.ok(!captured.some(c => c.doi === '10.9999/manual-e2e-bad'), 'not-pdf 不得走 onCaptured');
  console.log('✓ 用例2 HTML 假 PDF → not-pdf 记录、临时件清理、无假 PDF 留存');
  passed += 1;

  // ---------- 用例3：target=_blank 弹窗下载 → opener 链映射仍能捕获 ----------
  const r3 = await openManualArticles(
    [{ doi: '10.9999/manual-e2e-pop', url: `http://127.0.0.1:${port}/popup-article`, outDir, publisher: 'e2e' }],
    { ...shared, onPage: async page => { await page.click('#pop'); } },
  );
  assert.equal(r3.failed.length, 0, `用例3 打开失败: ${JSON.stringify(r3.failed)}`);
  const popPdf = path.join(outDir, '10.9999_manual-e2e-pop.pdf');
  await waitFor(() => fs.existsSync(popPdf), '弹窗下载捕获落盘');
  assert.ok(captured.some(c => c.doi === '10.9999/manual-e2e-pop'), '弹窗捕获走 onCaptured');
  console.log('✓ 用例3 target=_blank 弹窗 → opener 链映射捕获');
  passed += 1;

  // ---------- 用例4：同 DOI 再次打开 → bringToFront 复用，不重复开标签 ----------
  const r4 = await openManualArticles(
    [{ doi: '10.9999/manual-e2e-ok', url: `http://127.0.0.1:${port}/article-ok`, outDir }],
    { ...shared },
  );
  assert.equal(r4.opened.length, 1);
  assert.equal(r4.opened[0].reused, true, '同 DOI 已跟踪页面应复用');
  console.log('✓ 用例4 同 DOI 再次打开 → 复用已跟踪页面');
  passed += 1;

  console.log(`\n人工接管 e2e: ${passed}/4 通过（可见 Edge 窗口即人工目检形态）`);
} catch (e) {
  console.error(`FAIL ${e?.message || e}`);
  process.exitCode = 1;
} finally {
  server.close();
  await closeBrowserSession().catch(() => {});
  for (const dir of [outDir, process.env.ZHU_BROWSER_PROFILE_DIR]) {
    if (path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}
