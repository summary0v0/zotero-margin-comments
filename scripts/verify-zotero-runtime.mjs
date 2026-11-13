/** Isolated Zotero/Gecko smoke test. Never uses the user's Zotero profile or database. */
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [executable, inputPDF] = process.argv.slice(2);
const dragTest = process.argv.includes("--drag");
const sideTest = process.argv.includes("--sides");
if (!executable || !inputPDF || !fs.existsSync(executable) || !fs.existsSync(inputPDF)) {
  throw new Error("Usage: node scripts/verify-zotero-runtime.mjs <zotero.exe> <PLLaVA PDF>");
}
const out = path.join(root, sideTest ? "build/zotero-sides-qa" : "build/zotero-runtime-qa");
const profile = path.join(out, "profile");
const dataDirectory = path.join(out, "data");
const addon = path.join(out, "test-addon");
for (const dir of [out, profile, dataDirectory, addon]) fs.mkdirSync(dir, { recursive: true });
const reportFile = path.join(out, "results.json");
if (fs.existsSync(reportFile)) fs.unlinkSync(reportFile);
const pnpm = path.join(root, "node_modules/.pnpm");
const require = createRequire(import.meta.url);
const esbuild = require(path.join(pnpm, fs.readdirSync(pnpm).find((n) => n.startsWith("esbuild@")), "node_modules/esbuild"));
await esbuild.build({
  stdin: { contents: "import {Zotero9ReaderAdapter} from './src/zotero/reader-adapter';import {ReaderSession} from './src/zotero/reader-session';import {AnnotationStore} from './src/zotero/annotation-store';globalThis.MarginAdapter=Zotero9ReaderAdapter;globalThis.MarginSession=ReaderSession;globalThis.MarginStore=AnnotationStore;", resolveDir: root, loader: "ts" },
  bundle: true, platform: "browser", target: "firefox140", outfile: path.join(out, "probe.js"),
});
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const release = path.join(root, "releases", `margin-comments-${pkg.version}.xpi`);
// Match Zotero's complete manifest schema, including description and icons.
const manifestResult = spawnSync("tar", ["-xOf", release, "manifest.json"]);
if (manifestResult.status !== 0) throw new Error("Build a release XPI before running native QA");
const manifest = JSON.parse(manifestResult.stdout.toString());
manifest.name = "Margin Comments isolated runtime test";
manifest.applications.zotero.id = "margin-runtime-test@local.zotero";
fs.writeFileSync(path.join(addon, "manifest.json"), JSON.stringify(manifest));
fs.mkdirSync(path.join(addon, "content/icons"), { recursive: true });
fs.copyFileSync(path.join(root, "addon/content/icons/margin-comments.svg"), path.join(addon, "content/icons/margin-comments.svg"));
const bootstrap = fs.readFileSync(path.join(root, "bench/zotero-runtime-bootstrap.js"), "utf8")
  .replace("__ZMC_QA_ROOT__", JSON.stringify(out)).replace("__ZMC_QA_INPUT__", JSON.stringify(path.resolve(inputPDF)));
fs.writeFileSync(path.join(addon, "bootstrap.js"), bootstrap
  .replace("__ZMC_QA_DRAG__", JSON.stringify(dragTest))
  .replace("__ZMC_QA_SIDES__", JSON.stringify(sideTest))
  + (sideTest ? "\n" + fs.readFileSync(path.join(root, "bench/zotero-sides-runtime.js"), "utf8") : ""));
const testXpi = path.join(out, "test-addon.xpi");
if (fs.existsSync(testXpi)) fs.unlinkSync(testXpi);
const quotePS = (value) => `'${value.replaceAll("'", "''")}'`;
const zip = spawnSync("powershell", ["-NoProfile", "-Command", `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory(${quotePS(addon)},${quotePS(testXpi)})`]);
if (zip.status !== 0) throw new Error(zip.stderr.toString());
const portServer = net.createServer();
await new Promise((r) => portServer.listen(0, "127.0.0.1", r));
const port = portServer.address().port;
await new Promise((r) => portServer.close(r));
const prefs = {
  "marionette.enabled": true, "marionette.port": port,
  "extensions.zotero.useDataDir": true, "extensions.zotero.dataDir": dataDirectory,
  "extensions.zotero.firstRun": false, "extensions.zotero.firstRun2": false,
  "extensions.zotero.httpServer.enabled": false, "extensions.zotero.sync.autoSync": false,
  "extensions.zotero.automaticScraperUpdates": false,
  "app.update.auto": false, "browser.shell.checkDefaultBrowser": false,
};
fs.writeFileSync(path.join(profile, "user.js"), Object.entries(prefs).map(([k, v]) => `user_pref(${JSON.stringify(k)},${JSON.stringify(v)});`).join("\n"));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const child = spawn(executable, ["-no-remote", "-profile", profile, "--headless", "-marionette", "--remote-allow-system-access", "-ZoteroDebugText"], { windowsHide: true, env: { ...process.env, MOZ_HEADLESS: "1" } });
let log = "", socket;
child.stdout.on("data", (chunk) => log += chunk);
child.stderr.on("data", (chunk) => log += chunk);
try {
  for (let i = 0; i < 120 && !socket; i++) {
    try {
      socket = await new Promise((resolve, reject) => {
        const s = net.createConnection({ host: "127.0.0.1", port });
        s.once("connect", () => resolve(s)); s.once("error", reject);
      });
    } catch { await pause(150); }
  }
  if (!socket) throw new Error("Isolated Zotero automation did not start");
  let buffer = Buffer.alloc(0), sequence = 0;
  const pending = new Map();
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const colon = buffer.indexOf(58);
      if (colon < 0) break;
      const length = Number(buffer.subarray(0, colon).toString());
      if (buffer.length < colon + 1 + length) break;
      const message = JSON.parse(buffer.subarray(colon + 1, colon + 1 + length));
      buffer = buffer.subarray(colon + 1 + length);
      if (Array.isArray(message) && message[0] === 1) {
        pending.get(message[1])?.(message); pending.delete(message[1]);
      }
    }
  });
  function send(method, args = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence, body = JSON.stringify([0, id, method, args]);
      pending.set(id, (reply) => reply[2] ? reject(new Error(JSON.stringify(reply[2]))) : resolve(reply[3]));
      socket.write(`${Buffer.byteLength(body)}:${body}`);
    });
  }
  // Zotero never signals Firefox's browser-idle-startup-tasks-finished. The
  // session is allocated before that wait; installing our isolated addon needs
  // no browser actors or interaction with the user's running app.
  void send("WebDriver:NewSession", { capabilities: { acceptInsecureCerts: true } }).catch(() => {});
  await pause(3500);
  await send("Addon:Install", { path: testXpi, temporary: true });
  const start = Date.now();
  let result;
  while (Date.now() - start < 45000) {
    if (fs.existsSync(reportFile)) {
      try { result = JSON.parse(fs.readFileSync(reportFile, "utf8")); } catch {}
      if (result?.passed || result?.error) break;
    }
    await pause(150);
  }
  if (!result?.passed) throw new Error(JSON.stringify(result ?? { error: "Native QA timed out" }));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(String(error)); process.exitCode = 1;
} finally {
  socket?.destroy();
  for (let i = 0; i < 20 && child.exitCode === null; i++) await pause(100);
  if (child.exitCode === null) child.kill();
  fs.writeFileSync(path.join(out, "runtime.log"), log);
}
