# MCP 服务使用指南（agent 自动化下载）

ZhuDownLoader 可以作为一个 **MCP 服务**暴露给 ZCode / Claude Desktop 等 agent 客户端：agent 提交
DOI 清单拿到 `jobId` 异步执行、长轮询进度；批次结束后在**下载器专用持久 Edge** 里逐篇打开需人工
条目，用户点下的 PDF 自动捕获到输出目录；随后同一浏览器会话重试剩余条目，最后收窗释放 profile。

> 本仓（ZhuDownloader-MCP）是 ZhuDownLoader 的 **MCP 形态独立发行版**，自包含可运行。网页版、
> 拖拽、命令行等其他用法见主仓 [ZhuDownLoader](https://github.com/lunarlakezhu/ZhuDownLoader)。

> 全程不新增任何验证码破解——只复用下载器既有的"Turnstile 勾选框有界自动点一次"；图选/OTP/滑块
> 一律人工处理。不绕过付费墙与任何权限。

## 怎么开始

安装 `zhu-downloader-zcode` 插件（或手工配置，见下），环境安装见仓库根 README「快速开始」。

## 架构

```
ZCode agent
  │  MCP stdio（换行 JSON-RPC）
  ▼
mcp/zhu-dl-server.mjs        零依赖协议壳
  ▼
mcp/bridge.mjs               8 工具声明 + 参数校验 + 统一错误文本
  ▼
mcp/jobs.mjs                 JobManager：单批次、长轮询、重试、收集、跨重启恢复
  ├─ webui/batch.mjs BatchRunner    并发/重试/已存在跳过/failed.txt/_download_progress.json
  │    └─ lib/downloader.mjs        24 条出版商策略
  └─ lib/manual-handoff.mjs         打开文章页 + 捕获用户下载 → <outDir>/<DOI>.pdf
```

进程内执行（不 fork）：浏览器 context 与 job 同生命周期，人工接管与"同会话重试"零 IPC。
代价：**MCP 宿主（客户端）退出会中断运行中的批次**——`outDir/_mcp_job.json` 标 `interrupted`，
重启后 `zhu_dl_status` 可见、`zhu_dl_retry` 续跑（已存在的自动跳过）。

## 8 个工具

| 工具 | 作用 |
|---|---|
| `zhu_dl_guide` | agent 操作规程与安全边界（开始任何下载任务前先调用） |
| `zhu_dl_download` | 提交 DOI（`dois`/`listText`/`listPath` 三选一）立即返回 `{jobId, state:"running", total, outDir, progressFile}` |
| `zhu_dl_status` | 计数 + problems（失败/需人工）+ `manual.pending` + `captures` + `browserOpen` + `next` 建议；`waitSeconds≤45` 长轮询，`sinceVersion` 变化即回 |
| `zhu_dl_open_manual` | 在持久 Edge 中逐篇打开需人工条目（默认跳过"DOI未注册/不支持出版商"），`limit/cursor` 分页；开启下载捕获 |
| `zhu_dl_retry` | 重跑某批次的 manual+failed（新 jobId；已成功/PDF 已存在自动跳过；复用同一浏览器会话） |
| `zhu_dl_collect` | 复查 outDir + 可选扫描外部目录（只扫一级 `*.pdf`、按文件名匹配 DOI），校验后**复制**进 outDir（不动原文件；多命中列 ambiguous 不猜） |
| `zhu_dl_stop` | 优雅停止：进行中的一篇跑完收场，不再领取新任务 |
| `zhu_dl_close` | 关闭持久 Edge 释放 profile；运行中默认拒绝，`force=true` 先停再关 |

错误文本统一 `ERROR: <CODE>: <message>`：`BUSY / NO_JOB / INVALID_ARGS / BROWSER_BUSY /
DEPENDENCY_MISSING / BATCH_FAILED`，message 含可执行的下一步。

## 配置

### ZCode（推荐：插件）

安装本仓 `plugins/zhu-downloader-zcode` 插件即可。launcher 不需要额外配置：未设
`ZHU_DOWNLOADER_HOME` 时会自动探测本仓根（兜底 `D:\ZhuDownLoader` 主安装）。在 ZCode 插件详情页
刷新/更新后，会话里可见 8 个 `zhu_dl_*` 工具。

### Claude Desktop / 其他客户端

把 `<仓库根>` 换成你克隆本仓的绝对路径：

```json
{
  "mcpServers": {
    "zhu-downloader": {
      "type": "stdio",
      "command": "node",
      "args": ["<仓库根>\\mcp\\zhu-dl-server.mjs"],
      "env": { "ZHU_DOWNLOADER_HOME": "<仓库根>" },
      "timeoutMs": 60000
    }
  }
}
```

### 环境变量

| 变量 | 作用 | 默认 |
|---|---|---|
| `ZHU_DOWNLOADER_HOME` | 仓库根目录（插件 launcher 定位服务端用） | 未设时自动探测本仓根 |
| `ZHU_DL_DEFAULT_OUT` | 默认输出目录 | `~/Downloads/ZhuDownLoader` |
| `ZHU_DL_MCP_STATE_DIR` | 跨重启恢复状态目录（`last-job.json`） | 仓内 `.mcp-state/` |

## agent 使用规程（摘要）

```
zhu_dl_guide（首次必读）
→ zhu_dl_download { dois:[...], outDir:"<绝对路径>" }
→ zhu_dl_status { waitSeconds:20, sinceVersion:<version> }   # 长轮询至 finished
→ 全部成功 → zhu_dl_close
→ 有 manual.pending → 告知用户在已打开的标签页登录/过验证/点 Download PDF
   → zhu_dl_status 观察 captures（用户点下的 PDF 自动落盘并翻成 ok）
   → 用户说处理完 → zhu_dl_retry（剩余问题）或 zhu_dl_collect { scanDirs:[...], adopt:true }
→ zhu_dl_close 收尾
```

## 下载到哪里（outDir）

- 默认 `~/Downloads/ZhuDownLoader`；可用环境变量 `ZHU_DL_DEFAULT_OUT` 改默认，或在每次
  `zhu_dl_download` 传 `outDir`（绝对路径，支持嵌套新建，如 `D:\\Papers\\2026`）。
- agent 规程：用户没说存哪里就先确认一句，或明确告知将用默认目录；批次结束汇报时**重申最终
  目录与成功篇数**。
- 服务端护栏（直接拒绝，`ERROR: INVALID_ARGS` 并附建议）：ZhuDownLoader 安装/开发目录（含
  mcp/、lib/、.browser-profile 等全部子目录）、Windows 系统目录（C:\Windows、Program Files）、
  驱动器根（C:\、D:\）、用户主目录根（C:\Users\<你>）。
- 同一 outDir 重复发起：已存在的 PDF 秒级跳过（%PDF- 校验），重跑零成本；`failed.txt` 与
  `_mcp_job.json` 等批次产物都在该目录。

## profile 独占（重要）

MCP 与网页版/CLI **不能并行**跑同一 `.browser-profile`。发起批次前服务会预检 profile：被占用时
返回 `ERROR: BROWSER_BUSY`（并给出 profile 路径）。处理：

1. 关闭网页版（`网页版下载.bat` 的窗口）与其他下载器实例；
2. 手动关闭残留的下载器 Edge 窗口（窗口标题与下载器一致的那台 Edge）；
3. 重试 `zhu_dl_download`。

## 下载捕获的边界

- 只捕获浏览器**下载事件**（用户点 Download PDF / `<a download>` 触发的下载）；
- `Ctrl+S`、打印成 PDF **不会**触发捕获——这类文件放好后用 `zhu_dl_collect { scanDirs, adopt:true }` 归档；
- 捕获只认 PDF 头：登录页/错误页 HTML 当场删除并记 `not-pdf`，绝不留假 PDF；
- 人工捕获成功 → `download.log` 记"成功(人工)"、条目翻 `ok`、`status.captures` 出现该 DOI。

## 常见故障

| 现象 | 原因与处理 |
|---|---|
| `ERROR: DEPENDENCY_MISSING` | playwright 未装：在 ZhuDownLoader 目录执行 `npm ci && npx playwright install chromium`，或双击 `一键安装环境.bat`，重启 MCP 服务 |
| `ERROR: BROWSER_BUSY: 持久浏览器 profile 被占用` | 见上节 profile 独占 |
| 批次结束没弹窗口 | `autoOpenManual:false` 关了；或问题条目全是"DOI未注册/不支持出版商"这类打开也没用的——用 `zhu_dl_open_manual {dois:[...]}` 显式强制 |
| 用户点下载没捕获 | 见上节捕获边界（Ctrl+S 不触发）；或文件落进了别的下载目录 |
| 客户端关闭后批次中断 | 进程内设计预期行为：`_mcp_job.json` 标 interrupted；重连后 `zhu_dl_status` → `zhu_dl_retry` 续跑；残留 Edge 手动关 |
| 单篇卡住拖批 | 默认 10 分钟单篇看门狗按确定性失败收场（reason=`单篇超时`），批次继续；FlareSolverr 慢路径把 `itemTimeoutMin` 调大（0=关闭） |
| SAGE 条目 | 沿用镜像路线（sage.cnpereading.com 文章页），不会打开官网黑洞地址 |

## 测试与开发

```bash
node test_mcp_jobs.mjs        # JobManager 离线 11 场景（注入假 runner/浏览器，不联网）
node test_mcp_protocol.mjs    # stdio 协议面 8 组断言（spawn 真服务）
node test_mcp_manual_e2e.mjs  # 人工接管捕获 e2e（真 Edge + 本机 HTTP，4 用例）
node test_batch.mjs           # BatchRunner 编排 7 场景（含看门狗/permanent/closeBrowserOnFinish）
```

更多实现细节见 `mcp/README.md`；架构与文件地图见主仓 wiki
（[架构与文件地图](https://github.com/lunarlakezhu/ZhuDownLoader/wiki/%E6%9E%B6%E6%9E%84%E4%B8%8E%E6%96%87%E4%BB%B6%E5%9C%B0%E5%9B%BE)）。
