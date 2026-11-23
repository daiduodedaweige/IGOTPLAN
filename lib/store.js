"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { SCHEMA_VERSION, emptyState, validateState, validateDocument } = require("../state-model");

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function writeAtomic(filename, value, logger = console) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(JSON.stringify(value, null, 2) + "\n");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, filename);
    // Some NFS implementations cannot fsync directories. The file was synced
    // before rename; report directory-sync limitations without claiming rollback.
    let directory;
    try {
      directory = await fs.open(path.dirname(filename), "r");
      await directory.sync();
    } catch (error) { logger.warn(`目录同步未完成 (${error.code || "IO_ERROR"})，请保留独立备份。`); }
    finally { await directory?.close(); }
  } finally {
    await handle?.close();
    await fs.rm(temporary, { force: true });
  }
}

class Store {
  constructor(dataDir, { backupKeep = 30, logger = console } = {}) {
    this.dir = path.resolve(dataDir);
    this.file = path.join(this.dir, "state.json");
    this.backups = path.join(this.dir, "backups");
    this.lock = path.join(this.dir, ".writer-lock");
    this.owner = { hostname: os.hostname(), pid: process.pid, token: randomUUID(), createdAt: new Date().toISOString() };
    this.backupKeep = backupKeep;
    this.logger = logger;
    this.queue = Promise.resolve();
    this.seenFile = false;
    this.failure = null;
    this.locked = false;
  }
  async open() {
    try { this.owner.pidNamespace = await fs.readlink("/proc/self/ns/pid"); }
    catch { this.owner.pidNamespace = "unknown"; }
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    this.dir = await fs.realpath(this.dir);
    this.file = path.join(this.dir, "state.json");
    this.backups = path.join(this.dir, "backups");
    this.lock = path.join(this.dir, ".writer-lock");
    await fs.chmod(this.dir, 0o700);
    await fs.access(this.dir, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
    await this.acquireLock();
    try {
      await fs.mkdir(this.backups, { recursive: true, mode: 0o700 });
      if ((await fs.lstat(this.backups)).isSymbolicLink()) throw new Error("备份目录不能是符号链接");
      await fs.chmod(this.backups, 0o700);
      try { await this.readDisk(); }
      catch (error) { this.logger.error(`数据读取失败，已禁止自动写入 (${error.code || "INVALID_DATA"})。`); }
      return this;
    } catch (error) { await this.close(); throw error; }
  }
  async acquireLock() {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await fs.mkdir(this.lock, { mode: 0o700 });
        await fs.writeFile(path.join(this.lock, "owner.json"), JSON.stringify(this.owner), { flag: "wx", mode: 0o600 });
        this.locked = true;
        return;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        let owner;
        try { owner = JSON.parse(await fs.readFile(path.join(this.lock, "owner.json"), "utf8")); }
        catch { throw new Error("数据目录存在未完成的写入锁，请确认没有服务运行后检查 .writer-lock。"); }
        if (owner.hostname !== os.hostname() || owner.pidNamespace !== this.owner.pidNamespace || this.owner.pidNamespace === "unknown" || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !/^[a-f0-9-]{36}$/.test(owner.token)) throw new Error("数据目录已被其他主机、进程命名空间或未知进程锁定。");
        try { process.kill(owner.pid, 0); }
        catch (cause) {
          if (cause.code !== "ESRCH") throw new Error("无法确认旧进程状态，保留写入锁。");
          // Keep the nonempty tombstone: concurrent reclaimers of this exact
          // generation cannot rename a new owner's lock over it (ENOTEMPTY).
          const tombstone = path.join(this.dir, `.stale-lock-${owner.token}`);
          try { await fs.rename(this.lock, tombstone); }
          catch (moveError) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(moveError.code)) throw moveError; }
          continue;
        }
        throw new Error("已有进程使用此数据目录，请先停止原服务。");
      }
    }
    throw new Error("无法取得数据目录写入锁，请稍后重试。");
  }
  enqueue(work) {
    const result = this.queue.then(work);
    this.queue = result.catch(() => {});
    return result;
  }
  async readDisk() {
    if (this.failure) throw new HttpError(503, this.failure);
    try {
      const stat = await fs.lstat(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error("Invalid state file");
      await fs.chmod(this.file, 0o600);
      const document = validateDocument(JSON.parse(await fs.readFile(this.file, "utf8")));
      this.seenFile = true;
      return { initialized: true, ...document };
    } catch (error) {
      if (error.code === "ENOENT" && !this.seenFile) return { initialized: false, schemaVersion: SCHEMA_VERSION, revision: 0, updatedAt: null, state: emptyState() };
      this.failure = "服务器数据无法读取，已停止自动写入。请保留原文件并按恢复文档处理。";
      throw new HttpError(503, this.failure);
    }
  }
  read() { return this.enqueue(() => this.readDisk()); }
  save(expectedRevision, input) {
    return this.enqueue(async () => {
      const current = await this.readDisk();
      if (expectedRevision !== current.revision) throw new HttpError(409, "其他页面已修改数据，请先导出本地修改，再重新加载服务器数据。");
      const state = validateState(input);
      const document = validateDocument({ schemaVersion: SCHEMA_VERSION, revision: current.revision + 1, updatedAt: new Date().toISOString(), state });
      if (Buffer.byteLength(JSON.stringify(document, null, 2) + "\n") > 2 * 1024 * 1024) throw new HttpError(413, "格式化后的存储数据超过 2 MiB 限制");
      if (current.initialized) await this.archive(current, "revision");
      await writeAtomic(this.file, document, this.logger);
      this.seenFile = true;
      await this.prune().catch((error) => this.logger.warn(`旧备份清理失败 (${error.code || "IO_ERROR"})。`));
      return { initialized: true, ...document };
    });
  }
  async archive(document, prefix) {
    const filename = `${prefix}-${String(document.revision).padStart(16, "0")}-${randomUUID()}.json`;
    await writeAtomic(path.join(this.backups, filename), validateDocument(document), this.logger);
  }
  async prune() {
    const names = (await fs.readdir(this.backups)).filter((name) => /^revision-\d{16}-[a-f0-9-]+\.json$/.test(name)).sort().reverse();
    for (const name of names.slice(this.backupKeep)) await fs.unlink(path.join(this.backups, name));
  }
  restore(input) {
    return this.enqueue(async () => {
      const restored = validateDocument(input);
      if (Buffer.byteLength(JSON.stringify(restored, null, 2) + "\n") > 2 * 1024 * 1024) throw new Error("恢复后的存储文件超过 2 MiB 限制");
      let revision = 0;
      try {
        const raw = await fs.readFile(this.file);
        const preserved = path.join(this.backups, `before-restore-${Date.now()}-${randomUUID()}.json`);
        await fs.writeFile(preserved, raw, { flag: "wx", mode: 0o600, flush: true });
        try { revision = validateDocument(JSON.parse(raw)).revision; } catch { /* Preserve damaged files too. */ }
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      const document = validateDocument({ ...restored, revision: Math.max(Date.now(), revision + 1, restored.revision + 1), updatedAt: new Date().toISOString() });
      if (Buffer.byteLength(JSON.stringify(document, null, 2) + "\n") > 2 * 1024 * 1024) throw new Error("恢复后的存储文件超过 2 MiB 限制");
      await writeAtomic(this.file, document, this.logger);
      this.seenFile = true;
      this.failure = null;
      return document;
    });
  }
  async close() {
    await this.queue;
    if (!this.locked) return;
    const owner = JSON.parse(await fs.readFile(path.join(this.lock, "owner.json"), "utf8"));
    if (owner.token !== this.owner.token) throw new Error("写入锁已改变，拒绝删除其他进程的锁。");
    const released = path.join(this.dir, `.released-lock-${this.owner.token}`);
    await fs.rename(this.lock, released);
    this.locked = false;
    await fs.rm(released, { recursive: true });
  }
}
module.exports = { Store, HttpError, writeAtomic };
