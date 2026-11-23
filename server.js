"use strict";
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { Store, HttpError } = require("./lib/store");
const { validateState } = require("./state-model");

const ROOT = __dirname;
const MAX_BODY = 2 * 1024 * 1024;
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".moc3": "application/octet-stream" };
function inside(filename, directory) { return filename === directory || filename.startsWith(directory + path.sep); }
function json(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}
function readJson(req) {
  if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") throw new HttpError(415, "请求必须使用 application/json");
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new HttpError(413, "数据超过 2 MiB 限制")); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (size > MAX_BODY) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new HttpError(400, "JSON 格式无效")); }
    });
    req.on("error", reject);
    req.on("aborted", () => reject(new HttpError(400, "请求中断")));
  });
}

async function createApp(options = {}) {
  const host = options.host ?? process.env.HOST ?? "127.0.0.1";
  const port = Number(options.port ?? process.env.PORT ?? 8000);
  const backupKeep = Number(options.backupKeep ?? process.env.BACKUP_KEEP ?? 30);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT 必须是有效端口");
  if (!Number.isInteger(backupKeep) || backupKeep < 1 || backupKeep > 1000) throw new Error("BACKUP_KEEP 必须是 1 到 1000 之间的整数");
  const logger = options.logger ?? console;
  const dataDir = path.resolve(ROOT, options.dataDir ?? process.env.DATA_DIR ?? "data");
  if (inside(ROOT, dataDir) || inside(dataDir, path.join(ROOT, "assets"))) throw new Error("数据目录不能是项目根目录、上级目录或静态资源目录");
  const assetsRoot = await fs.realpath(path.join(ROOT, "assets"));
  const realRoot = await fs.realpath(ROOT);
  let resolvedDataDir;
  try { resolvedDataDir = await fs.realpath(dataDir); }
  catch (error) { if (error.code !== "ENOENT") throw error; resolvedDataDir = dataDir; }
  if (inside(realRoot, resolvedDataDir) || inside(resolvedDataDir, assetsRoot)) throw new Error("数据目录不能位于静态资源目录中或包含项目根目录");
  const store = await new Store(dataDir, { backupKeep, logger }).open();
  if (inside(realRoot, store.dir) || inside(store.dir, assetsRoot)) { await store.close(); throw new Error("数据目录不能位于静态资源目录中或包含项目根目录"); }
  const allowedHosts = new Set(["localhost", "127.0.0.1", "[::1]", os.hostname(), os.hostname().split(".")[0], host]);
  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    try {
      let hostname;
      try { hostname = new URL(`http://${req.headers.host}`).hostname; }
      catch { throw new HttpError(400, "Host 无效"); }
      if (!allowedHosts.has(hostname)) throw new HttpError(403, "访问主机名未获允许");
      const pathname = decodeURIComponent(req.url.split("?")[0]);
      if (pathname.includes("\\") || pathname.includes("\0") || pathname.split("/").some((part) => part.startsWith("."))) throw new HttpError(403, "路径不允许访问");
      if (pathname === "/api/state") {
        if (req.method === "GET") return json(res, 200, await store.read());
        if (req.method !== "PUT") { res.setHeader("Allow", "GET, PUT"); throw new HttpError(405, "请求方法不允许"); }
        if (req.headers["sec-fetch-site"] === "cross-site") throw new HttpError(403, "不允许跨站写入");
        if (req.headers.origin) {
          let origin;
          try { origin = new URL(req.headers.origin); } catch { throw new HttpError(403, "请求来源无效"); }
          if (origin.host !== req.headers.host || origin.protocol !== "http:") throw new HttpError(403, "不允许跨站写入");
        }
        const input = await readJson(req);
        if (!input || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new HttpError(400, "缺少有效的数据版本");
        let state;
        try { state = validateState(input.state); } catch (error) { throw new HttpError(400, error.message); }
        return json(res, 200, await store.save(input.expectedRevision, state));
      }
      if (!["GET", "HEAD"].includes(req.method)) throw new HttpError(405, "请求方法不允许");
      const publicFiles = new Set(["/", "/index.html", "/script.js", "/style.css", "/state-model.js"]);
      if (!publicFiles.has(pathname) && !pathname.startsWith("/assets/")) throw new HttpError(404, "文件不存在");
      const requested = path.join(ROOT, pathname === "/" ? "index.html" : pathname.slice(1));
      const filename = await fs.realpath(requested);
      if (!inside(filename, ROOT) || inside(filename, store.dir) || (pathname.startsWith("/assets/") && !inside(filename, assetsRoot))) throw new HttpError(403, "文件不允许访问");
      const stat = await fs.stat(filename);
      if (!stat.isFile()) throw new HttpError(404, "文件不存在");
      const body = req.method === "HEAD" ? null : await fs.readFile(filename);
      res.writeHead(200, { "Content-Type": MIME[path.extname(filename)] ?? "application/octet-stream", "Cache-Control": "no-store", "Content-Length": stat.size });
      res.end(body);
    } catch (error) {
      const status = error.status ?? (error.code === "ENOENT" ? 404 : error instanceof URIError ? 400 : 500);
      if (status >= 500) logger.error(`请求失败 (${error.code || status})。`);
      const message = status === 500 ? "服务器保存失败，请保留未保存内容并重试。" : status === 404 ? "文件不存在" : error instanceof URIError ? "路径编码无效" : error.message;
      if (!res.headersSent && !res.destroyed) json(res, status, { error: message });
      else res.destroy();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return {
    server, store,
    listen: () => new Promise((resolve, reject) => {
      const onError = async (error) => { await store.close(); reject(error); };
      server.once("error", onError);
      server.listen(port, host, () => { server.removeListener("error", onError); resolve(server.address()); });
    }),
    close: async () => {
      await new Promise((resolve, reject) => server.close((error) => error && error.code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve()));
      await store.close();
    },
  };
}
if (require.main === module) {
  process.umask(0o077);
  (async () => {
    const app = await createApp();
    const address = await app.listen();
    console.log(`I GOT PLAN 已启动：http://${address.address}:${address.port}`);
    console.log(`数据目录：${app.store.dir}`);
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      const timer = setTimeout(() => process.exit(1), 15000).unref();
      try { await app.close(); clearTimeout(timer); process.exit(0); }
      catch (error) { console.error(`停止失败：${error.message}`); process.exit(1); }
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  })().catch((error) => { console.error(`启动失败：${error.message}`); process.exitCode = 1; });
}
module.exports = { createApp };
