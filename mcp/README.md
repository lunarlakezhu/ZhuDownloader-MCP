# ZhuDownLoader MCP 服务（zhu-downloader）

把 ZhuDownLoader 的批量下载能力封装成 stdio MCP 服务：agent 提交 DOI 拿到 jobId 异步执行、
长轮询进度、批次结束后在**下载器专用持久 Edge** 里逐篇打开需人工条目，用户点下的 PDF 自动
捕获落盘，然后同一会话重试，最后收窗释放 profile。全程不新增任何验证码破解，只复用既有的
"Turnstile 勾选框有界自动点一次"策略。

## 架构

```
ZCode / Claude Desktop 等 MCP 客户端
  │  stdio（换行 JSON-RPC，单次调用 <60s）
  ▼
mcp/zhu-dl-server.mjs   零依赖协议壳（initialize/ping/tools/list/tools/call + EOF 5s grace）
  ▼
mcp/bridge.mjs          8 工具声明 + 参数类型/范围校验 + 统一错误文本
  ▼
mcp/jobs.mjs            JobManager：单批次、长轮询、重试、收集、跨重启恢复
  ├─ webui/batch.mjs BatchRunner   并发/重试/已存在跳过/failed.txt/_download_progress.json
  │    └─ lib/downloader.mjs       24 条出版商策略
  └─ lib/manual-handoff.mjs        打开文章页 + 捕获用户下载 → <outDir>/<DOI>.pdf
```

关键决定：**进程内执行**（不 fork 子进程、不复用 webui HTTP）。浏览器 context 与 job 同生命周期，
人工接管与"同会话重试"零 IPC。代价：MCP 宿主（客户端）退出会中断运行中的批次——
`outDir/_mcp_job.json` 会标 `interrupted`，重启后 `zhu_dl_status` 可见、`zhu_dl_retry` 续跑。

## 工具一览（8 个）

| 工具 | 作用 |
|---|---|
| `zhu_dl_guide` | agent 操作规程（download→status 长轮询→人工接管→retry/collect→close）与安全边界 |
| `zhu_dl_download` | 提交 DOI（dois/listText/listPath 三选一）立即返回 `{jobId,state:"running",total,outDir}`，不阻塞 |
| `zhu_dl_status` | 计数 + problems（失败/需人工）+ manual.pending + captures + browserOpen + next 建议；`waitSeconds≤45` 长轮询，`sinceVersion` 变化即回 |
| `zhu_dl_open_manual` | 在持久 Edge 中逐篇打开需人工条目（默认跳过"DOI未注册/不支持出版商"），`limit/cursor` 分页；开启下载捕获 |
| `zhu_dl_retry` | 重跑某批次的 manual+failed（新 jobId；已成功/已存在自动跳过；复用同一浏览器会话） |
| `zhu_dl_collect` | 复查 outDir + 可选扫描外部目录，把用户手动下载的 PDF 校验后**复制**进 outDir（不动原文件，多命中列 ambiguous） |
| `zhu_dl_stop` | 优雅停止：进行中的一篇跑完收场，不再领取新任务 |
| `zhu_dl_close` | 关闭持久 Edge 释放 profile；运行中默认拒绝，`force=true` 先停再关 |

错误文本统一 `ERROR: <CODE>: <message>`，CODE ∈ `BUSY / NO_JOB / INVALID_ARGS / BROWSER_BUSY /
DEPENDENCY_MISSING / BATCH_FAILED`，message 含可执行的下一步。

## 配置（ZCode 插件）

推荐直接安装本仓 `plugins/zhu-downloader-zcode` 插件（`.mcp.json` 已内置 launcher）。手工配置等效形态：

```json
{
  "mcpServers": {
    "zhu-downloader": {
      "type": "stdio",
      "command": "node",
      "args": ["<ZhuDownLoader 根目录>/mcp/zhu-dl-server.mjs"],
      "env": { "ZHU_DOWNLOADER_HOME": "<ZhuDownLoader 根目录>" },
      "timeoutMs": 60000
    }
  }
}
```

环境变量：

| 变量 | 作用 | 默认 |
|---|---|---|
| `ZHU_DOWNLOADER_HOME` | 仓库根目录（launcher 定位服务用） | 未设时 launcher 自动探测本仓根（兜底 `D:\ZhuDownLoader`） |
| `ZHU_DL_DEFAULT_OUT` | 默认输出目录 | `~/Downloads/ZhuDownLoader` |
| `ZHU_DL_MCP_STATE_DIR` | `last-job.json` 状态目录 | 仓内 `.mcp-state/` |

Claude Desktop：用上面的 JSON 放进 `claude_desktop_config.json`（把 launcher 换成
`node <home>/mcp/zhu-dl-server.mjs`）。

## agent 使用规程（摘要）

```
zhu_dl_guide（首次必读）
→ zhu_dl_download { dois:[...], outDir:"<绝对路径>" }
→ zhu_dl_status { waitSeconds:20, sinceVersion:<version> }   # 长轮询至 finished
→ 全部成功 → zhu_dl_close
→ 有 manual.pending → 告知用户在已打开的标签页登录/点下载
   → zhu_dl_status 观察 captures（用户点下的 PDF 自动落盘并翻成 ok）
   → 用户说处理完 → zhu_dl_retry（剩余问题）或 zhu_dl_collect { scanDirs:[...], adopt:true }
→ zhu_dl_close 收尾
```

## 常见故障

| 现象 | 原因与处理 |
|---|---|
| `ERROR: DEPENDENCY_MISSING` | node_modules/playwright 未装：在 ZhuDownLoader 目录执行 `npm ci && npx playwright install chromium`，或双击 `一键安装环境.bat`，然后重启 MCP 服务 |
| `ERROR: BROWSER_BUSY: 持久浏览器 profile 被占用` | 网页版/CLI/残留 Edge 正占着 `.browser-profile`：关闭网页版（`网页版下载.bat` 的窗口）与其他下载器实例；残留窗口手动关掉后重试 |
| 批次结束没弹窗口 | `autoOpenManual:false` 关了自动打开；或问题条目全是"DOI未注册/不支持出版商"这类打开也没用的（用 `zhu_dl_open_manual {dois:[...]}` 显式强制） |
| 用户点下载但没捕获 | 只捕获浏览器"下载"事件：`Ctrl+S` / 打印成 PDF 不触发；把文件放好后用 `zhu_dl_collect { adopt:true }` 归档 |
| MCP 客户端关闭后批次没了 | 进程内设计的预期行为：`_mcp_job.json` 已标 `interrupted`，重启后 `zhu_dl_status` 可见，`zhu_dl_retry` 续跑（已存在的自动跳过）；残留 Edge 窗口需手动关闭 |
| 单篇卡住拖批 | 默认 10 分钟单篇看门狗会把挂起条目按确定性失败收场（reason=`单篇超时`），批次继续走完 |
| 想用 FlareSolverr 慢路径 | `itemTimeoutMin` 调大（如 30）；0=关闭看门狗 |

## 测试

```bash
node test_mcp_jobs.mjs        # JobManager 离线 11 场景（注入假 runner/浏览器，不联网）
node test_mcp_protocol.mjs    # stdio 协议面 8 组断言（spawn 真服务）
node test_mcp_manual_e2e.mjs  # 人工接管捕获 e2e（真 Edge + 本机 HTTP，4 用例）
node test_batch.mjs           # BatchRunner 编排 7 场景（含看门狗/permanent/closeBrowserOnFinish）
```

## 限制与边界

- **下载到哪里**：outDir 默认 `~/Downloads/ZhuDownLoader`（`ZHU_DL_DEFAULT_OUT` 可改）；服务端护栏
  直接拒绝 ZhuDownLoader 安装/开发目录、Windows 系统目录、驱动器根、用户主目录根（`INVALID_ARGS`
  并附建议）。agent 应与用户确认或明确告知最终位置，汇报时重申 outDir。
- profile 独占：MCP 与网页版/CLI 不能并行跑同一 profile；批次内串行领任务。
- 只捕获浏览器下载事件；跨浏览器手动保存的文件走 `collect`。
- 状态展示 URL 已去查询串（脱敏）；打开页面用完整 URL；cookie/token 不写入日志。
- SAGE 沿用镜像路线 resolveUrl（cnpereading），不会打开官网黑洞地址。
