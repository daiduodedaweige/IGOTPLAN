(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PlanData = factory();
})(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";
  const SCHEMA_VERSION = 2;
  const MAX_ITEMS = 5000;
  const MAX_TODOS = 100;
  const MAX_VALUE = 1000000000;
  function emptyState() {
    return { tasks: [], rewards: [], totalEarnedPoints: 0, totalSpentPoints: 0 };
  }
  function object(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}格式无效`);
  }
  function integer(value, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label}必须是 ${min} 到 ${max} 之间的整数`);
  }
  function string(value, label, max, required = false) {
    if (typeof value !== "string" || value.length > max || (required && !value.trim())) throw new Error(`${label}格式无效或过长`);
  }
  function timestamp(value, label) {
    string(value, label, 40);
    if (value !== "" && !Number.isFinite(Date.parse(value))) throw new Error(`${label}无效`);
  }
  function validateTodos(value = []) {
    if (!Array.isArray(value) || value.length > MAX_TODOS) throw new Error(`每个任务最多添加 ${MAX_TODOS} 项子任务`);
    const ids = new Set();
    return value.map((todo) => {
      object(todo, "子任务");
      string(todo.id, "子任务编号", 128, true);
      if (ids.has(todo.id)) throw new Error("子任务编号重复");
      ids.add(todo.id);
      string(todo.title, "子任务内容", 80, true);
      if (typeof todo.completed !== "boolean") throw new Error("子任务完成状态无效");
      return { id: todo.id, title: todo.title, completed: todo.completed };
    });
  }
  function validateState(input) {
    object(input, "数据");
    integer(input.totalEarnedPoints, "获得积分");
    integer(input.totalSpentPoints, "已花费积分");
    for (const key of ["tasks", "rewards"]) {
      if (!Array.isArray(input[key]) || input[key].length > MAX_ITEMS) throw new Error(`${key}必须是最多 ${MAX_ITEMS} 项的数组`);
      const ids = new Set();
      for (const item of input[key]) {
        object(item, key);
        string(item.id, "记录编号", 128, true);
        if (ids.has(item.id)) throw new Error("记录编号重复");
        ids.add(item.id);
        string(item.title, "标题", 80, true);
        string(item.notes, "备注", 10000);
        if (key === "tasks") {
          string(item.date, "日期", 10);
          if (item.date !== "" && (!/^\d{4}-\d{2}-\d{2}$/.test(item.date) || !Number.isFinite(Date.parse(item.date)) || new Date(item.date).toISOString().slice(0, 10) !== item.date)) throw new Error("任务日期无效");
          integer(item.points, "任务积分", 1, MAX_VALUE);
          if (!["single", "long-term"].includes(item.type) || typeof item.completed !== "boolean") throw new Error("任务状态无效");
          integer(item.completionCount, "完成次数", 0, MAX_VALUE);
          timestamp(item.completedAt, "完成时间");
        } else {
          integer(item.cost, "奖励积分", 1, MAX_VALUE);
          for (const field of ["quantity", "initialQuantity", "redeemedCount"]) integer(item[field], "奖励数量", 0, MAX_VALUE);
          timestamp(item.redeemedAt, "兑换时间");
        }
      }
    }
    // Only persist known fields, so imports cannot inject extra document properties.
    return {
      tasks: input.tasks.map(({ id, date, title, notes, todos, points, type, completed, completionCount, completedAt }) => ({ id, date, title, notes, todos: validateTodos(todos), points, type, completed, completionCount, completedAt })),
      rewards: input.rewards.map(({ id, title, notes, cost, quantity, initialQuantity, redeemedCount, redeemedAt }) => ({ id, title, notes, cost, quantity, initialQuantity, redeemedCount, redeemedAt })),
      totalEarnedPoints: input.totalEarnedPoints,
      totalSpentPoints: input.totalSpentPoints,
    };
  }
  function parseImport(input) {
    if (input?.schemaVersion !== undefined && ![1, SCHEMA_VERSION].includes(input.schemaVersion)) throw new Error("不支持此数据版本");
    let value = input?.state ?? input;
    const legacy = Array.isArray(value);
    if (legacy) value = { ...emptyState(), tasks: value };
    object(value, "导入数据");
    if (!Array.isArray(value.tasks) || (!legacy && !Array.isArray(value.rewards))) throw new Error("导入文件缺少任务或奖励数组");
    const next = {
      tasks: value.tasks.map((item) => {
        object(item, "任务");
        const completed = legacy ? false : (item.completed ?? false);
        return {
          id: item.id || globalThis.crypto.randomUUID(), date: item.date ?? "", title: item.title,
          notes: item.notes ?? "", todos: item.todos, points: legacy ? 10 : item.points,
          type: legacy ? "single" : (item.type ?? "single"), completed,
          completionCount: legacy ? 0 : (item.completionCount ?? (completed ? 1 : 0)),
          completedAt: legacy ? "" : (item.completedAt ?? ""),
        };
      }),
      rewards: (value.rewards ?? []).map((item) => {
        object(item, "奖励");
        return { id: item.id || globalThis.crypto.randomUUID(), title: item.title, notes: item.notes ?? "",
          cost: item.cost, quantity: item.quantity ?? 1,
          initialQuantity: item.initialQuantity ?? ((item.quantity ?? 1) + (item.redeemedCount ?? 0)),
          redeemedCount: item.redeemedCount ?? 0, redeemedAt: item.redeemedAt ?? "" };
      }),
      totalEarnedPoints: value.totalEarnedPoints ?? 0, totalSpentPoints: value.totalSpentPoints ?? 0,
    };
    return validateState(next);
  }
  function validateDocument(doc) {
    object(doc, "存储文件");
    if (![1, SCHEMA_VERSION].includes(doc.schemaVersion)) throw new Error("存储文件版本无效");
    integer(doc.revision, "数据版本", 1);
    timestamp(doc.updatedAt, "保存时间");
    if (!doc.updatedAt) throw new Error("缺少保存时间");
    return { schemaVersion: SCHEMA_VERSION, revision: doc.revision, updatedAt: doc.updatedAt, state: validateState(doc.state) };
  }
  return { SCHEMA_VERSION, MAX_VALUE, MAX_TODOS, emptyState, validateState, validateDocument, parseImport };
});
