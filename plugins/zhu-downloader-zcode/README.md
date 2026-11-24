# zhu-downloader-zcode（ZhuDownLoader MCP 插件）

ZCode 插件：把 ZhuDownLoader 封装为 stdio MCP 服务，让 agent 能提交 DOI 异步批量下载、长轮询
进度、在下载器专用 Edge 里人工接管、自动捕获用户点下的 PDF、同会话重试并收窗。

## 组件

| 文件 | 作用 |
|---|---|
| `.zcode-plugin/plugin.json` | 插件清单（skills + mcpServers），版本 0.1.0 |
| `.mcp.json` | MCP 服务声明：`node ${ZCODE_PLUGIN_ROOT}/mcp/launcher.mjs`，`timeoutMs: 60000` |
| `mcp/launcher.mjs` | 薄启动器：定位服务端（`ZHU_DOWNLOADER_HOME` 显式指定 → 本仓根自动探测 → `D:\ZhuDownLoader` 主安装兜底），动态 import。**服务源码不进插件目录**，避免两处版本漂移 |
| `skills/zhu-download/SKILL.md` | agent 规程（发起→长轮询→人工接管→retry/collect→close）与安全边界 |

## 服务端（位于本仓 `mcp/`）

- `mcp/zhu-dl-server.mjs` — stdio 协议壳（initialize/ping/tools/list/tools/call，EOF 5s grace）
- `mcp/bridge.mjs` — 8 工具声明 + 参数校验
- `mcp/jobs.mjs` — JobManager（单批次、长轮询、重试、收集、跨重启恢复）
- `lib/manual-handoff.mjs` — 人工打开文章页 + 下载捕获

工具表、配置示例、故障排查见本仓 `mcp/README.md` 与 `wiki/MCP服务使用指南.md`。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `ZHU_DOWNLOADER_HOME` | 未设时 launcher 自动探测本仓根（兜底 `D:\ZhuDownLoader`） | 仓库根目录（launcher 定位服务端） |
| `ZHU_DL_DEFAULT_OUT` | `~/Downloads/ZhuDownLoader` | 默认输出目录（可选） |
| `ZHU_DL_MCP_STATE_DIR` | 本仓 `.mcp-state/` | 跨重启恢复状态目录（可选） |

## 测试

```bash
# 插件 launcher 链路：initialize + tools/list 应看到 8 个 zhu_dl_* 工具
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node mcp/launcher.mjs

# 服务端离线测试（本仓根目录）
node test_mcp_jobs.mjs && node test_mcp_protocol.mjs && node test_mcp_manual_e2e.mjs
```

## 版本对齐提醒（cf-assist 的头号故障）

`plugin.json` / `marketplace.json` / 目录名三处版本必须一致（当前 0.1.0）；改插件后须在 ZCode
插件详情页刷新/更新才生效。
