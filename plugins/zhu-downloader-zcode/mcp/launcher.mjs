// zhu-downloader MCP launcher：插件自包含、服务源码不进插件目录（避免版本漂移）。
// 定位服务端顺序：ZHU_DOWNLOADER_HOME（显式指定）→ 仓库根自动探测（本插件目录向上两级，
// 覆盖「克隆本仓直跑」场景）→ D:\ZhuDownLoader（本机主安装兜底）。失败时给出可读诊断——
// MCP 崩溃日志里能直接看到原因。
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const launcherDir = dirname(fileURLToPath(import.meta.url)); // <插件>/mcp
const candidates = [];
if (process.env.ZHU_DOWNLOADER_HOME) candidates.push(process.env.ZHU_DOWNLOADER_HOME);
candidates.push(join(launcherDir, "..", "..")); // 仓库根（plugins/zhu-downloader-zcode/mcp → 仓根）
candidates.push("D:\\ZhuDownLoader"); // ZhuDownLoader 主安装目录兜底

let loaded = false;
const errors = [];
for (const home of candidates) {
  const entry = join(home, "mcp", "zhu-dl-server.mjs");
  if (!existsSync(entry)) {
    errors.push(`- ${home}：没有 mcp/zhu-dl-server.mjs`);
    continue;
  }
  try {
    await import(pathToFileURL(entry).href);
    loaded = true;
    break;
  } catch (e) {
    errors.push(`- ${home}：加载失败 ${e?.message || e}`);
  }
}
if (!loaded) {
  process.stderr.write(
    `[zhu-downloader] 找不到可加载的 zhu-dl-server.mjs。尝试过的位置：\n${errors.join("\n")}\n` +
    `[zhu-downloader] 请把环境变量 ZHU_DOWNLOADER_HOME 指向 ZhuDownloader-MCP 克隆目录；` +
    `依赖缺失时在该目录执行 npm ci && npx playwright install chromium，或双击 一键安装环境.bat\n`,
  );
  process.exit(1);
}
