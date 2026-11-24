#!/usr/bin/env node
// zhu-downloader stdio MCP server（零依赖协议壳）。
// 协议面照 zhu-cf-assist 的 cf-assist-server.mjs：换行分隔 JSON-RPC（不是 LSP Content-Length 帧），
// 只实现 initialize / ping / tools/list / tools/call。工具逻辑全部在 ./bridge.mjs。
//
// 手工冒烟（一行一请求；Git Bash 下执行）：
//   printf '%s\n' \
//     '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"manual","version":"0"}}}' \
//     '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
//     '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
//     '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"zhu_dl_guide","arguments":{}}}' \
//     | node mcp/zhu-dl-server.mjs
//
// 退出语义：stdin EOF / SIGINT / SIGTERM → 停止运行中的批次 → 5s 内尝试收浏览器窗口 →
// run.json 标 interrupted → exit 0（批次中断诊断见 outDir/_mcp_job.json）。
import { createInterface } from "node:readline";
import { registerTools, shutdownManager, serverInfo } from "./bridge.mjs";

const SERVER_INFO = serverInfo;

const tools = new Map();
registerTools(def => tools.set(def.name, def));

const TOOL_LIST = [...tools.values()].map(({ name, description, inputSchema }) => ({
  name, description, inputSchema,
}));

function writeMessage(message) {
  // One JSON-RPC message per line — what MCP stdio clients expect.
  process.stdout.write(JSON.stringify(message) + "\n");
}

function ok(id, result) {
  writeMessage({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
  writeMessage({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message },
  });
}

// 工具错误统一带错误码（契约：ERROR: <CODE>: <message>），agent 不必猜
function toolErrorText(err) {
  if (err?.code) return `ERROR: ${err.code}: ${err.message}`;
  return `ERROR: INTERNAL: ${err?.message || err}`;
}

async function handleRequest(msg) {
  const { id, method, params } = msg;

  // Notifications (no id) — ignore.
  if (id === undefined || id === null) return;

  switch (method) {
    case "initialize":
      ok(id, {
        protocolVersion: params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      return;
    case "ping":
      ok(id, {});
      return;
    case "tools/list":
      ok(id, { tools: TOOL_LIST });
      return;
    case "tools/call": {
      if (shuttingDown) {
        fail(id, -32000, "server 正在关闭(stdin已结束)，本次调用未执行；请重连后重试");
        return;
      }
      const name = params?.name;
      const tool = tools.get(name);
      if (!tool) {
        // 统一走 tool-result isError（与其它工具错误同一形态，agent 读文本即可），不发 JSON-RPC error
        ok(id, {
          content: [{ type: "text", text: `ERROR: INVALID_ARGS: Unknown tool: ${name}；可用 zhu_dl_guide 查看工具清单` }],
          isError: true,
        });
        return;
      }
      trackInFlight((async () => {
        try {
          const text = await tool.execute(params?.arguments || {});
          ok(id, { content: [{ type: "text", text: String(text) }], isError: false });
        } catch (err) {
          ok(id, {
            content: [{ type: "text", text: toolErrorText(err) }],
            isError: true,
          });
        }
      })());
      return;
    }
    default:
      fail(id, -32601, `Method not found: ${method}`);
  }
}

const rl = createInterface({ input: process.stdin });

// 优雅退出：stdin EOF 不立即 exit(0)——先给在途调用 5s grace，再走 shutdownManager
// （停批 → 限时收窗 → run.json 标 interrupted）。下载会话的收尾诊断落在 outDir/_mcp_job.json。
let shuttingDown = false;
let exiting = false;
const inFlight = new Set();

function trackInFlight(p) {
  inFlight.add(p);
  p.then(() => inFlight.delete(p), () => inFlight.delete(p));
}

function exitNow(code) {
  if (exiting) return;
  exiting = true;
  process.exit(code);
}

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const msg = JSON.parse(trimmed);
    if (Array.isArray(msg)) {
      for (const item of msg) handleRequest(item);
    } else {
      handleRequest(msg);
    }
  } catch (err) {
    process.stderr.write(`[zhu-downloader] bad JSON: ${err}\n`);
  }
});

rl.on("close", () => {
  shuttingDown = true;
  // grace 须覆盖 shutdownManager 的预算（等收尾落定 4s + 收窗 1.5s ≈ 5.5s）：grace 太短会
  // 在 finishJob 写 _mcp_job.json 之前杀掉进程（s7 实测教训）
  const grace = setTimeout(() => exitNow(0), 6500);
  Promise.allSettled([...inFlight]).then(async () => {
    try { await shutdownManager(); } catch { /* 退出路径尽力而为 */ }
    clearTimeout(grace);
    exitNow(0);
  });
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    shuttingDown = true;
    shutdownManager().then(() => exitNow(signal === "SIGINT" ? 130 : 143), () => exitNow(1));
  });
}

process.stderr.write("[zhu-downloader] stdio MCP server ready\n");
