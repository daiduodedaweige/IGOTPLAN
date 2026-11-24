"use strict";
const path = require("node:path");
const { Store, writeAtomic } = require("../lib/store");
const { CREDENTIALS_FILE, newCredentials, loadCredentials } = require("../lib/auth");

async function main() {
  process.umask(0o077);
  const directory = path.resolve(__dirname, "..", process.env.DATA_DIR || "data");
  const command = process.argv[2] || "show";
  if (command === "reset") {
    // Reset only while the app is stopped; the same lock protects credentials and data.
    const store = await new Store(directory).open();
    try { await writeAtomic(path.join(store.dir, CREDENTIALS_FILE), newCredentials()); }
    finally { await store.close(); }
    console.log("访问密码已重置，重新启动服务后使用新密码登录。");
  } else if (command !== "show") {
    throw new Error("用法：npm run credentials -- [show|reset]");
  }
  const credentials = await loadCredentials(directory);
  console.log(`账号：${credentials.username}\n密码：${credentials.password}`);
}
main().catch((error) => {
  console.error(error.code === "ENOENT" ? "尚无访问凭据，请先启动服务。" : error.message);
  process.exitCode = 1;
});
