// zhu-dl 工具桥：把 JobManager 暴露成 8 个 MCP 工具（施工计划步骤3）。
// 职责：工具 schema 声明、参数类型/范围校验（语义校验在 mcp/jobs.mjs）、输出统一 JSON 文本。
// JobManager 单例懒初始化：init() 只读状态文件（零浏览器依赖），guide/tools/list 永远可用；
// download 等核心操作才会触发 loadCore()（playwright 缺失 → DEPENDENCY_MISSING）。
import { createJobManager, McpError } from './jobs.mjs';

export const serverInfo = { name: 'zhu-downloader', version: '0.1.0' };

let mgr = null;
let initPromise = null;

function manager() {
  if (!mgr) mgr = createJobManager();
  return mgr;
}

async function initialized() {
  const m = manager();
  if (!initPromise) initPromise = m.init();
  await initPromise;
  return m;
}

/** server 退出路径调用（stdin EOF / SIGINT / SIGTERM）：停批 → 限时收窗 → 标记中断。 */
export async function shutdownManager() {
  if (!mgr) return;
  await mgr.shutdown({ timeoutMs: 5000 });
}

// ---------- 参数校验原语（类型 + 范围；超范围报 INVALID_ARGS 不静默钳制） ----------

function failInvalid(msg) { throw new McpError('INVALID_ARGS', msg); }

function strArr(v, name) {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) failInvalid(`参数 ${name} 须为字符串数组`);
  return v;
}

function str(v, name) {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') failInvalid(`参数 ${name} 须为字符串`);
  return v;
}

function bool(v, name, dflt) {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== 'boolean') failInvalid(`参数 ${name} 须为布尔值`);
  return v;
}

function int(v, name, { min, max, dflt }) {
  if (v === undefined || v === null) return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) failInvalid(`参数 ${name} 须为 ${min}-${max} 的整数`);
  return n;
}

function enumOf(v, name, allowed, dflt) {
  if (v === undefined || v === null) return dflt;
  if (!allowed.includes(v)) failInvalid(`参数 ${name} 须为 ${allowed.join('|')} 之一`);
  return v;
}

// ---------- agent 操作规程（zhu_dl_guide 返回值） ----------

const GUIDE_TEXT = `ZhuDownLoader MCP — 文献批量下载操作规程（agent 必读）

一、标准流程
1. 发起：zhu_dl_download { dois: [...], outDir: "<绝对路径>", concurrency: 2, retries: 1 }
   - 也支持 listText（清单全文）或 listPath（清单文件路径）；DOI 形如 10.xxxx/suffix，容忍 https://doi.org/ 与 doi: 前缀。
   - 下载到哪里（重要）：outDir 未指定时默认 ~/Downloads/ZhuDownLoader（ZHU_DL_DEFAULT_OUT 可改默认）。
     用户没说存哪里就先确认一句，或明确告知将用默认目录；**汇报时必须重申最终 outDir 与成功篇数**。
     服务会直接拒绝这些位置（ERROR: INVALID_ARGS）：ZhuDownLoader 安装/开发目录、Windows 系统目录
     （C:\\Windows、Program Files）、驱动器根（C:\\、D:\\）、用户主目录根。
   - 立即返回 { jobId, state:"running", total, outDir, progressFile }，不阻塞。
   - 默认 autoOpenManual=true：批次结束后自动把"需人工/可重试失败"条目在下载器专用 Edge 打开（最多 manualLimit=8 个标签页，余下用 zhu_dl_open_manual 的 cursor 分批）。
2. 轮询：zhu_dl_status { jobId, waitSeconds: 20, sinceVersion: <上次返回的 version> }
   - 长轮询：job 有变化立即返回（changed:true），无变化等到超时。
   - counts：ok/failed/manual/exists/running/total；problems：失败+需人工明细（默认最多 30 条）；
     manual.pending：等用户处理的条目；captures：人工捕获成功的条目；browserOpen：浏览器状态。
3. 批次结束（state=finished）：
   - 全部成功 → zhu_dl_close 收尾。
   - 有 manual.pending → 告知用户"已在浏览器打开 N 个标签页，请登录/过验证/点下载"；
     之后 zhu_dl_status 观察 captures（用户点下的 PDF 自动落盘为 <outDir>/<DOI>.pdf 并翻成 ok）。
   - 用户说处理完了 → zhu_dl_retry { jobId } 重试剩余问题（新 jobId；已成功/已存在自动跳过）。
   - 用户自己另存了文件 → zhu_dl_collect { jobId, scanDirs:["外部目录"], adopt:true } 按文件名匹配归档（只复制不动原文件；多命中列 ambiguous 绝不猜）。
4. 分页打开：问题条目数 > limit 时 zhu_dl_open_manual 返回 remaining，用 cursor 继续打开。
5. 收尾：zhu_dl_close {} 关闭下载器浏览器、释放 profile。运行中 close 被拒绝（先 zhu_dl_stop，或 force:true 停批后关）。

二、安全边界（必须遵守）
- 绝不自动操作图选/OTP/滑块验证码；仅复用下载器既有的"Turnstile 勾选框有界自动点一次"。
- 发起批次前确认没有网页版/CLI 正在跑同一 profile（占用时报 BROWSER_BUSY，关闭对方后重试）。
- 打开多个标签页前先告知用户会弹出的窗口数量。
- MCP 宿主退出会中断运行中的批次（_mcp_job.json 标 interrupted；重启后 zhu_dl_status 可见，zhu_dl_retry 续跑）。
- 浏览器 Ctrl+S / 打印成 PDF 不触发自动捕获；这类文件用 zhu_dl_collect 归档。
- 状态展示中的 URL 已去查询串（脱敏）；打开页面用完整地址；cookie/token 不写入日志。

三、错误码（文本形如 ERROR: <CODE>: <message>，message 含下一步）
- BUSY：已有批次在运行 → zhu_dl_status 长轮询或 zhu_dl_stop
- NO_JOB：无批次/找不到 jobId → zhu_dl_download 发起
- INVALID_ARGS：参数错误 → 按 message 修正
- BROWSER_BUSY：profile 被网页版/CLI/残留 Edge 占用，或运行中拒绝关闭 → 关闭占用方后重试
- DEPENDENCY_MISSING：playwright 未装 → npm ci && npx playwright install chromium，或双击 一键安装环境.bat
- BATCH_FAILED：批次内部错误 → 看 message 与 outDir/_mcp_job.json`;

const OBJECT_SCHEMA = { type: 'object', properties: {}, additionalProperties: false };

export function registerTools(register) {
  const def = (name, description, inputSchema, run) => register({
    name, description, inputSchema,
    execute: async args => {
      const m = await initialized();
      const data = await run(m, args ?? {});
      return data === undefined ? GUIDE_TEXT : JSON.stringify(data, null, 2);
    },
  });

  // 1. zhu_dl_guide
  def('zhu_dl_guide',
    'ZhuDownLoader 文献下载操作规程：download→status 长轮询→人工接管→retry/collect→close 的完整步骤与安全边界。开始任何下载任务前先调用本工具。',
    OBJECT_SCHEMA,
    async () => GUIDE_TEXT);

  // 2. zhu_dl_download
  def('zhu_dl_download',
    '提交一批 DOI 立即返回 jobId 异步执行（不阻塞）。单篇或批量；批次结束后自动把需人工条目在下载器专用 Edge 打开（autoOpenManual）。',
    {
      type: 'object',
      properties: {
        dois: { type: 'array', items: { type: 'string' }, description: 'DOI 列表（10.xxxx/suffix，容忍 doi.org 前缀）' },
        listText: { type: 'string', description: '清单全文（每行一个 DOI，支持注释与混合行）' },
        listPath: { type: 'string', description: '清单文件绝对路径' },
        outDir: { type: 'string', description: '输出目录（绝对路径；默认 ~/Downloads/ZhuDownLoader，可用 ZHU_DL_DEFAULT_OUT 覆盖）' },
        concurrency: { type: 'integer', minimum: 1, maximum: 4, description: '并发数（默认 2）' },
        retries: { type: 'integer', minimum: 0, maximum: 3, description: '单篇自动重试次数（默认 1）' },
        itemTimeoutMin: { type: 'integer', minimum: 0, maximum: 120, description: '单篇看门狗分钟数（默认 10，0=关闭）' },
        autoOpenManual: { type: 'boolean', description: '批次结束后自动打开需人工页面（默认 true）' },
        manualLimit: { type: 'integer', minimum: 1, maximum: 16, description: '自动打开的标签页上限（默认 8）' },
      },
      additionalProperties: false,
    },
    async (m, a) => m.startJob({
      dois: strArr(a.dois, 'dois'),
      listText: str(a.listText, 'listText'),
      listPath: str(a.listPath, 'listPath'),
      outDir: str(a.outDir, 'outDir'),
      concurrency: int(a.concurrency, 'concurrency', { min: 1, max: 4, dflt: 2 }),
      retries: int(a.retries, 'retries', { min: 0, max: 3, dflt: 1 }),
      itemTimeoutMin: int(a.itemTimeoutMin, 'itemTimeoutMin', { min: 0, max: 120, dflt: 10 }),
      autoOpenManual: bool(a.autoOpenManual, 'autoOpenManual', true),
      manualLimit: int(a.manualLimit, 'manualLimit', { min: 1, max: 16, dflt: 8 }),
    }));

  // 3. zhu_dl_status
  def('zhu_dl_status',
    '查询下载批次进度/结果；支持长轮询（waitSeconds+sinceVersion，job 有变化立即返回）。返回计数、problems（失败+需人工）、manual.pending、captures、browserOpen 与 next 建议动作。',
    {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: '批次 ID（缺省=最近一个）' },
        waitSeconds: { type: 'number', minimum: 0, maximum: 45, description: '长轮询等待秒数（默认 0 不等待）' },
        sinceVersion: { type: 'number', minimum: 0, description: '上次看到的 version；job 版本未变化时等待' },
        includeItems: { type: 'string', enum: ['problems', 'all', 'none'], description: '条目明细档位（默认 problems=失败+需人工；all=全量；none=仅计数）' },
      },
      additionalProperties: false,
    },
    async (m, a) => m.status({
      jobId: str(a.jobId, 'jobId'),
      waitSeconds: int(a.waitSeconds, 'waitSeconds', { min: 0, max: 45, dflt: 0 }),
      sinceVersion: int(a.sinceVersion, 'sinceVersion', { min: 0, max: Number.MAX_SAFE_INTEGER, dflt: 0 }),
      includeItems: enumOf(a.includeItems, 'includeItems', ['problems', 'all', 'none'], 'problems'),
    }));

  // 4. zhu_dl_open_manual
  def('zhu_dl_open_manual',
    '在下载器专用持久 Edge 中逐篇打开需人工/可失败条目的文章页，供用户登录/过验证/点下载；用户点下的 PDF 自动捕获到 outDir。默认跳过"DOI未注册/不支持出版商"等打开也没用的条目。',
    {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: '批次 ID（缺省=最近一个）' },
        dois: { type: 'array', items: { type: 'string' }, description: '显式指定要打开的 DOI（覆盖默认选择，可含确定性失败条目）' },
        includeFailed: { type: 'boolean', description: '默认选择是否含 failed 条目（默认 true）' },
        includePermanent: { type: 'boolean', description: '默认选择是否含确定性失败（默认 false）' },
        limit: { type: 'integer', minimum: 1, maximum: 16, description: '本次打开的标签页上限（默认 8）' },
        cursor: { type: 'integer', minimum: 0, description: '分页起点（默认 0）' },
      },
      additionalProperties: false,
    },
    async (m, a) => m.openManual({
      jobId: str(a.jobId, 'jobId'),
      dois: strArr(a.dois, 'dois'),
      includeFailed: bool(a.includeFailed, 'includeFailed', true),
      includePermanent: bool(a.includePermanent, 'includePermanent', false),
      limit: int(a.limit, 'limit', { min: 1, max: 16, dflt: 8 }),
      cursor: int(a.cursor, 'cursor', { min: 0, max: 1e6, dflt: 0 }),
    }));

  // 5. zhu_dl_retry
  def('zhu_dl_retry',
    '用同一浏览器会话与 outDir 重跑某批次的 manual+failed 条目（产出新 jobId；已成功/PDF 已存在自动跳过）。运行中拒绝。',
    {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: '要重试的批次 ID（缺省=最近一个）' },
        dois: { type: 'array', items: { type: 'string' }, description: '显式指定重试的 DOI（覆盖默认列表）' },
        concurrency: { type: 'integer', minimum: 1, maximum: 4, description: '并发数（默认 2）' },
        retries: { type: 'integer', minimum: 0, maximum: 3, description: '单篇自动重试次数（默认 1）' },
      },
      additionalProperties: false,
    },
    async (m, a) => m.retry({
      jobId: str(a.jobId, 'jobId'),
      dois: strArr(a.dois, 'dois'),
      concurrency: int(a.concurrency, 'concurrency', { min: 1, max: 4, dflt: 2 }),
      retries: int(a.retries, 'retries', { min: 0, max: 3, dflt: 1 }),
    }));

  // 6. zhu_dl_collect
  def('zhu_dl_collect',
    '复查 outDir 并可选扫描外部目录（只扫一级 *.pdf，按文件名匹配 DOI），把用户手动下载的 PDF 校验后复制进 outDir 并翻成 ok。只复制不移动原文件；多命中列 ambiguous 不猜。',
    {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: '批次 ID（缺省=最近一个）' },
        scanDirs: { type: 'array', items: { type: 'string' }, description: '额外扫描的目录（绝对路径，只扫一级）' },
        adopt: { type: 'boolean', description: '是否把唯一命中的 PDF 复制进 outDir（默认 false 只报告）' },
      },
      additionalProperties: false,
    },
    async (m, a) => m.collect({
      jobId: str(a.jobId, 'jobId'),
      scanDirs: strArr(a.scanDirs, 'scanDirs') ?? [],
      adopt: bool(a.adopt, 'adopt', false),
    }));

  // 7. zhu_dl_stop
  def('zhu_dl_stop',
    '优雅停止运行中的批次：进行中的一篇跑完收场，不再领取新任务。',
    {
      type: 'object',
      properties: { jobId: { type: 'string', description: '批次 ID（缺省=最近一个）' } },
      additionalProperties: false,
    },
    async (m, a) => m.stop({ jobId: str(a.jobId, 'jobId') }));

  // 8. zhu_dl_close
  def('zhu_dl_close',
    '关闭下载器专用持久 Edge 并释放 profile（批次收尾必调）。批次运行中默认拒绝；force=true 先停批再关闭。',
    {
      type: 'object',
      properties: { force: { type: 'boolean', description: '批次运行中时先 stop 再关闭（默认 false 拒绝）' } },
      additionalProperties: false,
    },
    async (m, a) => m.close({ force: bool(a.force, 'force', false) }));
}
