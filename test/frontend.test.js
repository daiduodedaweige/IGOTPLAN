"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { webcrypto } = require("node:crypto");
const { JSDOM } = require("jsdom");
const { createApp } = require("../server");
const { emptyState } = require("../state-model");
const { loadCredentials, authorizationHeader } = require("../lib/auth");
const ROOT = path.resolve(__dirname, "..");
const quiet = { error() {}, warn() {} };
async function until(check) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("前端状态等待超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "igotplan-ui-"));
  const app = await createApp({ dataDir: path.join(dir, "data"), port: 0, logger: quiet });
  await app.listen();
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const authorization = authorizationHeader(await loadCredentials(app.store.dir));
  const doms = [];
  const html = await fs.readFile(path.join(ROOT, "index.html"), "utf8");
  const sources = await Promise.all(["state-model.js", "script.js"].map((name) => fs.readFile(path.join(ROOT, name), "utf8")));
  t.after(async () => { doms.forEach((dom) => dom.window.close()); await app.close(); await fs.rm(dir, { recursive: true, force: true }); });
  async function page(options = {}) {
    const dom = new JSDOM(html, { url: origin, runScripts: "outside-only" });
    doms.push(dom);
    const window = dom.window;
    window.AbortSignal = AbortSignal;
    Object.defineProperty(window, "crypto", { value: webcrypto });
    window.confirm = () => true;
    window.alert = (message) => { throw new Error(message); };
    window.Blob = Blob;
    const downloads = [];
    window.URL.createObjectURL = (blob) => { downloads.push(blob); return "blob:export"; };
    window.URL.revokeObjectURL = () => {};
    window.HTMLAnchorElement.prototype.click = function () {};
    for (const [key, value] of Object.entries(options.storage ?? {})) window.localStorage.setItem(key, value);
    if (options.storageBlocked) Object.defineProperty(window, "localStorage", { get() { throw new Error("blocked"); } });
    window.fetch = async (url, settings = {}) => {
      if (options.intercept) {
        const result = await options.intercept(settings);
        if (result) return result;
      }
      return fetch(new URL(url, origin), { ...settings, headers: { Authorization: authorization, ...settings.headers, ...(settings.method === "PUT" ? { Origin: origin } : {}) } });
    };
    sources.forEach((source) => window.eval(source));
    const document = window.document;
    return { window, document, downloads, status: () => document.getElementById("save-status").textContent,
      ready: () => until(() => !document.getElementById("task-title").disabled),
      saved: () => until(() => document.getElementById("save-status").textContent === "已保存到服务器"),
      click: (selector) => document.querySelector(selector).click(),
      task(title = "任务", type = "single") {
        document.getElementById("task-title").value = title;
        document.getElementById("task-type").value = type;
        document.getElementById("task-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      },
      snapshotStorage() { return Object.fromEntries(Array.from({ length: window.localStorage.length }, (_, index) => { const key = window.localStorage.key(index); return [key, window.localStorage.getItem(key)]; })); },
    };
  }
  return { app, page, state: async () => (await fetch(origin + "/api/state", { headers: { Authorization: authorization } })).json() };
}

test("加载完成前禁止编辑，长期任务、奖励、积分在新页面中保留", async (t) => {
  const { page, state } = await fixture(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = await page({ intercept: async (request) => { if (request.method === "GET") await gate; } });
  assert.equal(first.document.getElementById("task-title").disabled, true);
  first.task("不能保存");
  assert.equal((await state()).initialized, false);
  release();
  await first.ready();
  first.task("长期任务", "long-term");
  first.click(".complete"); first.click(".complete");
  const d = first.document;
  d.getElementById("reward-title").value = "奖励";
  d.getElementById("reward-cost").value = "5";
  d.getElementById("reward-quantity").value = "2";
  d.getElementById("reward-form").dispatchEvent(new first.window.Event("submit", { bubbles: true, cancelable: true }));
  first.click(".redeem"); first.click(".redeem");
  await first.saved();
  const stored = (await state()).state;
  assert.equal(stored.tasks[0].completionCount, 2);
  assert.equal(stored.rewards[0].quantity, 0);
  assert.equal(stored.totalEarnedPoints - stored.totalSpentPoints, 10);
  const second = await page();
  await second.ready();
  assert.match(second.document.querySelector("#task-list .title").textContent, /长期任务/);
  assert.equal(second.document.getElementById("available-points").textContent, "10");
});

test("快速连续修改按版本顺序保存，失败可重试且有可导出的本地副本", async (t) => {
  const { page, state } = await fixture(t);
  let fail = true;
  const client = await page({ intercept: async (request) => { if (fail && request.method === "PUT") throw new TypeError("模拟网络中断"); } });
  await client.ready();
  client.task("未保存任务");
  await until(() => client.status().includes("保存失败"));
  assert.equal((await state()).initialized, false);
  assert.ok(Object.keys(client.snapshotStorage()).some((key) => key.startsWith("daily-plan-board:pending:")));
  client.click("#export-data");
  const exported = JSON.parse(await client.downloads[0].text());
  assert.equal(exported.state.tasks[0].title, "未保存任务");
  assert.equal(exported.unsaved, true);
  fail = false;
  client.click("#retry-save");
  client.task("第二个任务");
  client.task("第三个任务");
  await client.saved();
  assert.equal((await state()).state.tasks.length, 3);
  assert.equal(Object.keys(client.snapshotStorage()).filter((key) => key.startsWith("daily-plan-board:pending:")).length, 0);
});

test("两个页面冲突时保留本地修改，导出后重新加载服务器版本", async (t) => {
  const { page, state } = await fixture(t);
  const first = await page(); const second = await page();
  await first.ready(); await second.ready();
  first.task("服务器任务"); await first.saved();
  second.task("本地冲突任务");
  await until(() => second.status().includes("保存冲突"));
  assert.equal((await state()).state.tasks[0].title, "服务器任务");
  assert.equal(second.document.querySelector(".title").textContent, "本地冲突任务");
  assert.equal(second.document.getElementById("task-title").disabled, true);
  second.click("#export-data");
  assert.equal(JSON.parse(await second.downloads[0].text()).state.tasks[0].title, "本地冲突任务");
  second.click("#reload-data"); await second.ready();
  assert.equal(second.document.querySelector(".title").textContent, "服务器任务");
});

test("v1 旧记录需显式迁移，保留原记录，已初始化的空状态不触发迁移", async (t) => {
  const { page, app, state } = await fixture(t);
  const legacy = JSON.stringify([{ id: "old", date: "2026-11-20", title: "旧任务", notes: "旧备注" }]);
  const client = await page({ storage: { "daily-plan-board:v1": legacy } });
  await client.ready();
  assert.equal((await state()).initialized, false);
  assert.equal(client.document.getElementById("import-legacy").hidden, false);
  client.click("#import-legacy"); await client.saved();
  assert.equal((await state()).state.tasks[0].title, "旧任务");
  assert.equal(client.window.localStorage.getItem("daily-plan-board:v1"), legacy);
  const current = await state();
  await app.store.save(current.revision, emptyState());
  const other = await page({ storage: { "daily-plan-board:v1": legacy } });
  await other.ready();
  assert.equal(other.document.getElementById("import-legacy").hidden, true);
  assert.equal((await state()).state.tasks.length, 0);
});

test("未保存内容可在重新打开后恢复，陈旧副本不会悄悄覆盖服务器", async (t) => {
  const { page, app, state } = await fixture(t);
  const failing = await page({ intercept: async (request) => { if (request.method === "PUT") throw new Error("断网"); } });
  await failing.ready(); failing.task("恢复任务");
  await until(() => failing.status().includes("保存失败"));
  const storage = failing.snapshotStorage();
  const reopened = await page({ storage });
  await until(() => !reopened.document.getElementById("restore-pending").disabled);
  reopened.click("#restore-pending"); await reopened.saved();
  assert.equal((await state()).state.tasks[0].title, "恢复任务");
  const current = await state();
  await app.store.save(current.revision, emptyState());
  const stale = await page({ storage });
  await until(() => !stale.document.getElementById("restore-pending").disabled);
  stale.click("#restore-pending");
  assert.match(stale.status(), /保存冲突/);
  assert.equal((await state()).state.tasks.length, 0);
  const reopenedStale = await page({ storage: stale.snapshotStorage() });
  await until(() => !reopenedStale.document.getElementById("restore-pending").disabled);
  reopenedStale.click("#restore-pending");
  assert.match(reopenedStale.status(), /保存冲突/, "冲突副本再次恢复也不能变成可直接保存的新版本");
  assert.equal((await state()).state.tasks.length, 0);
});

test("导入文件校验后替换完整状态，本地存储不可用时仍可保存到服务器", async (t) => {
  const { page, state } = await fixture(t);
  const client = await page({ storageBlocked: true });
  await client.ready();
  assert.equal(client.document.getElementById("storage-warning").hidden, false);
  const input = client.document.getElementById("import-file");
  Object.defineProperty(input, "files", { configurable: true, value: [{ size: 100, text: async () => {
    client.window.dispatchEvent(new client.window.Event("focus"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    return JSON.stringify([{ id: "imported", date: "2026-11-20", title: "导入任务" }]);
  } }] });
  input.dispatchEvent(new client.window.Event("change"));
  await client.saved();
  assert.equal((await state()).state.tasks[0].title, "导入任务");
});

test("初次加载失败时保持只读，不向服务器提交空状态", async (t) => {
  const { page, state } = await fixture(t);
  const client = await page({ intercept: async () => { throw new Error("加载连接失败"); } });
  await until(() => client.status().includes("加载连接失败"));
  client.task("不能提交");
  assert.equal(client.document.getElementById("task-title").disabled, true);
  assert.equal(client.document.getElementById("import-data").disabled, true);
  assert.equal((await state()).initialized, false);
});

test("编辑、撤销完成、删除、清空和重置均保存到服务器", async (t) => {
  const { page, state } = await fixture(t);
  const client = await page(); await client.ready();
  client.task("原任务"); client.click(".complete");
  client.window.prompt = () => "新任务";
  client.click("#task-list .rename-task");
  client.window.prompt = () => "15";
  client.click("#task-list .points-badge"); await client.saved();
  assert.equal((await state()).state.totalEarnedPoints, 15);
  assert.equal((await state()).state.tasks[0].title, "新任务");
  client.click(".complete"); await client.saved();
  assert.equal((await state()).state.totalEarnedPoints, 0);
  client.click(".complete");
  const d = client.document;
  d.getElementById("reward-title").value = "原奖励";
  d.getElementById("reward-cost").value = "5";
  d.getElementById("reward-form").dispatchEvent(new client.window.Event("submit", { bubbles: true, cancelable: true }));
  client.click(".redeem");
  client.window.prompt = () => "新奖励"; client.click("#reward-list .title");
  client.window.prompt = () => "2"; client.click("#reward-list .points-badge");
  client.window.prompt = () => "4"; client.click("#reward-list .stock-badge");
  await client.saved();
  assert.equal((await state()).state.rewards[0].title, "新奖励");
  assert.equal((await state()).state.rewards[0].cost, 2);
  client.click("#reset-points"); await client.saved();
  assert.equal((await state()).state.totalSpentPoints, 0);
  assert.equal((await state()).state.totalEarnedPoints, 0);
  assert.equal((await state()).state.rewards[0].quantity, 4);
  client.click("#task-list .danger"); client.click("#reward-list .danger"); await client.saved();
  assert.equal((await state()).state.tasks.length, 0);
  assert.equal((await state()).state.rewards.length, 0);
  client.task("清空任务"); client.click("#clear-tasks");
  d.getElementById("reward-title").value = "清空奖励";
  d.getElementById("reward-form").dispatchEvent(new client.window.Event("submit", { bubbles: true, cancelable: true }));
  client.click("#clear-rewards"); await client.saved();
  assert.deepEqual((await state()).state, emptyState());
});

test("逐条创建子任务，勾选和增删后跨页面及导入导出保留", async (t) => {
  const { page, state } = await fixture(t);
  const client = await page();
  await client.ready();
  const { document: d, window: w } = client;
  const form = d.getElementById("task-form");
  const input = d.getElementById("task-todo-input");
  const draft = d.getElementById("task-todo-list");
  form.closest("details").open = true;
  input.value = "准备资料";
  client.click("#add-task-todo");
  assert.equal(draft.children.length, 1);
  assert.equal((await state()).state.tasks.length, 0);
  input.value = "完成初稿";
  const composing = new w.KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true });
  input.dispatchEvent(composing);
  assert.equal(draft.children.length, 1, "中文输入确认不能提前添加子任务");
  const enter = new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  input.dispatchEvent(enter);
  assert.equal(enter.defaultPrevented, true);
  assert.equal(draft.children.length, 2);
  draft.querySelector("input").click();
  form.closest("details").open = false;
  form.closest("details").open = true;
  assert.equal(draft.children.length, 2);
  assert.equal(draft.querySelector("input").checked, true);
  input.value = "最后检查";
  d.getElementById("task-title").value = "论文任务";
  form.requestSubmit();
  await client.saved();
  let todos = (await state()).state.tasks[0].todos;
  assert.deepEqual(todos.map((todo) => todo.title), ["准备资料", "完成初稿", "最后检查"]);
  assert.deepEqual(todos.map((todo) => todo.completed), [true, false, false]);
  assert.equal(draft.children.length, 0);
  assert.equal(input.value, "");
  assert.equal(form.closest("details").open, false);
  const checkboxes = d.querySelectorAll("#task-list .todo-list input");
  checkboxes[1].click();
  await client.saved();
  assert.equal((await state()).state.tasks[0].todos[1].completed, true);
  assert.equal(d.getElementById("available-points").textContent, "0");
  assert.equal(d.querySelector(".todo-progress").textContent, "子任务 2/3");
  w.prompt = () => "追加一项";
  client.click("#task-list .add-todo");
  await client.saved();
  assert.equal((await state()).state.tasks[0].todos.at(-1).title, "追加一项");
  client.click("#task-list .todo-item:nth-child(3) .todo-remove");
  await client.saved();
  todos = (await state()).state.tasks[0].todos;
  assert.deepEqual(todos.map((todo) => todo.title), ["准备资料", "完成初稿", "追加一项"]);
  const reopened = await page();
  await reopened.ready();
  assert.equal(reopened.document.querySelectorAll("#task-list .todo-list input:checked").length, 2);
  client.click("#data-menu > summary");
  client.click("#export-data");
  const exported = JSON.parse(await client.downloads[0].text());
  assert.deepEqual(exported.state.tasks[0].todos, todos);
  exported.state.tasks[0].title = "导入的论文任务";
  const fileInput = d.getElementById("import-file");
  Object.defineProperty(fileInput, "files", { configurable: true, value: [{ size: 1000, text: async () => JSON.stringify(exported) }] });
  fileInput.dispatchEvent(new w.Event("change"));
  await until(() => d.querySelector("#task-list .title").textContent === "导入的论文任务");
  await client.saved();
  assert.deepEqual((await state()).state.tasks[0].todos, todos);
});

test("旧服务不支持子任务时保持只读，避免新清单被旧后端丢弃", async (t) => {
  const { page, state } = await fixture(t);
  const client = await page({ intercept: async () => ({ ok: true, json: async () => ({
    schemaVersion: 1, revision: 0, initialized: false, state: emptyState(),
  }) }) });
  await until(() => client.status().includes("重启 Node.js 服务"));
  assert.equal(client.document.getElementById("task-title").disabled, true);
  assert.equal(client.document.getElementById("task-todo-input").disabled, true);
  client.task("不能提交到旧服务");
  assert.equal((await state()).initialized, false);
});

test("单次任务必须勾选全部子任务才能完成，恢复和编辑仍可使用", async (t) => {
  const { page, state } = await fixture(t);
  const client = await page();
  await client.ready();
  client.task("带清单的任务");
  await client.saved();
  const { document: d, window: w } = client;
  assert.equal(d.querySelector(".complete").disabled, false, "没有子任务可直接完成");
  for (const title of ["第一项", "第二项"]) {
    w.prompt = () => title;
    client.click(".add-todo");
    await client.saved();
  }
  assert.equal(d.querySelector(".complete").disabled, true);
  assert.equal(d.querySelector(".completion-hint").hidden, false);
  assert.match(d.querySelector(".completion-hint").textContent, /2 项/);
  const before = await state();
  client.click(".complete");
  d.querySelector(".complete").dispatchEvent(new w.Event("click"));
  assert.deepEqual(await state(), before, "绕过按钮禁用也不能完成或加分");
  w.prompt = () => "17";
  client.click("#task-list .points-badge");
  await client.saved();
  assert.equal((await state()).state.tasks[0].points, 17, "清单未完成时仍可修改积分");
  const reopened = await page();
  await reopened.ready();
  assert.equal(reopened.document.querySelector(".complete").disabled, true);
  client.click(".todo-item:first-child input");
  await client.saved();
  assert.equal(d.querySelector(".complete").disabled, true);
  assert.match(d.querySelector(".completion-hint").textContent, /1 项/);
  client.click(".todo-item:nth-child(2) input");
  await client.saved();
  assert.equal(d.querySelector(".complete").disabled, false);
  assert.equal(d.querySelector(".completion-hint").hidden, true);
  client.click(".complete");
  await client.saved();
  assert.equal((await state()).state.totalEarnedPoints, 17);
  assert.equal((await state()).state.tasks[0].completed, true);
  client.click(".todo-item:first-child input");
  await client.saved();
  assert.equal(d.querySelector(".complete").textContent, "恢复");
  assert.equal(d.querySelector(".complete").disabled, false, "取消勾选后仍能恢复主任务");
  client.click(".complete");
  await client.saved();
  assert.equal((await state()).state.totalEarnedPoints, 0);
  assert.equal(d.querySelector(".complete").disabled, true);
  client.click(".todo-item:first-child .todo-remove");
  await client.saved();
  assert.equal(d.querySelector(".complete").disabled, false, "删除唯一未完成子任务后立即解锁");
  client.click(".todo-remove");
  await client.saved();
  assert.equal((await state()).state.tasks[0].todos.length, 0);
  assert.equal(d.querySelector(".complete").disabled, false);
});

test("长期任务的完成和再次完成都受子任务勾选状态约束", async (t) => {
  const { page, state } = await fixture(t);
  const client = await page();
  await client.ready();
  client.task("长期清单", "long-term");
  await client.saved();
  const { document: d, window: w } = client;
  w.prompt = () => "必须完成的步骤";
  client.click(".add-todo");
  await client.saved();
  assert.equal(d.querySelector(".complete").disabled, true);
  d.querySelector(".complete").dispatchEvent(new w.Event("click"));
  assert.equal((await state()).state.tasks[0].completionCount, 0);
  client.click(".todo-item input");
  await client.saved();
  client.click(".complete");
  await client.saved();
  assert.equal((await state()).state.tasks[0].completionCount, 1);
  assert.equal((await state()).state.totalEarnedPoints, 10);
  assert.equal(d.querySelector(".complete").textContent, "再次完成");
  client.click(".todo-item input");
  await client.saved();
  assert.equal(d.querySelector(".complete").disabled, true);
  const before = await state();
  d.querySelector(".complete").dispatchEvent(new w.Event("click"));
  assert.deepEqual(await state(), before, "未全部勾选不能增加完成次数及积分");
  client.click(".todo-item input");
  await client.saved();
  assert.equal(d.querySelector(".complete").disabled, false);
  client.click(".complete");
  await client.saved();
  assert.equal((await state()).state.tasks[0].completionCount, 2);
  assert.equal((await state()).state.totalEarnedPoints, 20);
});

test("任务卡片独立折叠，子任务和任务编辑后保留展开状态", async (t) => {
  const { page, state } = await fixture(t);
  const client = await page();
  await client.ready();
  client.task("任务甲");
  await client.saved();
  client.task("任务乙");
  await client.saved();
  const { document: d, window: w } = client;
  const initial = await state();
  const [second, first] = initial.state.tasks;
  const card = (id) => Array.from(d.querySelectorAll(".task-card")).find((node) => node.dataset.taskId === id);
  assert.equal(card(first.id).open, false);
  assert.equal(card(second.id).open, false);
  card(first.id).querySelector(".title").click();
  assert.equal(card(first.id).open, true, "点击标题展开而不是修改任务名");
  card(second.id).querySelector("summary").click();
  assert.equal(card(first.id).open, true);
  assert.equal(card(second.id).open, true);
  card(first.id).querySelector("summary").click();
  assert.equal(card(first.id).open, false);
  assert.equal(card(second.id).open, true);
  assert.deepEqual(await state(), initial, "仅折叠展开不保存或改动任务数据");
  w.prompt = () => "任务乙的步骤";
  card(second.id).querySelector(".add-todo").click();
  await client.saved();
  assert.equal(card(first.id).open, false);
  assert.equal(card(second.id).open, true, "新增子任务后保持展开");
  assert.equal(card(second.id).querySelector(".task-todo-summary").textContent, "子任务 0/1");
  card(second.id).querySelector(".todo-item input").click();
  await client.saved();
  assert.equal(card(second.id).open, true);
  assert.equal(card(second.id).querySelector(".task-todo-summary").textContent, "子任务 1/1");
  w.prompt = () => "任务乙改名";
  card(second.id).querySelector(".rename-task").click();
  await client.saved();
  assert.equal(card(second.id).open, true);
  assert.equal(card(second.id).querySelector(".title").textContent, "任务乙改名");
  w.prompt = () => "17";
  card(second.id).querySelector(".points-badge").click();
  await client.saved();
  assert.equal(card(second.id).open, true);
  assert.equal(card(second.id).querySelector(".task-points-summary").textContent, "+17 分");
  card(second.id).querySelector(".complete").click();
  await client.saved();
  assert.equal(card(second.id).open, true);
  assert.equal(card(second.id).querySelector(".task-status").textContent, "已完成");
  client.task("新插入的任务");
  await client.saved();
  const newest = (await state()).state.tasks[0];
  assert.equal(card(newest.id).open, false);
  assert.equal(card(second.id).open, true, "插入新任务不改变其他任务的展开状态");
  assert.equal(card(first.id).open, false);
  const reopened = await page();
  await reopened.ready();
  assert.ok(Array.from(reopened.document.querySelectorAll(".task-card")).every((node) => !node.open));
});
