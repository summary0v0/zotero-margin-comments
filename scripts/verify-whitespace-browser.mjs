import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const pnpmStore = path.join(root, "node_modules/.pnpm");
const esbuildPackage = fs.readdirSync(pnpmStore).find((name) => name.startsWith("esbuild@"));
const { build } = require(path.join(pnpmStore, esbuildPackage, "node_modules/esbuild"));
const pdfPath = process.argv[2];
if (!pdfPath || !fs.existsSync(pdfPath)) throw new Error("Usage: node scripts/verify-whitespace-browser.mjs <PLLaVA PDF path>");
const out = path.join(root, "build", "whitespace-browser-qa");
fs.mkdirSync(out, { recursive: true });
await build({ entryPoints: [path.join(root, "bench/whitespace-browser.ts")], bundle: true, platform: "browser", target: "chrome140", outfile: path.join(out, "harness.js") });
const pdfDist = fs.readdirSync(path.join(root, "node_modules/.pnpm")).find((name) => name.startsWith("pdfjs-dist@"));
if (!pdfDist) throw new Error("PDF.js is required for browser QA (not a plugin runtime dependency)");
const pdfRoot = path.join(root, "node_modules/.pnpm", pdfDist, "node_modules/pdfjs-dist");
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>0.9.0 纸内批注验证</title><style>
body{margin:0;background:#e7e7e7}header{height:48px;box-sizing:border-box;padding:12px 20px;background:white;font:16px system-ui;color:#265744}#viewerContainer{position:absolute;inset:48px 0 0;overflow:auto}#viewer{position:relative;padding:0 18px}.page{position:relative;margin:20px auto;background:white;box-shadow:0 1px 4px #aaa}.page>canvas{display:block}.sample-highlight{position:absolute;background:#ffdc0080;pointer-events:none}#report{display:none}
</style><header id="status">正在验证真实 PDF 与插件布局…</header><div id="viewerContainer"><div id="viewer" class="pdfViewer"></div></div><pre id="report"></pre><script type="module">import * as pdfjs from '/pdf/build/pdf.mjs';pdfjs.GlobalWorkerOptions.workerSrc='/pdf/build/pdf.worker.mjs';window.pdfjsLib=pdfjs;await import('/harness.js');</script></html>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/") { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(html); return; }
  const file = url.pathname === "/source.pdf" ? pdfPath
    : url.pathname === "/harness.js" ? path.join(out, "harness.js")
    : url.pathname.startsWith("/pdf/") ? path.join(pdfRoot, url.pathname.slice(5)) : undefined;
  if (!file || !fs.existsSync(file) || (url.pathname.startsWith("/pdf/") && !path.resolve(file).startsWith(pdfRoot + path.sep))) { res.writeHead(404); res.end(); return; }
  res.setHeader("Content-Type", file.endsWith(".pdf") ? "application/pdf" : file.endsWith(".bcmap") ? "application/octet-stream" : "text/javascript");
  fs.createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(fs.existsSync);
if (!browser) { server.close(); throw new Error("A Chromium browser is required"); }
try {
  const result = await new Promise((resolve, reject) => {
    const profile = path.join(out, "browser-profile");
    const portFile = path.join(profile, "DevToolsActivePort");
    if (fs.existsSync(portFile)) fs.unlinkSync(portFile);
    const child = spawn(browser, ["--headless=new", "--no-sandbox", "--disable-gpu", "--in-process-gpu", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", `--user-data-dir=${profile}`, "--window-size=1800,1250", "--remote-debugging-port=0", "about:blank"], { windowsHide: true });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Browser QA exceeded 55 seconds")); }, 55000);
    child.stderr.on("data", (chunk) => stderr += chunk);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    (async () => {
      const pause = (ms) => new Promise((r) => setTimeout(r, ms));
      while (!fs.existsSync(portFile)) await pause(100);
      const port = fs.readFileSync(portFile, "utf8").split(/\r?\n/)[0];
      const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const ws = new WebSocket(tabs.find((tab) => tab.type === "page").webSocketDebuggerUrl);
      await new Promise((r, fail) => { ws.onopen = r; ws.onerror = fail; });
      let id = 0;
      const pending = new Map();
      ws.onmessage = ({ data }) => {
        const message = JSON.parse(data);
        if (message.id) { const handler = pending.get(message.id); pending.delete(message.id); handler?.(message); }
        if (message.method === "Runtime.exceptionThrown") stderr += JSON.stringify(message.params) + "\n";
        if (message.method === "Runtime.consoleAPICalled") stderr += JSON.stringify(message.params) + "\n";
      };
      const send = (method, params = {}) => new Promise((r, fail) => {
        const key = ++id;
        pending.set(key, (message) => message.error ? fail(new Error(JSON.stringify(message.error))) : r(message.result));
        ws.send(JSON.stringify({ id: key, method, params }));
      });
      await send("Runtime.enable");
      await send("Page.enable");
      await send("Emulation.setFocusEmulationEnabled", { enabled: true });
      await send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/` });
      const start = Date.now();
      while (Date.now() - start < 45000) {
        const state = await send("Runtime.evaluate", { expression: "document.documentElement.dataset.qa || ''", returnByValue: true });
        if (state.result?.value) break;
        await pause(100);
      }
      const dom = await send("Runtime.evaluate", { expression: "document.documentElement.outerHTML", returnByValue: true });
      stdout = dom.result.value;
      const screenshot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      fs.writeFileSync(path.join(out, "screenshot.png"), Buffer.from(screenshot.data, "base64"));
      await send("Browser.close");
      ws.close();
    })().catch((error) => { clearTimeout(timer); child.kill(); reject(error); });
  });
  fs.writeFileSync(path.join(out, "dom.html"), result.stdout);
  fs.writeFileSync(path.join(out, "browser.log"), result.stderr);
  const match = result.stdout.match(/<pre id="report">([^<]+)<\/pre>/);
  const report = match ? JSON.parse(match[1].replaceAll("&quot;", '"').replaceAll("&amp;", "&")) : { passed: false, error: "Browser did not finish the harness" };
  fs.writeFileSync(path.join(out, "results.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed || result.code !== 0) process.exitCode = 1;
} finally { server.closeAllConnections(); server.close(); }
