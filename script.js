const STORAGE_KEY = "daily-plan-board:v2";
const LEGACY_STORAGE_KEY = "daily-plan-board:v1";
const RECOVERY_PREFIX = "daily-plan-board:pending:v1:";
const THEME_KEY = "daily-plan-board:theme";
const themeToggle = document.getElementById("theme-toggle");
const themeToggleLabel = document.getElementById("theme-toggle-label");
const statusNode = document.getElementById("save-status");
const dataMenu = document.getElementById("data-menu");
const dataActions = document.getElementById("data-actions");
const storageWarning = document.getElementById("storage-warning");
const retrySaveBtn = document.getElementById("retry-save");
const reloadDataBtn = document.getElementById("reload-data");
const exportDataBtn = document.getElementById("export-data");
const importDataBtn = document.getElementById("import-data");
const importFileInput = document.getElementById("import-file");
const importLegacyBtn = document.getElementById("import-legacy");
const exportLegacyBtn = document.getElementById("export-legacy");
const recoverySelect = document.getElementById("recovery-select");
const restorePendingBtn = document.getElementById("restore-pending");
const discardPendingBtn = document.getElementById("discard-pending");

const taskForm = document.getElementById("task-form");
const taskDateInput = document.getElementById("task-date");
const taskTitleInput = document.getElementById("task-title");
const taskTodoInput = document.getElementById("task-todo-input");
const taskTodoList = document.getElementById("task-todo-list");
const addTaskTodoBtn = document.getElementById("add-task-todo");
const taskTodoError = document.getElementById("task-todo-error");
const taskPointsInput = document.getElementById("task-points");
const taskTypeInput = document.getElementById("task-type");
const taskList = document.getElementById("task-list");
const clearTasksBtn = document.getElementById("clear-tasks");
const taskTemplate = document.getElementById("task-template");

const rewardForm = document.getElementById("reward-form");
const rewardTitleInput = document.getElementById("reward-title");
const rewardNotesInput = document.getElementById("reward-notes");
const rewardCostInput = document.getElementById("reward-cost");
const rewardQuantityInput = document.getElementById("reward-quantity");
const rewardList = document.getElementById("reward-list");
const clearRewardsBtn = document.getElementById("clear-rewards");
const rewardTemplate = document.getElementById("reward-template");

const availablePointsNode = document.getElementById("available-points");
const earnedPointsNode = document.getElementById("earned-points");
const spentPointsNode = document.getElementById("spent-points");
const resetPointsBtn = document.getElementById("reset-points");
const celebrationLayer = document.getElementById("celebration-layer");
const live2dDock = document.getElementById("live2d-dock");
const live2dCanvas = document.getElementById("live2d-canvas");
const live2dStatus = document.getElementById("live2d-status");
const LIVE2D_MODEL = {
  name: "Tororo",
  path: "assets/live2d/Tororo/Tororo.model3.json",
};
const LIVE2D_LAYOUT = {
  Tororo: {
    autoFit: true,
    x: 0.5,
    y: 0.98,
  },
  Mao: {
    scale: 0.16,
    x: 0.54,
    y: 1.02,
  },
  Hiyori: {
    scale: 0.16,
    x: 0.5,
    y: 1.34,
  },
};
const LIVE2D_FOCUS_GAIN = {
  x: 1.45,
  y: 1.2,
};

let state = PlanData.emptyState();
let ready = false;
let loading = false;
let dirty = false;
let saving = false;
let conflict = false;
let revision = 0;
let initialized = false;
let changeSequence = 0;
let saveError = "";
let choosingImport = false;
let legacyCandidate = null;
let recoveryCandidates = [];
let recoverySourceKey = null;
let draftTodos = [];
// A fresh key also keeps duplicated tabs from sharing a recovery record.
const recoveryKey = RECOVERY_PREFIX + crypto.randomUUID();
let live2dApp = null;
let live2dModel = null;

initialize();

function initialize() {
  initializeTheme();
  setToday();
  initializeLive2D();
  readLocalCandidates();
  render();
  void loadState();
}

function initializeTheme() {
  let theme = document.documentElement.dataset.theme;
  try { theme = localStorage.getItem(THEME_KEY) || theme; } catch {}
  applyTheme(theme === "dark" ? "dark" : "light");
  themeToggle.addEventListener("click", () => {
    const nextTheme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(nextTheme);
    try { localStorage.setItem(THEME_KEY, nextTheme); } catch {}
  });
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const dark = theme === "dark";
  const nextLabel = dark ? "浅色模式" : "深色模式";
  themeToggleLabel.textContent = nextLabel;
  themeToggle.setAttribute("aria-pressed", String(dark));
  themeToggle.title = `切换到${nextLabel}`;
}

taskForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!canEdit()) return;
  if (taskTodoInput.value.trim() && !addDraftTodo(false)) return;

  state.tasks.unshift({
    id: crypto.randomUUID(),
    date: taskDateInput.value,
    title: taskTitleInput.value.trim(),
    notes: "",
    todos: draftTodos.map((todo) => ({ ...todo })),
    points: parsePoints(taskPointsInput.value),
    type: normalizeTaskType(taskTypeInput.value),
    completed: false,
    completionCount: 0,
    completedAt: "",
  });

  persistState();
  render();
  taskForm.reset();
  draftTodos = [];
  renderDraftTodos();
  taskTodoError.hidden = true;
  setToday();
  taskPointsInput.value = "10";
  taskTypeInput.value = "single";
  closeCreationForm(taskForm);
});

addTaskTodoBtn.addEventListener("click", () => { addDraftTodo(); });
taskTodoInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.isComposing) {
    event.preventDefault();
    addDraftTodo();
  }
});
taskTodoInput.addEventListener("input", () => { taskTodoError.hidden = true; });

function addDraftTodo(focusInput = true) {
  if (!canEdit()) return false;
  const title = taskTodoInput.value.trim();
  if (!title) {
    taskTodoInput.focus();
    return false;
  }
  if (title.length > 80) {
    taskTodoError.textContent = "子任务内容不能超过 80 字。";
    taskTodoError.hidden = false;
    return false;
  }
  if (draftTodos.length >= PlanData.MAX_TODOS) {
    taskTodoError.textContent = `每个任务最多添加 ${PlanData.MAX_TODOS} 项子任务。`;
    taskTodoError.hidden = false;
    return false;
  }
  draftTodos.push({ id: crypto.randomUUID(), title, completed: false });
  taskTodoInput.value = "";
  taskTodoError.hidden = true;
  renderDraftTodos();
  if (focusInput) taskTodoInput.focus();
  return true;
}

function renderDraftTodos() {
  taskTodoList.replaceChildren(...draftTodos.map((todo) => createTodoRow(todo, (completed) => {
    todo.completed = completed;
  }, () => {
    draftTodos = draftTodos.filter((item) => item.id !== todo.id);
    taskTodoError.hidden = true;
    renderDraftTodos();
    taskTodoInput.focus();
  })));
  taskTodoList.hidden = draftTodos.length === 0;
  updateDataControls();
}

function createTodoRow(todo, onToggle, onRemove) {
  const row = document.createElement("li");
  row.className = "todo-item";
  row.classList.toggle("is-done", todo.completed);
  const label = document.createElement("label");
  label.className = "todo-label";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = todo.completed;
  checkbox.addEventListener("change", () => {
    if (!canEdit()) { checkbox.checked = todo.completed; return; }
    onToggle(checkbox.checked);
    row.classList.toggle("is-done", checkbox.checked);
  });
  const text = document.createElement("span");
  text.className = "todo-text";
  text.textContent = todo.title;
  label.append(checkbox, text);
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "ghost todo-remove";
  remove.textContent = "×";
  remove.title = "删除子任务";
  remove.setAttribute("aria-label", `删除子任务：${todo.title}`);
  remove.addEventListener("click", () => { if (canEdit()) onRemove(); });
  row.append(label, remove);
  return row;
}

rewardForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!canEdit()) return;

  state.rewards.unshift({
    id: crypto.randomUUID(),
    title: rewardTitleInput.value.trim(),
    notes: rewardNotesInput.value.trim(),
    cost: parsePoints(rewardCostInput.value),
    quantity: parseCount(rewardQuantityInput.value, 1),
    initialQuantity: parseCount(rewardQuantityInput.value, 1),
    redeemedCount: 0,
    redeemedAt: "",
  });

  persistState();
  render();
  rewardForm.reset();
  rewardCostInput.value = "20";
  rewardQuantityInput.value = "1";
  closeCreationForm(rewardForm);
});

function closeCreationForm(form) {
  const panel = form.closest("details");
  panel.open = false;
  panel.querySelector("summary").focus();
}

clearTasksBtn.addEventListener("click", () => {
  if (!canEdit()) return;
  if (!window.confirm("确定清空所有任务？")) return;
  state.tasks = [];
  persistState();
  render();
});

clearRewardsBtn.addEventListener("click", () => {
  if (!canEdit()) return;
  if (!window.confirm("确定清空所有奖励？")) return;
  state.rewards = [];
  persistState();
  render();
});

resetPointsBtn.addEventListener("click", () => {
  if (!canEdit()) return;
  if (!window.confirm("确定重置积分系统？")) return;
  resetPointsSystem();
});

function render() {
  renderSummary();
  renderTasks();
  renderRewards();
  updateDataControls();
}

function renderSummary() {
  const earned = state.totalEarnedPoints;
  const spent = state.totalSpentPoints;
  const available = earned - spent;

  earnedPointsNode.textContent = String(earned);
  spentPointsNode.textContent = String(spent);
  availablePointsNode.textContent = String(available);
}

function renderTasks() {
  const expandedIds = new Set(Array.from(taskList.querySelectorAll(".task-card[open]"), (card) => card.dataset.taskId));
  taskList.innerHTML = "";

  if (!state.tasks.length) {
    taskList.append(createEmptyNode("还没有任务"));
    return;
  }

  for (const task of state.tasks) {
    const node = taskTemplate.content.firstElementChild.cloneNode(true);
    node.dataset.taskId = task.id;
    node.open = expandedIds.has(task.id);
    node.querySelector(".date").textContent = formatDate(task.date);
    const taskTitle = node.querySelector(".title");
    taskTitle.textContent = task.title;
    taskTitle.title = "点击展开或收起任务";
    node.querySelector(".rename-task").addEventListener("click", () => promptTaskTitle(task.id));
    const notes = node.querySelector(".notes");
    if (task.notes) {
      notes.textContent = task.notes;
    } else {
      notes.hidden = true;
    }
    renderTaskTodos(task, node.querySelector(".task-todos"));
    const taskPointsBadge = node.querySelector(".points-badge");
    taskPointsBadge.textContent = `+${task.points} 分`;
    node.querySelector(".task-points-summary").textContent = `+${task.points} 分`;
    taskPointsBadge.title = "点击修改积分";
    taskPointsBadge.addEventListener("click", () => promptTaskPoints(task.id));
    const typeBadge = node.querySelector(".type-badge");
    typeBadge.textContent = task.type === "long-term" ? "长期任务" : "单次任务";
    typeBadge.classList.add(task.type === "long-term" ? "type-long-term" : "type-single");
    const progress = node.querySelector(".task-progress");
    node.querySelector(".task-status").textContent = task.type === "long-term"
      ? `已完成 ${task.completionCount} 次`
      : task.completed ? "已完成" : "待完成";
    const hasStamp = task.type === "single" ? task.completed : task.completionCount > 0;
    const stamp = node.querySelector(".completion-stamp");
    stamp.hidden = !hasStamp;
    stamp.setAttribute("aria-label", task.type === "long-term" ? `已完成 ${task.completionCount} 次` : "已完成");
    const stampCount = stamp.querySelector(".stamp-count");
    stampCount.hidden = task.type !== "long-term";
    stampCount.textContent = `${task.completionCount} 次`;
    node.querySelector(".task-status").hidden = hasStamp;

    if (task.type === "long-term") {
      progress.hidden = false;
      progress.textContent =
        task.completionCount > 0
          ? `已完成 ${task.completionCount} 次`
          : "未完成";
    } else {
      progress.hidden = true;
    }

    if (task.type === "single" && task.completed) {
      node.classList.add("is-complete");
    }

    const completeBtn = node.querySelector(".complete");
    completeBtn.dataset.taskId = task.id;
    if (task.type === "long-term") {
      completeBtn.textContent = task.completionCount > 0 ? "再次完成" : "完成";
      completeBtn.addEventListener("click", () => completeLongTermTask(task.id));
    } else if (task.completed) {
      completeBtn.textContent = "恢复";
      completeBtn.classList.add("undo");
      completeBtn.addEventListener("click", () => toggleSingleTaskComplete(task.id));
    } else {
      completeBtn.textContent = "完成";
      completeBtn.addEventListener("click", () => toggleSingleTaskComplete(task.id));
    }

    node.querySelector(".danger").addEventListener("click", () => {
      if (!canEdit()) return;
      state.tasks = state.tasks.filter((item) => item.id !== task.id);
      persistState();
      render();
    });

    taskList.append(node);
  }
}

function renderTaskTodos(task, section) {
  const list = section.querySelector(".todo-list");
  const progress = section.querySelector(".todo-progress");
  const summary = section.closest(".task-card").querySelector(".task-todo-summary");
  const updateProgress = () => {
    const done = task.todos.filter((todo) => todo.completed).length;
    progress.textContent = task.todos.length ? `子任务 ${done}/${task.todos.length}` : "TodoList";
    summary.textContent = progress.textContent;
    summary.hidden = task.todos.length === 0;
  };
  updateProgress();
  list.hidden = task.todos.length === 0;
  for (const todo of task.todos) {
    list.append(createTodoRow(todo, (completed) => {
      todo.completed = completed;
      updateProgress();
      persistState();
      updateDataControls();
    }, () => {
      task.todos = task.todos.filter((item) => item.id !== todo.id);
      persistState();
      render();
    }));
  }
  section.querySelector(".add-todo").addEventListener("click", () => {
    if (!canEdit()) return;
    if (task.todos.length >= PlanData.MAX_TODOS) {
      window.alert(`每个任务最多添加 ${PlanData.MAX_TODOS} 项子任务。`);
      return;
    }
    const value = window.prompt("添加子任务（最多 80 字）");
    if (value === null || !value.trim()) return;
    const title = value.trim();
    if (title.length > 80) { window.alert("子任务内容不能超过 80 字。"); return; }
    task.todos.push({ id: crypto.randomUUID(), title, completed: false });
    persistState();
    render();
  });
}

function renderRewards() {
  rewardList.innerHTML = "";

  if (!state.rewards.length) {
    rewardList.append(createEmptyNode("还没有奖励"));
    return;
  }

  const availablePoints = getAvailablePoints();

  for (const reward of state.rewards) {
    const node = rewardTemplate.content.firstElementChild.cloneNode(true);
    const rewardTitle = node.querySelector(".title");
    rewardTitle.textContent = reward.title;
    rewardTitle.title = "点击修改奖励名";
    rewardTitle.addEventListener("click", () => promptRewardTitle(reward.id));
    const notes = node.querySelector(".notes");
    if (reward.notes) {
      notes.textContent = reward.notes;
    } else {
      notes.hidden = true;
    }
    const rewardPointsBadge = node.querySelector(".points-badge");
    rewardPointsBadge.textContent = `-${reward.cost} 分`;
    rewardPointsBadge.title = "点击修改所需积分";
    rewardPointsBadge.addEventListener("click", () => promptRewardCost(reward.id));
    const stockBadge = node.querySelector(".stock-badge");
    stockBadge.textContent = `数量 ${reward.quantity}`;
    stockBadge.title = "点击修改数量";
    stockBadge.addEventListener("click", () => promptRewardQuantity(reward.id));
    node.querySelector(".redeemed-count").textContent =
      reward.redeemedCount > 0
        ? `已兑换 ${reward.redeemedCount} 次`
        : "未兑换";

    const status = node.querySelector(".reward-status");
    if (reward.quantity <= 0) {
      status.textContent = "已兑完";
    } else {
      status.textContent = availablePoints >= reward.cost ? "可兑换" : "积分不足";
    }

    const redeemBtn = node.querySelector(".redeem");
    redeemBtn.textContent = "兑换";
    redeemBtn.addEventListener("click", () => redeemReward(reward.id));

    node.querySelector(".danger").addEventListener("click", () => {
      if (!canEdit()) return;
      state.rewards = state.rewards.filter((item) => item.id !== reward.id);
      persistState();
      render();
    });

    rewardList.append(node);
  }
}

function toggleSingleTaskComplete(taskId) {
  if (!canEdit()) return;
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return;

  if (task.completed) {
    task.completed = false;
    task.completionCount = 0;
    task.completedAt = "";
    state.totalEarnedPoints = Math.max(0, state.totalEarnedPoints - task.points);
  } else {
    if (!allTaskTodosComplete(task)) return;
    task.completed = true;
    task.completionCount = 1;
    task.completedAt = new Date().toISOString();
    state.totalEarnedPoints += task.points;
  }

  persistState();
  render();
  if (task.completed) animateTaskStamp(taskId);
}

function completeLongTermTask(taskId) {
  if (!canEdit()) return;
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task || task.type !== "long-term") return;
  if (!allTaskTodosComplete(task)) return;

  task.completionCount += 1;
  task.completedAt = new Date().toISOString();
  state.totalEarnedPoints += task.points;

  persistState();
  render();
  animateTaskStamp(taskId);
}

function animateTaskStamp(taskId) {
  const card = Array.from(taskList.querySelectorAll(".task-card")).find((node) => node.dataset.taskId === taskId);
  card?.querySelector(".completion-stamp")?.classList.add("is-stamping");
}

function updateTaskPoints(taskId, value) {
  if (!canEdit()) return;
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return;

  const nextPoints = parsePoints(value);
  const delta = nextPoints - task.points;
  task.points = nextPoints;

  if (task.type === "long-term" && task.completionCount > 0) {
    state.totalEarnedPoints = Math.max(0, state.totalEarnedPoints + delta * task.completionCount);
  } else if (task.completed) {
    state.totalEarnedPoints = Math.max(0, state.totalEarnedPoints + delta);
  }

  persistState();
  render();
}

function allTaskTodosComplete(task) {
  return task.todos.every((todo) => todo.completed);
}

function updateTaskTitle(taskId, value) {
  if (!canEdit()) return;
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return;

  task.title = normalizeTitle(value, task.title);
  persistState();
  render();
}

function promptTaskTitle(taskId) {
  if (!canEdit()) return;
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return;

  const nextValue = window.prompt("修改任务名", String(task.title));
  if (nextValue === null) return;
  updateTaskTitle(taskId, nextValue);
}

function promptTaskPoints(taskId) {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return;

  const nextValue = window.prompt("修改积分", String(task.points));
  if (nextValue === null) return;
  updateTaskPoints(taskId, nextValue);
}

function updateRewardCost(rewardId, value) {
  if (!canEdit()) return;
  const reward = state.rewards.find((item) => item.id === rewardId);
  if (!reward) return;

  reward.cost = parsePoints(value);
  persistState();
  render();
}

function updateRewardTitle(rewardId, value) {
  if (!canEdit()) return;
  const reward = state.rewards.find((item) => item.id === rewardId);
  if (!reward) return;

  reward.title = normalizeTitle(value, reward.title);
  persistState();
  render();
}

function promptRewardTitle(rewardId) {
  if (!canEdit()) return;
  const reward = state.rewards.find((item) => item.id === rewardId);
  if (!reward) return;

  const nextValue = window.prompt("修改奖励名", String(reward.title));
  if (nextValue === null) return;
  updateRewardTitle(rewardId, nextValue);
}

function updateRewardQuantity(rewardId, value) {
  if (!canEdit()) return;
  const reward = state.rewards.find((item) => item.id === rewardId);
  if (!reward) return;

  reward.quantity = parseCount(value, 0);
  reward.initialQuantity = reward.quantity;
  persistState();
  render();
}

function promptRewardCost(rewardId) {
  if (!canEdit()) return;
  const reward = state.rewards.find((item) => item.id === rewardId);
  if (!reward) return;

  const nextValue = window.prompt("修改所需积分", String(reward.cost));
  if (nextValue === null) return;
  updateRewardCost(rewardId, nextValue);
}

function promptRewardQuantity(rewardId) {
  if (!canEdit()) return;
  const reward = state.rewards.find((item) => item.id === rewardId);
  if (!reward) return;

  const nextValue = window.prompt("修改数量", String(reward.quantity));
  if (nextValue === null) return;
  updateRewardQuantity(rewardId, nextValue);
}

function redeemReward(rewardId) {
  if (!canEdit()) return;
  const reward = state.rewards.find((item) => item.id === rewardId);
  if (!reward) return;
  if (reward.quantity <= 0) {
    window.alert("奖励已兑完");
    return;
  }
  if (getAvailablePoints() < reward.cost) {
    window.alert("积分不足");
    return;
  }

  reward.quantity = Math.max(0, reward.quantity - 1);
  reward.redeemedCount += 1;
  reward.redeemedAt = new Date().toISOString();
  state.totalSpentPoints += reward.cost;
  persistState();
  render();
  playRewardCelebration();
}

function resetPointsSystem() {
  if (!canEdit()) return;
  for (const task of state.tasks) {
    task.completed = false;
    task.completionCount = 0;
    task.completedAt = "";
  }

  for (const reward of state.rewards) {
    reward.quantity = parseCount(reward.initialQuantity, reward.quantity);
    reward.redeemedCount = 0;
    reward.redeemedAt = "";
  }

  state.totalEarnedPoints = 0;
  state.totalSpentPoints = 0;
  persistState();
  render();
}

function persistState() {
  dirty = true;
  changeSequence += 1;
  saveError = "";
  backupPending();
  void savePending();
}

function canEdit() {
  return ready && !loading && !conflict && recoveryCandidates.length === 0;
}

function warnStorage(message) {
  storageWarning.hidden = false;
  if (!storageWarning.textContent.includes(message)) storageWarning.textContent += (storageWarning.textContent ? " " : "") + message;
}

function removeLocal(key) {
  try { localStorage.removeItem(key); }
  catch { warnStorage("浏览器本地恢复副本清理失败。"); }
}

function readLocalCandidates() {
  try {
    for (const key of [STORAGE_KEY, LEGACY_STORAGE_KEY]) {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      try { legacyCandidate = PlanData.parseImport(JSON.parse(raw)); break; }
      catch { warnStorage(`${key} 无法解析，原记录已保留；请从原页面导出后处理。`); }
    }
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key.startsWith(RECOVERY_PREFIX)) continue;
      try {
        const candidate = JSON.parse(localStorage.getItem(key));
        if (!Number.isSafeInteger(candidate.expectedRevision) || candidate.expectedRevision < 0) throw new Error("版本无效");
        recoveryCandidates.push({ ...candidate, state: PlanData.parseImport(candidate), key });
      } catch { warnStorage("发现无法解析的本地恢复副本，已保留原内容。"); }
    }
    recoveryCandidates.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  } catch { warnStorage("浏览器本地存储不可用。未保存内容请及时导出文件备份。"); }
}

function backupPending() {
  try {
    localStorage.setItem(recoveryKey, JSON.stringify({ schemaVersion: PlanData.SCHEMA_VERSION,
      expectedRevision: revision, updatedAt: new Date().toISOString(), state }));
  } catch { warnStorage("本地备份失败，未保存内容仍在页面中，请及时导出。"); }
}

function updateDataControls() {
  const editable = canEdit();
  document.querySelectorAll("#task-form input, #task-form textarea, #task-form select, #task-form button, #reward-form input, #reward-form textarea, #reward-form button, #task-list input, #task-list button, #reward-list button").forEach((node) => { node.disabled = !editable; });
  const tasksById = new Map(state.tasks.map((task) => [task.id, task]));
  taskList.querySelectorAll(".complete").forEach((button) => {
    const task = tasksById.get(button.dataset.taskId);
    const blocked = Boolean(task && !(task.type === "single" && task.completed) && !allTaskTodosComplete(task));
    button.disabled = !editable || !task || blocked;
    button.title = blocked ? "请先勾选全部子任务" : "";
    const hint = button.closest(".card").querySelector(".completion-hint");
    hint.hidden = !blocked;
    if (blocked) {
      const remaining = task.todos.filter((todo) => !todo.completed).length;
      hint.textContent = `还有 ${remaining} 项子任务未完成，请全部勾选后再完成主任务。`;
    }
  });
  clearTasksBtn.disabled = clearRewardsBtn.disabled = resetPointsBtn.disabled = !editable;
  exportDataBtn.disabled = !ready;
  importDataBtn.disabled = !editable || saving;
  retrySaveBtn.hidden = !(dirty && saveError && !conflict);
  reloadDataBtn.hidden = !(conflict || (saveError && !dirty));
  reloadDataBtn.disabled = loading || saving;
  importLegacyBtn.hidden = !legacyCandidate || !ready || initialized;
  importLegacyBtn.disabled = !editable || saving;
  exportLegacyBtn.hidden = !legacyCandidate;
  recoverySelect.hidden = recoveryCandidates.length < 2;
  restorePendingBtn.hidden = discardPendingBtn.hidden = recoveryCandidates.length === 0;
  restorePendingBtn.disabled = discardPendingBtn.disabled = !ready || loading;
  dataActions.hidden = ![retrySaveBtn, reloadDataBtn, importLegacyBtn, exportLegacyBtn,
    recoverySelect, restorePendingBtn, discardPendingBtn].some((control) => !control.hidden);
  const chosenKey = recoverySelect.value;
  recoverySelect.replaceChildren(...recoveryCandidates.map((candidate) => {
    const option = document.createElement("option");
    option.value = candidate.key;
    option.textContent = `${candidate.updatedAt || "未保存记录"} · ${candidate.state.tasks.length} 个任务`;
    return option;
  }));
  if (recoveryCandidates.some((candidate) => candidate.key === chosenKey)) recoverySelect.value = chosenKey;
  let message;
  if (loading) message = "正在加载服务器数据…";
  else if (!ready) message = saveError || "服务器数据尚未加载，暂不能编辑。";
  else if (conflict) message = "保存冲突：服务器已有更新。当前修改已保留，请先导出，再重新加载。";
  else if (recoveryCandidates.length) message = `发现 ${recoveryCandidates.length} 份未保存内容，请选择恢复，或保留服务器数据。`;
  else if (saving) message = "正在保存到服务器…";
  else if (saveError) message = `保存失败：${saveError}`;
  else if (dirty) message = "有修改尚未保存。";
  else message = initialized ? "已保存到服务器" : "服务器尚无记录，可以新建或导入旧数据。";
  statusNode.textContent = message;
  statusNode.dataset.error = String(Boolean(saveError || conflict));
}

async function requestState(method = "GET", body) {
  if (!["http:", "https:"].includes(location.protocol)) throw new Error("请通过 open01 上的 Node.js 服务访问网页，不能直接打开 HTML 文件。");
  const response = await fetch("/api/state", {
    method, cache: "no-store", signal: AbortSignal.timeout(10000),
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let result;
  try { result = await response.json(); }
  catch { throw new Error("服务器没有返回有效数据，请确认使用 npm start 启动后端。"); }
  if (!response.ok) {
    const error = new Error(result.error || `请求失败 (${response.status})`);
    error.status = response.status;
    throw error;
  }
  if (result.schemaVersion !== PlanData.SCHEMA_VERSION) throw new Error("服务端版本与网页不一致，请重启 Node.js 服务后刷新页面。");
  if (result.initialized === false && method === "GET" && result.revision === 0 && result.schemaVersion === PlanData.SCHEMA_VERSION) {
    return { ...result, state: PlanData.validateState(result.state) };
  }
  if (result.initialized !== true) throw new Error("服务器返回的数据格式无效");
  return { initialized: true, ...PlanData.validateDocument(result) };
}

async function loadState(discard = false) {
  if (loading || saving) return;
  if ((dirty || conflict) && !discard) return;
  if (discard && (dirty || conflict) && !window.confirm("重新加载会放弃当前未保存修改。建议先导出备份，确定继续？")) return;
  loading = true;
  updateDataControls();
  try {
    const document = await requestState();
    state = document.state;
    revision = document.revision;
    initialized = document.initialized;
    if (discard) {
      removeLocal(recoveryKey);
      if (recoverySourceKey) removeLocal(recoverySourceKey);
      recoverySourceKey = null;
    }
    dirty = conflict = false;
    saveError = "";
    ready = true;
    recoveryCandidates = recoveryCandidates.filter((candidate) => {
      if (JSON.stringify(candidate.state) !== JSON.stringify(state)) return true;
      removeLocal(candidate.key);
      return false;
    });
  } catch (error) { saveError = error.message; }
  finally { loading = false; render(); }
}

async function savePending() {
  if (saving || !dirty || !canEdit()) return;
  saving = true;
  saveError = "";
  const sequence = changeSequence;
  updateDataControls();
  try {
    const snapshot = PlanData.validateState(state);
    const document = await requestState("PUT", { expectedRevision: revision, state: snapshot });
    revision = document.revision;
    initialized = true;
    if (sequence === changeSequence) {
      dirty = false;
      removeLocal(recoveryKey);
      if (recoverySourceKey) removeLocal(recoverySourceKey);
      recoverySourceKey = null;
    } else backupPending();
  } catch (error) {
    saveError = error.message;
    conflict = error.status === 409;
    backupPending();
  } finally {
    saving = false;
    updateDataControls();
    if (dirty && !saveError && !conflict) void savePending();
  }
}

function exportState(value, name = "igotplan") {
  const exported = { schemaVersion: PlanData.SCHEMA_VERSION, revision, updatedAt: new Date().toISOString(), unsaved: dirty, state: value };
  const url = URL.createObjectURL(new Blob([JSON.stringify(exported, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  documentBodyDownload(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function documentBodyDownload(link) {
  document.body.append(link);
  link.click();
  link.remove();
}

function importState(value) {
  if (!canEdit() || saving) return;
  const next = PlanData.parseImport(value);
  if (!window.confirm(`将用 ${next.tasks.length} 个任务、${next.rewards.length} 个奖励、${next.totalEarnedPoints} 获得积分和 ${next.totalSpentPoints} 已花费积分替换当前数据，并保存到服务器。确定导入？`)) return;
  state = next;
  persistState();
  render();
}

retrySaveBtn.addEventListener("click", () => { void savePending(); });
reloadDataBtn.addEventListener("click", () => { void loadState(true); });
exportDataBtn.addEventListener("click", () => { exportState(state); closeDataMenu(true); });
exportLegacyBtn.addEventListener("click", () => exportState(legacyCandidate, "igotplan-browser-legacy"));
importDataBtn.addEventListener("click", () => { choosingImport = true; closeDataMenu(true); importFileInput.click(); });

function closeDataMenu(restoreFocus = false) {
  if (!dataMenu.open) return;
  dataMenu.open = false;
  if (restoreFocus) dataMenu.querySelector("summary").focus();
}

document.addEventListener("click", (event) => {
  if (!dataMenu.contains(event.target)) closeDataMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && dataMenu.open) {
    closeDataMenu(true);
    event.preventDefault();
  }
});
importFileInput.addEventListener("cancel", () => { choosingImport = false; });
importLegacyBtn.addEventListener("click", () => { try { importState(legacyCandidate); } catch (error) { window.alert(error.message); } });
importFileInput.addEventListener("change", async () => {
  const file = importFileInput.files[0];
  if (!file) { choosingImport = false; return; }
  choosingImport = true;
  try {
    if (file.size > 2 * 1024 * 1024) throw new Error("导入文件不能超过 2 MiB");
    importState(JSON.parse(await file.text()));
  } catch (error) { window.alert(`导入失败：${error.message}`); }
  finally { importFileInput.value = ""; choosingImport = false; }
});
restorePendingBtn.addEventListener("click", () => {
  if (!ready || loading) return;
  const candidate = recoveryCandidates.find((item) => item.key === recoverySelect.value) || recoveryCandidates[0];
  if (!candidate) return;
  state = candidate.state;
  recoverySourceKey = candidate.key;
  recoveryCandidates = [];
  dirty = true;
  conflict = candidate.expectedRevision !== revision;
  if (conflict) revision = candidate.expectedRevision;
  changeSequence += 1;
  backupPending();
  if (!conflict) void savePending();
  render();
});
discardPendingBtn.addEventListener("click", () => {
  if (!ready || loading || !window.confirm("确定放弃这些本地未保存内容，并保留服务器记录？")) return;
  recoveryCandidates.forEach((candidate) => removeLocal(candidate.key));
  recoveryCandidates = [];
  updateDataControls();
});
window.addEventListener("beforeunload", (event) => {
  if (!dirty && !saving) return;
  backupPending();
  event.preventDefault();
  event.returnValue = "";
});
window.addEventListener("focus", () => {
  if (ready && !dirty && !saving && !loading && !choosingImport && !recoveryCandidates.length) void loadState();
});

function getAvailablePoints() {
  return state.totalEarnedPoints - state.totalSpentPoints;
}

function createEmptyNode(text) {
  const empty = document.createElement("p");
  empty.className = "empty";
  empty.textContent = text;
  return empty;
}

function setToday() {
  const today = new Date().toISOString().split("T")[0];
  taskDateInput.value = today;
}

function parsePoints(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function parseCount(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeTaskType(value) {
  return value === "long-term" ? "long-term" : "single";
}

function normalizeTitle(value, fallback) {
  const next = String(value || "").trim();
  return next || fallback;
}

async function initializeLive2D() {
  if (!live2dCanvas || !live2dDock || !window.PIXI?.live2d?.Live2DModel) {
    if (live2dStatus) {
      live2dStatus.textContent = "Live2D runtime unavailable";
    }
    return;
  }

  try {
    const { Application } = window.PIXI;
    const { Live2DModel } = window.PIXI.live2d;

    window.PIXI.utils?.skipHello?.();

    await assertLive2DModelCompatibility(LIVE2D_MODEL.path);

    live2dApp = new Application({
      view: live2dCanvas,
      autoStart: true,
      autoDensity: true,
      antialias: true,
      transparent: true,
      backgroundAlpha: 0,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      width: live2dCanvas.clientWidth || 240,
      height: live2dCanvas.clientHeight || 320,
    });

    live2dModel = await Live2DModel.from(LIVE2D_MODEL.path, {
      autoInteract: false,
    });

    configureLive2DParameterIds();
    live2dApp.stage.addChild(live2dModel);
    fitLive2DModel();
    setLive2DFocusTarget(0, 0, true);

    window.addEventListener("pointermove", handleLive2DPointerMove, { passive: true });
    window.addEventListener("pointerleave", resetLive2DFocus);
    window.addEventListener("pointerdown", handleLive2DPointerDown, { passive: true });
    window.addEventListener("blur", resetLive2DFocus);
    window.addEventListener("resize", resizeLive2DStage, { passive: true });

    if (live2dStatus) {
      live2dStatus.textContent = `官方 sample model: ${LIVE2D_MODEL.name}`;
    }
    live2dDock.classList.add("is-ready");

    playLive2DIdleMotion();
  } catch (error) {
    console.error("Failed to initialize Live2D sample", error);
    live2dDock.classList.add("is-error");
    if (live2dStatus) {
      const detail =
        error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
      live2dStatus.textContent = `Live2D load error: ${detail}`;
      reportLive2DError(detail);
    }
  }
}

function configureLive2DParameterIds() {
  const internal = live2dModel.internalModel;
  const parameters = new Set(internal.coreModel.getModel().parameters.ids);
  const legacyIds = {
    ParamAngleX: "PARAM_ANGLE_X",
    ParamAngleY: "PARAM_ANGLE_Y",
    ParamAngleZ: "PARAM_ANGLE_Z",
    ParamEyeBallX: "PARAM_EYE_BALL_X",
    ParamEyeBallY: "PARAM_EYE_BALL_Y",
    ParamBodyAngleX: "PARAM_BODY_ANGLE_X",
    ParamBreath: "PARAM_BREATH",
  };
  const resolve = (id) => parameters.has(id) || !parameters.has(legacyIds[id]) ? id : legacyIds[id];
  for (const key of Object.keys(internal)) {
    if (key.startsWith("idParam")) internal[key] = resolve(internal[key]);
  }
  for (const parameter of internal.breath.getParameters()) {
    parameter.parameterId = resolve(parameter.parameterId);
  }
}

async function assertLive2DModelCompatibility(modelPath) {
  const settings = await fetch(modelPath).then((response) => {
    if (!response.ok) {
      throw new Error(`Model settings request failed: ${response.status}`);
    }
    return response.json();
  });

  const mocPath = settings?.FileReferences?.Moc;
  if (!mocPath) {
    throw new Error("Model settings missing Moc reference");
  }

  const mocUrl = new URL(mocPath, new URL(modelPath, window.location.href)).toString();
  const mocBuffer = await fetch(mocUrl).then((response) => {
    if (!response.ok) {
      throw new Error(`Moc request failed: ${response.status}`);
    }
    return response.arrayBuffer();
  });

  const mocVersion = new DataView(mocBuffer, 4, 4).getUint32(0, true);
  const supportedVersion = window.Live2DCubismCore?.Version?.csmGetLatestMocVersion?.() ?? 0;

  if (mocVersion > supportedVersion) {
    throw new Error(
      `Unsupported moc3 version ${mocVersion}. Current Cubism Core supports up to ${supportedVersion}.`
    );
  }
}

function resizeLive2DStage() {
  if (!live2dApp || !live2dCanvas) return;

  const nextWidth = Math.max(1, Math.round(live2dCanvas.clientWidth || 240));
  const nextHeight = Math.max(1, Math.round(live2dCanvas.clientHeight || 320));
  live2dApp.renderer.resize(nextWidth, nextHeight);
  fitLive2DModel();
}

function fitLive2DModel() {
  if (!live2dApp || !live2dModel) return;

  live2dModel.anchor.set(0.5, 1);
  const layout = LIVE2D_LAYOUT[LIVE2D_MODEL.name] || LIVE2D_LAYOUT.Hiyori;
  const { width, height } = live2dApp.screen;

  const scale = layout.autoFit
    ? Math.min(
        (width * 0.94) / live2dModel.internalModel.width,
        (height * 0.94) / live2dModel.internalModel.height
      )
    : layout.scale;
  live2dModel.scale.set(scale);
  live2dModel.x = width * layout.x;
  live2dModel.y = height * layout.y;
}

function handleLive2DPointerMove(event) {
  if (!live2dModel) return;

  const x = clamp(((event.clientX / window.innerWidth) * 2 - 1) * LIVE2D_FOCUS_GAIN.x, -1, 1);
  const y = clamp((1 - (event.clientY / window.innerHeight) * 2) * LIVE2D_FOCUS_GAIN.y, -1, 1);
  setLive2DFocusTarget(x, y);
}

function handleLive2DPointerDown(event) {
  if (!live2dModel || event.button !== 0) return;
  if (event.target?.closest?.("button, a, input, textarea, select, label, summary, [role='button'], [contenteditable], [tabindex], .title")) return;

  const bounds = live2dCanvas.getBoundingClientRect();
  if (event.clientX >= bounds.left && event.clientX < bounds.right &&
      event.clientY >= bounds.top && event.clientY < bounds.bottom) {
    void playLive2DTapMotion();
  }
}

function resetLive2DFocus() {
  setLive2DFocusTarget(0, 0);
}

async function playLive2DIdleMotion() {
  if (!live2dModel) return;

  try {
    await live2dModel.motion("Idle", 0, window.PIXI.live2d.MotionPriority.IDLE);
  } catch (error) {
    console.warn("Unable to start Live2D idle motion", error);
  }
}

async function playLive2DTapMotion() {
  if (!live2dModel) return;

  try {
    await live2dModel.motion("TapBody");
  } catch (error) {
    console.warn("Unable to play Live2D tap motion", error);
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function setLive2DFocusTarget(x, y, instant = false) {
  if (!live2dModel) return;

  const controller = live2dModel.internalModel?.focusController;
  if (controller?.focus) {
    controller.focus(x, y, instant);
    return;
  }

  if (live2dModel.focus) {
    live2dModel.focus(x, y, instant);
  }
}

function reportLive2DError(detail) {
  const beacon = new Image();
  beacon.src = `/__live2d_error__?model=${encodeURIComponent(LIVE2D_MODEL.name)}&detail=${encodeURIComponent(detail)}`;
}

function playRewardCelebration() {
  if (!celebrationLayer) return;

  celebrationLayer.innerHTML = "";
  const message = document.createElement("div");
  message.className = "celebration-message";
  message.textContent = "好好享受";
  celebrationLayer.append(message);

  for (let i = 0; i < 18; i += 1) {
    const piece = document.createElement("span");
    piece.className = "confetti-piece";
    piece.style.left = `${8 + Math.random() * 84}%`;
    piece.style.animationDelay = `${Math.random() * 0.18}s`;
    piece.style.background = getCelebrationColor(i);
    piece.style.transform = `rotate(${Math.random() * 180}deg)`;
    celebrationLayer.append(piece);
  }

  celebrationLayer.classList.remove("is-active");
  void celebrationLayer.offsetWidth;
  celebrationLayer.classList.add("is-active");

  window.setTimeout(() => {
    celebrationLayer.classList.remove("is-active");
    celebrationLayer.innerHTML = "";
  }, 2200);
}

function getCelebrationColor(index) {
  const colors = ["#1d7a52", "#d79b2d", "#f97316", "#38bdf8", "#ef4444", "#8b5cf6"];
  return colors[index % colors.length];
}

function formatDate(value) {
  if (!value) return "No date";
  const d = new Date(value);
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
