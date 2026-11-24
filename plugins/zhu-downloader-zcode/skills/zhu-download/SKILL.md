---
name: zhu-download
description: 用 ZhuDownLoader MCP 为用户批量下载论文 PDF。当用户要求下载文献/论文 PDF、给了一批 DOI、或抱怨某篇下不下来需要人工处理时使用。含 发起→长轮询→人工接管→重试→收尾 完整规程与安全边界。
---

# ZhuDownLoader 文献下载（MCP）

用 `zhu-downloader` 服务（工具 `zhu_dl_guide / download / status / open_manual / retry / collect / stop / close`）
为用户下载论文 PDF。**先调一次 `zhu_dl_guide` 读规程**，再按下面流程操作。

## 规程

1. **发起**：`zhu_dl_download`，参数 `dois` 数组（或 `listText`/`listPath`），`outDir` 用绝对路径。
   - **下载到哪里（先想清楚再发起）**：用户没说存哪里就先问一句，或明确告知将用默认
     `~/Downloads/ZhuDownLoader`；不要自作主张选目录。批次结束汇报时必须重申最终 outDir
     与成功篇数，让用户知道 PDF 落在哪。
   - 服务端护栏会直接拒绝：ZhuDownLoader 安装/开发目录、Windows 系统目录（C:\Windows、
     Program Files）、驱动器根（C:\、D:\）、用户主目录根——报 `ERROR: INVALID_ARGS`，按提示换目录。
   立即返回 `{jobId, state:"running", total}`，**不要阻塞等待**。批次结束后会自动在下载器专用
   Edge 打开需人工条目（默认 ≤8 个标签）——打开多个标签前先告知用户会弹几个窗口。
2. **长轮询**：反复 `zhu_dl_status { jobId, waitSeconds: 20, sinceVersion: <上次 version> }`：
   - `changed:true` / state 变化 → 向用户简报 `counts` 进展；
   - state=`finished` → 进入第 3 步。
3. **收尾分流**（state=finished）：
   - 全部 ok → 向用户汇报并调 `zhu_dl_close` 收窗。
   - 有 `manual.pending` → 告诉用户"已在浏览器打开 N 个标签页，请逐个登录/过验证/点 Download PDF"；
     用户操作期间继续用 `zhu_dl_status` 观察 `captures`（点下的 PDF 自动落盘为 `<outDir>/<DOI>.pdf`
     并翻成 ok）。
   - 用户说处理完了 → `zhu_dl_retry { jobId }` 重跑剩余问题（新 jobId；已成功的自动跳过），
     回到第 2 步轮询新 jobId。
   - 用户自己在别处下载了文件（如 Ctrl+S / 另存）→ `zhu_dl_collect { jobId, scanDirs:["外部目录"], adopt:true }`
     归档（只复制不动原文件；多命中列 ambiguous 时让用户改名后重扫，**绝不猜**）。
4. **问题条目太多**：`open_manual` 返回 `remaining>0` 时，告知用户后用 `cursor` 分批打开余下条目。
5. **结束必调** `zhu_dl_close` 释放浏览器 profile；批次运行中要中止用 `zhu_dl_stop`。

## 安全边界（必须遵守）

- 绝不自动操作图选/OTP/滑块验证码；仅复用下载器既有的"Turnstile 勾选框有界自动点一次"。
- 发起前确认用户没有在跑网页版/CLI（会报 `BROWSER_BUSY`：关掉对方再重试，不要硬闯）。
- 所有错误文本形如 `ERROR: <CODE>: <message>`，message 里有下一步；照做，不要盲试。
- MCP 宿主退出会中断批次（`_mcp_job.json` 标 interrupted）；重连后 `zhu_dl_status` 查看并用
  `zhu_dl_retry` 续跑。
- 汇报成功数只认 `captures`/`counts.ok` 与实际落盘 PDF；"点过一次"不等于"下载成功"。
