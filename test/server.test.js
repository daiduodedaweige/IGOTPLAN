"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { once } = require("node:events");
const { createApp } = require("../server");
const { emptyState, parseImport } = require("../state-model");
const { loadCredentials, authorizationHeader } = require("../lib/auth");
const exec = promisify(execFile);
const ROOT = path.resolve(__dirname, "..");
const quiet = { error() {}, warn() {} };
function sample(title = "测试任务") {
  return { tasks: [{ id: "task-1", date: "2026-11-20", title, notes: "备注", todos: [], points: 10, type: "single", completed: true, completionCount: 1, completedAt: "2026-11-20T00:00:00.000Z" }],
    rewards: [{ id: "reward-1", title: "奖励", notes: "", cost: 5, quantity: 1, initialQuantity: 2, redeemedCount: 1, redeemedAt: "2026-11-20T00:00:00.000Z" }],
    totalEarnedPoints: 10, totalSpentPoints: 5 };
}
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "igotplan-test-"));
  const dir = path.join(root, "data");
  const apps = [];
  t.after(async () => { for (const app of apps.reverse()) await app.close(); await fs.rm(root, { recursive: true, force: true }); });
  async function start() {
    const app = await createApp({ port: 0, dataDir: dir, logger: quiet, ...options });
    await app.listen();
    apps.push(app);
    const url = `http://127.0.0.1:${app.server.address().port}`;
    const authorization = authorizationHeader(await loadCredentials(dir));
    const request = (pathname, options = {}) => fetch(url + pathname, { ...options, headers: { Authorization: authorization, ...options.headers } });
    return { app, url, request, raw: (pathname, headers = {}) => rawRequest(url, pathname, { Authorization: authorization, ...headers }),
      get: async () => (await request("/api/state")).json(),
      put: (revision, state) => request("/api/state", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision: revision, state }) }),
      stop: async () => { apps.splice(apps.indexOf(app), 1); await app.close(); } };
  }
  return { root, dir, start };
}
function rawRequest(url, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(new URL(url).origin + "/", { path: pathname, headers }, (res) => {
      res.resume(); res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
  });
}

test("保存后重启、换端口仍可读取完整记录，历史备份有界且权限正确", async (t) => {
  const { dir, start } = await fixture(t, { backupKeep: 2 });
  let client = await start();
  assert.equal((await client.get()).initialized, false);
  await assert.rejects(fs.stat(path.join(dir, "state.json")), { code: "ENOENT" });
  for (let revision = 0; revision < 4; revision++) assert.equal((await client.put(revision, sample(`任务${revision}`))).status, 200);
  const before = await client.get();
  assert.equal(before.revision, 4);
  assert.equal((await fs.readdir(path.join(dir, "backups"))).filter((name) => name.startsWith("revision-")).length, 2);
  assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(dir, "state.json"))).mode & 0o777, 0o600);
  await client.stop();
  client = await start();
  assert.deepEqual(await client.get(), before);
  assert.equal((await client.put(4, emptyState())).status, 200);
  assert.equal((await client.get()).initialized, true, "已保存的空状态仍然是已初始化状态");
});

test("同版本并发提交只有一个成功，旧版本不能覆盖", async (t) => {
  const { start } = await fixture(t);
  const client = await start();
  const responses = await Promise.all([client.put(0, sample("A")), client.put(0, sample("B"))]);
  assert.deepEqual(responses.map((res) => res.status).sort(), [200, 409]);
  const saved = await client.get();
  assert.equal((await client.put(0, emptyState())).status, 409);
  assert.deepEqual(await client.get(), saved);
});

test("非法输入、超大请求和跨站写入被拒绝，数据保持不变", async (t) => {
  const { start } = await fixture(t);
  const client = await start();
  await client.put(0, sample());
  const invalid = sample();
  invalid.tasks[0].points = -1;
  assert.equal((await client.put(1, invalid)).status, 400);
  assert.equal((await client.put(1, { tasks: [] })).status, 400);
  const endpoint = "/api/state";
  assert.equal((await client.request(endpoint, { method: "PUT", body: "{}" })).status, 415);
  assert.equal((await client.request(endpoint, { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{" })).status, 400);
  assert.equal((await client.request(endpoint, { method: "PUT", headers: { "Content-Type": "application/json", Origin: "http://evil.example" }, body: JSON.stringify({ expectedRevision: 1, state: emptyState() }) })).status, 403);
  assert.equal((await client.request(endpoint, { method: "PUT", headers: { "Content-Type": "application/json" }, body: "x".repeat(2 * 1024 * 1024 + 1) })).status, 413);
  assert.equal((await client.get()).revision, 1);
});

test("静态资源可访问，数据、源码、隐藏目录和路径穿越不可访问", async (t) => {
  const { start, dir } = await fixture(t);
  const client = await start();
  await client.put(0, sample());
  for (const name of ["/", "/script.js", "/state-model.js", "/assets/live2d/Tororo/Tororo.model3.json"]) assert.equal((await client.request(name)).status, 200);
  for (const name of ["/data/state.json", "/data/backups/", "/server.js", "/plan.md", "/package.json", "/.env", "/assets/%2e%2e/data/state.json", "/assets/%2e%2e/%2e%2e/etc/passwd", "/assets/%00"]) assert.notEqual(await client.raw(name), 200, name);
  assert.equal(await client.raw("/api/state", { Host: "evil.example" }), 403);
  const symlink = path.join(ROOT, "assets", `igotplan-test-${path.basename(dir)}-${path.basename(path.dirname(dir))}`);
  await fs.symlink(path.join(dir, "state.json"), symlink);
  t.after(() => fs.rm(symlink, { force: true }));
  assert.equal(await client.raw("/assets/" + path.basename(symlink)), 403);
  assert.equal((await client.request("/api/state")).headers.get("cache-control"), "no-store");
});

test("损坏文件不会回退空状态或被覆盖，启动后丢失文件也会停止写入", async (t) => {
  const { dir, start } = await fixture(t);
  let client = await start();
  await client.put(0, sample());
  await client.stop();
  await fs.writeFile(path.join(dir, "state.json"), "damaged-original");
  client = await start();
  assert.equal((await client.request("/api/state")).status, 503);
  assert.equal((await client.put(0, emptyState())).status, 503);
  assert.equal(await fs.readFile(path.join(dir, "state.json"), "utf8"), "damaged-original");
  await client.stop();
  await fs.unlink(path.join(dir, "state.json"));
  client = await start();
  await client.put(0, sample());
  await fs.unlink(path.join(dir, "state.json"));
  assert.equal((await client.put(1, emptyState())).status, 503);
  await assert.rejects(fs.stat(path.join(dir, "state.json")), { code: "ENOENT" });
});

test("无写入权限时返回失败并保留原版本", async (t) => {
  const { dir, start } = await fixture(t);
  const client = await start();
  await client.put(0, sample());
  await fs.chmod(dir, 0o500);
  try {
    assert.equal((await client.put(1, emptyState())).status, 500);
    assert.deepEqual((await client.get()).state, sample());
  } finally { await fs.chmod(dir, 0o700); }
});

test("正在使用的数据目录拒绝第二个进程，失败的监听不会遗留锁", async (t) => {
  const { dir, start } = await fixture(t);
  const client = await start();
  await assert.rejects(createApp({ dataDir: dir, port: 0, logger: quiet }), /已有进程/);
  const another = path.join(path.dirname(dir), "another");
  const app = await createApp({ dataDir: another, port: client.app.server.address().port, logger: quiet });
  await assert.rejects(app.listen(), { code: "EADDRINUSE" });
  await assert.rejects(fs.stat(path.join(another, ".writer-lock")), { code: "ENOENT" });
});

test("备份和恢复工具保留损坏原件、提高版本，并拒绝在线恢复", async (t) => {
  const { root, dir, start } = await fixture(t);
  const client = await start();
  await client.put(0, sample());
  const destination = path.join(root, "independent-backups");
  await assert.rejects(exec(process.execPath, [path.join(ROOT, "scripts/data.js"), "backup", path.join(ROOT, "assets")], { env: { ...process.env, API_URL: client.url, DATA_DIR: dir } }), /公开静态资源/);
  await exec(process.execPath, [path.join(ROOT, "scripts/data.js"), "backup", destination], { env: { ...process.env, API_URL: client.url, DATA_DIR: dir } });
  const snapshot = path.join(destination, (await fs.readdir(destination))[0]);
  const env = { ...process.env, DATA_DIR: dir };
  await assert.rejects(exec(process.execPath, [path.join(ROOT, "scripts/data.js"), "restore", snapshot], { env }), /已有进程/);
  await client.stop();
  await fs.writeFile(path.join(dir, "state.json"), "preserve-corruption");
  await exec(process.execPath, [path.join(ROOT, "scripts/data.js"), "restore", snapshot], { env });
  const restored = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8"));
  assert.deepEqual(restored.state, sample());
  assert.ok(restored.revision > 1);
  const preserved = (await fs.readdir(path.join(dir, "backups"))).find((name) => name.startsWith("before-restore-"));
  assert.equal(await fs.readFile(path.join(dir, "backups", preserved), "utf8"), "preserve-corruption");
  const restarted = await start();
  assert.deepEqual((await restarted.get()).state, sample());
});

test("SIGKILL 后同主机死进程的锁可安全回收并读取原数据", async (t) => {
  const { dir, start } = await fixture(t);
  const initial = await start();
  await initial.put(0, sample());
  await initial.stop();
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], { env: { ...process.env, DATA_DIR: dir, PORT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("启动超时")), 10000);
    child.stdout.on("data", (chunk) => { output += chunk; if (output.includes("已启动")) { clearTimeout(timer); resolve(); } });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`子进程提前退出 ${code}`)); });
  });
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  const restarted = await start();
  assert.deepEqual((await restarted.get()).state, sample());
  assert.ok((await fs.readdir(dir)).some((name) => name.startsWith(".stale-lock-")));
});

test("兼容 v1/v2 导入，拒绝未知版本和损坏记录", () => {
  const legacy = parseImport([{ id: "old", date: "2026-11-20", title: "原任务", completed: true }]);
  assert.equal(legacy.tasks[0].completed, false);
  assert.equal(legacy.tasks[0].points, 10);
  assert.deepEqual(parseImport(sample()), sample());
  assert.deepEqual(parseImport({ schemaVersion: 1, state: sample() }), sample());
  assert.throws(() => parseImport({ schemaVersion: 999, state: sample() }));
  assert.throws(() => parseImport({ tasks: [null], rewards: [] }));
  assert.throws(() => parseImport({}));
});

test("旧格式备注迁移并保留，子任务经重启和离线恢复后不丢失", async (t) => {
  const { root, dir, start } = await fixture(t);
  const oldState = sample("旧格式任务");
  delete oldState.tasks[0].todos;
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, "state.json"), JSON.stringify({
    schemaVersion: 1, revision: 3, updatedAt: "2026-11-20T00:00:00.000Z", state: oldState,
  }));
  let client = await start();
  const migrated = await client.get();
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.state.tasks[0].notes, "备注");
  assert.deepEqual(migrated.state.tasks[0].todos, []);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8")).schemaVersion, 1, "读取旧记录不改写原文件");
  const todos = [
    { id: "sub-1", title: "已完成的子任务", completed: true },
    { id: "sub-2", title: "待完成的子任务", completed: false },
  ];
  migrated.state.tasks[0].todos = todos;
  assert.equal((await client.put(3, migrated.state)).status, 200);
  const backup = path.join(root, "with-todos.json");
  await fs.writeFile(backup, JSON.stringify(await client.get()));
  await client.stop();
  client = await start();
  assert.deepEqual((await client.get()).state.tasks[0].todos, todos);
  const current = await client.get();
  await client.put(current.revision, emptyState());
  await client.stop();
  await exec(process.execPath, [path.join(ROOT, "scripts/data.js"), "restore", backup], {
    cwd: ROOT, env: { ...process.env, DATA_DIR: dir },
  });
  client = await start();
  const restored = await client.get();
  assert.equal(restored.state.tasks[0].notes, "备注");
  assert.deepEqual(restored.state.tasks[0].todos, todos);
});

test("子任务字段受校验，非法子任务不能覆盖已保存的数据", async (t) => {
  const { start } = await fixture(t);
  const client = await start();
  const value = sample();
  value.tasks[0].todos = [{ id: "sub", title: "有效子任务", completed: false, unexpected: "忽略额外字段" }];
  assert.equal((await client.put(0, value)).status, 200);
  const stored = await client.get();
  assert.deepEqual(stored.state.tasks[0].todos, [{ id: "sub", title: "有效子任务", completed: false }]);
  for (const todos of [
    null, {}, [null], [{ id: "sub", title: " ", completed: false }],
    [{ id: "sub", title: "错误状态", completed: "false" }],
    [{ id: "sub", title: "过".repeat(81), completed: false }],
    [{ id: "sub", title: "重复一", completed: false }, { id: "sub", title: "重复二", completed: true }],
    Array.from({ length: 101 }, (_, index) => ({ id: `sub-${index}`, title: "超过数量", completed: false })),
  ]) {
    const invalid = structuredClone(stored.state);
    invalid.tasks[0].todos = todos;
    assert.equal((await client.put(stored.revision, invalid)).status, 400);
    assert.deepEqual(await client.get(), stored);
  }
});
