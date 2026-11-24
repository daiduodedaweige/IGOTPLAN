"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomBytes, timingSafeEqual } = require("node:crypto");

const CREDENTIALS_FILE = "access.json";
function newCredentials() {
  return { username: "plan", password: randomBytes(32).toString("base64url") };
}
function validateCredentials(value) {
  if (!value || !/^[A-Za-z0-9_-]{1,64}$/.test(value.username) ||
      typeof value.password !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(value.password)) {
    throw new Error("访问凭据无效，请停止服务后运行 npm run credentials -- reset。");
  }
  return { username: value.username, password: value.password };
}
async function loadCredentials(directory, { create = false } = {}) {
  const filename = path.join(directory, CREDENTIALS_FILE);
  if (create) {
    // The server holds the data writer lock while creating credentials.
    let file;
    try {
      file = await fs.open(filename, "wx", 0o600);
      await file.writeFile(JSON.stringify(newCredentials(), null, 2) + "\n");
      await file.sync();
    } catch (error) { if (error.code !== "EEXIST") throw error; }
    finally { await file?.close(); }
  }
  const file = await fs.open(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) !== 0 ||
        (process.getuid && stat.uid !== process.getuid())) {
      throw new Error("访问凭据必须是当前用户所有、权限为 0600 的普通文件。");
    }
    return validateCredentials(JSON.parse(await file.readFile("utf8")));
  } finally { await file.close(); }
}
function authorizationHeader(credentials) {
  const { username, password } = validateCredentials(credentials);
  return "Basic " + Buffer.from(`${username}:${password}`, "utf8").toString("base64");
}
function createAuthenticator(credentials) {
  const expected = createHash("sha256").update(authorizationHeader(credentials).slice(6)).digest();
  return (header) => {
    if (typeof header !== "string" || !/^Basic [A-Za-z0-9+/]+={0,2}$/i.test(header)) return false;
    const actual = createHash("sha256").update(header.slice(6)).digest();
    return timingSafeEqual(expected, actual);
  };
}
module.exports = { CREDENTIALS_FILE, newCredentials, loadCredentials, authorizationHeader, createAuthenticator };
