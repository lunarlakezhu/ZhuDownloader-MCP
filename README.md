# ZhuDownloader-MCP

ZhuDownLoader 的 **MCP 形态**独立发行仓：把批量文献下载能力封装成 stdio MCP 服务（8 个 `zhu_dl_*` 工具），
让 ZCode / Claude Desktop 等 agent 直接替用户跑 DOI 批量下载——提交清单拿 `jobId` 异步执行、长轮询
进度；批次结束后需人工的条目自动在**下载器专用持久 Edge** 里逐篇打开，用户点下的 PDF 自动捕获落盘，
然后同一浏览器会话重试剩余条目，最后收窗释放 profile。

> 全程不新增任何验证码破解——只复用下载器既有的「Turnstile 勾选框有界自动点一次」；图选/OTP/滑块
> 一律人工处理。不绕过付费墙与任何权限；订阅/机构权限需用户自备。

主项目（CLI / 网页版 / 完整 wiki 文档 / Release 安装包）：[ZhuDownLoader](https://github.com/lunarlakezhu/ZhuDownLoader)

## 能做什么

| 工具 | 作用 |
|---|---|
| `zhu_dl_guide` | agent 操作规程与安全边界（开始任何下载任务前先调用） |
| `zhu_dl_download` | 提交 DOI（`dois`/`listText`/`listPath` 三选一）立即返回 `{jobId, state:"running", total, outDir}` |
| `zhu_dl_status` | 计数 + 失败/需人工明细 + 捕获结果；`waitSeconds≤45` 长轮询，`sinceVersion` 变化即回 |
| `zhu_dl_open_manual` | 在持久 Edge 中逐篇打开需人工条目，`limit/cursor` 分页；开启下载捕获 |
| `zhu_dl_retry` | 重跑某批次的 manual+failed（已成功/PDF 已存在自动跳过；复用同一浏览器会话） |
| `zhu_dl_collect` | 复查 outDir + 可选扫描外部目录，把用户手动下载的 PDF 校验后复制进 outDir |
| `zhu_dl_stop` | 优雅停止：进行中的一篇跑完收场，不再领取新任务 |
| `zhu_dl_close` | 关闭持久 Edge 释放 profile；运行中默认拒绝，`force=true` 先停再关 |

设计要点：**进程内执行**（浏览器 context 与 job 同生命周期，人工接管与同会话重试零 IPC）；跨重启
可恢复（`outDir/_mcp_job.json` 标记 `interrupted`，重启后 `zhu_dl_status` 可见、`zhu_dl_retry` 续跑）；
单篇 10 分钟看门狗防拖批；outDir 护栏拒绝系统目录/驱动器根/主目录根。

## 快速开始（3 步）

### 1. 装环境（只需一次）

```bash
git clone https://github.com/lunarlakezhu/ZhuDownloader-MCP.git
cd ZhuDownloader-MCP
npm install
npx playwright install chromium   # 约 150MB 浏览器内核
```

Windows 可双击 `一键安装环境.bat`（macOS 用 `一键安装环境.command`）代替上面后两步。
前置要求：Node.js（LTS）。

### 2. 配置 MCP 客户端

**ZCode（推荐）**：把本仓 `plugins/zhu-downloader-zcode` 作为本地插件安装，然后把 `.mcp.json` 里的
`ZHU_DOWNLOADER_HOME` 改成你克隆本仓的绝对路径（launcher 也支持不设该变量、自动探测仓库根）。

**Claude Desktop / 其他 stdio 客户端**：把下面 JSON 放进对应配置文件：

```json
{
  "mcpServers": {
    "zhu-downloader": {
      "type": "stdio",
      "command": "node",
      "args": ["<ZhuDownloader-MCP 克隆目录>\\mcp\\zhu-dl-server.mjs"],
      "env": { "ZHU_DOWNLOADER_HOME": "<ZhuDownloader-MCP 克隆目录>" },
      "timeoutMs": 60000
    }
  }
}
```

配置好后，会话里应能看到 8 个 `zhu_dl_*` 工具。

### 3. 让 agent 干活

agent 侧规程（已内置在 `zhu_dl_guide` 与 `plugins/zhu-downloader-zcode/skills` 里）：

```
zhu_dl_guide（首次必读）
→ zhu_dl_download { dois:[...], outDir:"<绝对路径>" }
→ zhu_dl_status { waitSeconds:20, sinceVersion:<version> }   # 长轮询至 finished
→ 全部成功 → zhu_dl_close
→ 有 manual.pending → agent 提示你在已打开的标签页登录/过验证/点 Download PDF
   （点下的 PDF 自动落盘并翻成 ok）
→ 用户说处理完 → zhu_dl_retry（剩余问题）或 zhu_dl_collect { scanDirs:[...], adopt:true }
→ zhu_dl_close 收尾
```

## 环境变量

| 变量 | 作用 | 默认 |
|---|---|---|
| `ZHU_DOWNLOADER_HOME` | 仓库根目录（插件 launcher 定位服务端用） | 未设时 launcher 自动探测仓库根 |
| `ZHU_DL_DEFAULT_OUT` | 默认输出目录 | `~/Downloads/ZhuDownLoader` |
| `ZHU_DL_MCP_STATE_DIR` | 跨重启恢复状态目录（`last-job.json`） | 仓内 `.mcp-state/` |

## 仓库结构

```
mcp/                       MCP 服务（协议壳 / 8 工具桥 / JobManager）+ 详细 README
webui/batch.mjs            BatchRunner：并发、重试、已存在跳过、failed.txt、进度文件
lib/                       下载核心：DOI 解析、24 条出版商策略、人工接管捕获、CF 辅助、进度
plugins/zhu-downloader-zcode/   ZCode 插件（launcher + agent skill + .mcp.json）
wiki/MCP服务使用指南.md     用户视角使用指南
test_mcp_*.mjs, test_batch.mjs   测试（见下）
一键安装环境.bat/.command   Windows / macOS 一键装依赖 + Chromium 内核
```

## 测试

```bash
node test_mcp_jobs.mjs        # JobManager 离线 11 场景（注入假 runner/浏览器，不联网）
node test_mcp_protocol.mjs    # stdio 协议面 8 组断言（spawn 真服务）
node test_batch.mjs           # BatchRunner 编排 7 场景（含看门狗/permanent/closeBrowserOnFinish）
node test_mcp_manual_e2e.mjs  # 人工接管捕获 e2e（真 Edge + 本机 HTTP，4 用例）
```

## 与主仓的关系

- **本仓** = MCP 服务 + 下载核心（`lib/`）+ ZCode 插件，自包含、克隆即可跑 MCP 用法。
- **主仓 [ZhuDownLoader](https://github.com/lunarlakezhu/ZhuDownLoader)** = 完整产品：CLI
  （`batch_download.mjs`）、网页版、安装脚本、全量 wiki（出版商支持矩阵 / FAQ / 架构文件地图）与
  Release 安装包。MCP 的能力来自同一份下载核心，出版商支持范围一致。

## 限制与边界（摘要）

- profile 独占：MCP 与网页版/CLI/其他实例不能并行跑同一 `.browser-profile`（冲突时报
  `ERROR: BROWSER_BUSY` 并附处理步骤）。
- 只捕获浏览器**下载事件**；`Ctrl+S`/打印成 PDF 不触发，这类文件用 `zhu_dl_collect` 归档。
- 捕获只认 PDF 头，登录页/错误页 HTML 当场删除，绝不留假 PDF。
- MCP 宿主（客户端）退出会中断运行中的批次：属进程内设计预期行为，重启后可续跑。
- 更多见 [mcp/README.md](mcp/README.md) 与 [wiki/MCP服务使用指南.md](wiki/MCP服务使用指南.md)。

## 合规声明

本工具只自动化用户**已有权限**的文献获取流程：不破解验证码（谜题/OTP/滑块全部人工）、不绕过
付费墙、不批量抓取。请在出版商订阅条款允许的范围内使用。
