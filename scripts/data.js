"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { Store, writeAtomic } = require("../lib/store");
const { validateDocument } = require("../state-model");
const { loadCredentials, authorizationHeader } = require("../lib/auth");

async function backup(destination, url = process.env.API_URL || "http://127.0.0.1:8000") {
  if (!destination) throw new Error("请指定独立备份目录：npm run backup -- /绝对路径/备份目录");
  const endpoint = new URL("/api/state", url);
  if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) || endpoint.username || endpoint.password) {
    throw new Error("备份接口必须使用本机 HTTP 地址，避免向其他主机发送访问凭据。");
  }
  const directoryForCredentials = path.resolve(__dirname, "..", process.env.DATA_DIR || "data");
  const credentials = await loadCredentials(directoryForCredentials);
  const response = await fetch(endpoint, {
    signal: AbortSignal.timeout(15000), redirect: "error",
    headers: { Authorization: authorizationHeader(credentials) },
  });
  if (!response.ok) throw new Error(`无法读取服务器数据 (${response.status})`);
  const input = await response.json();
  if (input.initialized === false) { console.log("服务器尚未初始化，无需备份。"); return; }
  const document = validateDocument(input);
  const directory = path.resolve(destination);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error("备份目录不能是符号链接");
  const actualDirectory = await fs.realpath(directory);
  const assets = await fs.realpath(path.resolve(__dirname, "..", "assets"));
  if (actualDirectory === assets || actualDirectory.startsWith(assets + path.sep)) throw new Error("备份目录不能位于公开静态资源目录中");
  await fs.chmod(directory, 0o700);
  const filename = `snapshot-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.json`;
  await writeAtomic(path.join(directory, filename), document);
  const names = (await fs.readdir(directory)).filter((name) => /^snapshot-[\dTZ-]+-[a-f0-9-]{36}\.json$/.test(name)).sort().reverse();
  for (const old of names.slice(30)) await fs.unlink(path.join(directory, old));
  console.log(`备份完成：${path.join(directory, filename)}`);
}

async function restore(filename) {
  if (!filename) throw new Error("请先停止网站，再指定备份文件：npm run restore -- /绝对路径/备份.json");
  const stat = await fs.stat(filename);
  if (stat.size > 2 * 1024 * 1024) throw new Error("备份文件过大");
  const document = validateDocument(JSON.parse(await fs.readFile(filename, "utf8")));
  const directory = path.resolve(__dirname, "..", process.env.DATA_DIR || "data");
  const store = await new Store(directory).open();
  try {
    const result = await store.restore(document);
    console.log(`恢复完成，新版本：${result.revision}。原文件已保留在 data/backups 的 before-restore 文件中（如原文件存在）。`);
  } finally { await store.close(); }
}
if (require.main === module) {
  process.umask(0o077);
  const [command, argument] = process.argv.slice(2);
  const action = command === "backup" ? () => backup(argument || process.env.BACKUP_DEST) : command === "restore" ? () => restore(argument) : () => { throw new Error("用法：data.js backup <目录> | restore <备份文件>"); };
  Promise.resolve().then(action).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { backup, restore };
