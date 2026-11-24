"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { createApp } = require("../server");
const { emptyState } = require("../state-model");
const { loadCredentials, authorizationHeader } = require("../lib/auth");
const exec = promisify(execFile);
const ROOT = path.resolve(__dirname, "..");
const quiet = { error() {}, warn() {} };

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "igotplan-auth-"));
  const dataDir = path.join(root, "data");
  let app;
  t.after(async () => { await app?.close(); await fs.rm(root, { recursive: true, force: true }); });
  async function start() {
    app = await createApp({ dataDir, port: 0, logger: quiet });
    await app.listen();
    return `http://127.0.0.1:${app.server.address().port}`;
  }
  return { root, dataDir, start, stop: async () => { await app.close(); app = null; } };
}

test("页面、静态资源和数据读写统一认证，错误凭据不会写入数据", async (t) => {
  const { dataDir, start } = await fixture(t);
  const url = await start();
  for (const route of ["/", "/index.html", "/script.js", "/state-model.js", "/assets/vendor/pixi.min.js", "/api/state"]) {
    const response = await fetch(url + route);
    assert.equal(response.status, 401, route);
    assert.match(response.headers.get("www-authenticate"), /^Basic /);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  const body = JSON.stringify({ expectedRevision: 0, state: emptyState() });
  for (const Authorization of ["Bearer invalid", "Basic !!!", "Basic " + Buffer.from("plan:wrong").toString("base64")]) {
    assert.equal((await fetch(url + "/api/state", { method: "PUT", headers: { Authorization, "Content-Type": "application/json" }, body })).status, 401);
  }
  await assert.rejects(fs.stat(path.join(dataDir, "state.json")), { code: "ENOENT" });
  const credentials = await loadCredentials(dataDir);
  assert.equal((await fs.stat(path.join(dataDir, "access.json"))).mode & 0o777, 0o600);
  const headers = { Authorization: authorizationHeader(credentials) };
  assert.equal((await fetch(url, { headers })).status, 200);
  assert.equal((await fetch(url + "/api/state", { method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body })).status, 200);
  assert.equal((await fetch(url + "/data/access.json", { headers })).status, 404);
  assert.equal((await fetch(url + "/api/state", { headers })).status, 200);
});

test("凭据重启后保留，在线重置被拒绝，离线重置后旧密码失效", async (t) => {
  const { dataDir, start, stop } = await fixture(t);
  await start();
  const original = await loadCredentials(dataDir);
  const env = { ...process.env, DATA_DIR: dataDir };
  await assert.rejects(exec(process.execPath, [path.join(ROOT, "scripts/credentials.js"), "reset"], { env }), /已有进程/);
  await stop();
  await start();
  assert.deepEqual(await loadCredentials(dataDir), original);
  await stop();
  const result = await exec(process.execPath, [path.join(ROOT, "scripts/credentials.js"), "reset"], { env });
  const current = await loadCredentials(dataDir);
  assert.notEqual(current.password, original.password);
  assert.ok(result.stdout.includes(current.password));
  const url = await start();
  assert.equal((await fetch(url, { headers: { Authorization: authorizationHeader(original) } })).status, 401);
  assert.equal((await fetch(url, { headers: { Authorization: authorizationHeader(current) } })).status, 200);
});

test("损坏、不安全权限和符号链接凭据阻止启动，并释放数据锁", async (t) => {
  const { root, dataDir, start, stop } = await fixture(t);
  await start();
  await stop();
  const filename = path.join(dataDir, "access.json");
  const valid = await fs.readFile(filename);
  await fs.writeFile(filename, "{}");
  await assert.rejects(start(), /访问凭据无效/);
  await assert.rejects(fs.stat(path.join(dataDir, ".writer-lock")), { code: "ENOENT" });
  await fs.writeFile(filename, valid);
  await fs.chmod(filename, 0o644);
  await assert.rejects(start(), /0600/);
  await fs.chmod(filename, 0o600);
  const other = path.join(root, "other.json");
  await fs.rename(filename, other);
  await fs.symlink(other, filename);
  await assert.rejects(start(), { code: "ELOOP" });
  assert.deepEqual(await fs.readFile(other), valid);
  await fs.unlink(filename);
  await fs.rename(other, filename);
  assert.ok(await start());
});

test("备份工具使用本地凭据，拒绝向外部地址和重定向发送密码", async (t) => {
  const { root, dataDir, start } = await fixture(t);
  const url = await start();
  const env = { ...process.env, DATA_DIR: dataDir, API_URL: url };
  const destination = path.join(root, "snapshots");
  await exec(process.execPath, [path.join(ROOT, "scripts/data.js"), "backup", destination], { env });
  await assert.rejects(exec(process.execPath, [path.join(ROOT, "scripts/data.js"), "backup", destination], {
    env: { ...env, API_URL: "http://evil.example" },
  }), /本机 HTTP 地址/);
  let requests = 0;
  const redirector = http.createServer((req, res) => {
    requests++;
    res.writeHead(302, { Location: "/redirected" });
    res.end();
  });
  await new Promise((resolve) => redirector.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => redirector.close(resolve)));
  await assert.rejects(exec(process.execPath, [path.join(ROOT, "scripts/data.js"), "backup", destination], {
    env: { ...env, API_URL: `http://127.0.0.1:${redirector.address().port}` },
  }), /fetch failed/);
  assert.equal(requests, 1, "凭据不会被发送到重定向目标");
});
