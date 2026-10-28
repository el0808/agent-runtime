// The renderer is deliberately dependency-free: it talks to the gateway over
// fetch and one SSE stream, and never infers state that the runtime did not emit.

// Same origin: the app server proxies /api to the gateway.
const GATEWAY = "/api";

const $ = (id) => document.getElementById(id);

const state = {
  tasks: [],
  current: null,
  events: [],
  pending: [],
  filterTaskId: null
};

/* ---------------- transport ---------------- */

async function api(path, init = {}) {
  const response = await fetch(new URL(path, GATEWAY), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) }
  });
  const text = await response.text();
  const body = text === "" ? null : JSON.parse(text);
  if (!response.ok) {
    throw new Error(body?.error ?? `${response.status} ${response.statusText}`);
  }
  return body;
}

function connectStream() {
  const source = new EventSource(`${GATEWAY}/events`);
  source.onopen = () => setConnected(true);
  source.onerror = () => setConnected(false);
  source.onmessage = () => {};
  // The gateway names events by type; listen to every type the runtime emits.
  for (const type of EVENT_TYPES) {
    source.addEventListener(type, (message) => {
      try {
        const event = JSON.parse(message.data);
        onEvent(event);
      } catch {
        /* ignore malformed frames */
      }
    });
  }
  return source;
}

const EVENT_TYPES = [
  "task.created", "task.started", "task.paused", "task.resumed", "task.completed",
  "task.failed", "task.cancelled", "task.step_completed", "checkpoint.created",
  "checkpoint.restored", "verification.recorded", "session.started", "session.ended",
  "model.requested", "model.delta", "model.completed", "model.failed",
  "tool.requested", "tool.completed", "tool.failed", "tool.timed_out", "tool.cancelled",
  "route.decided", "approval.requested", "approval.resolved", "retry.scheduled",
  "compensation.executed", "recovery.started", "decision.evaluated",
  "memory.updated", "context.compressed"
];

function setConnected(ok) {
  const dot = $("conn-dot");
  dot.className = `dot ${ok ? "live" : ""}`;
}

/* ---------------- tasks ---------------- */

async function refreshTasks() {
  try {
    state.tasks = await api("/tasks");
  } catch {
    state.tasks = [];
  }
  renderTasks();
}

function renderTasks() {
  const list = $("task-list");
  $("task-count").textContent = String(state.tasks.length);
  if (state.tasks.length === 0) {
    list.innerHTML = '<div class="hint" style="padding:12px">No tasks yet.</div>';
    return;
  }
  list.innerHTML = "";
  for (const task of state.tasks) {
    const element = document.createElement("div");
    element.className = `task${task.taskId === state.current ? " active" : ""}`;
    element.dataset.taskId = task.taskId;
    const goal = document.createElement("div");
    goal.className = "goal";
    goal.textContent = task.profile?.goal ?? task.taskId;
    const meta = document.createElement("div");
    meta.className = "meta";
    const status = document.createElement("span");
    status.className = `status ${task.status}`;
    status.textContent = task.status;
    const runner = document.createElement("span");
    runner.textContent = task.profile?.runnerType ?? "";
    meta.append(status, runner);
    element.append(goal, meta);
    element.onclick = () => selectTask(task.taskId);
    list.append(element);
  }
}

async function selectTask(taskId) {
  state.current = taskId;
  state.events = [];
  $("timeline").innerHTML = "";
  renderTasks();
  updateActionButtons();
  try {
    const events = await api(`/tasks/${encodeURIComponent(taskId)}/events`);
    for (const event of events) appendEvent(event, false);
  } catch (error) {
    console.warn(error);
  }
  await refreshPending();
  await refreshStatePanel();
}

/* ---------------- timeline ---------------- */

function onEvent(event) {
  // Tasks are created by the gateway before the stream sees them.
  if (!state.tasks.some((task) => task.taskId === event.taskId)) {
    void refreshTasks();
  }
  if (event.taskId === state.current) {
    appendEvent(event, true);
    if (event.type === "approval.requested" || event.type === "approval.resolved") {
      void refreshPending();
    }
    if (TERMINAL.has(event.type)) {
      void refreshTasks();
      void refreshStatePanel();
    }
  } else if (event.type === "task.created") {
    void refreshTasks();
  }
}

const TERMINAL = new Set(["task.completed", "task.failed", "task.cancelled", "session.ended"]);

function appendEvent(event, live) {
  const timeline = $("timeline");
  const empty = timeline.querySelector(".empty");
  if (empty) empty.remove();

  if (event.type === "model.delta") {
    // Coalesce streamed text into one growing block instead of one row per token.
    const last = timeline.lastElementChild;
    if (last?.dataset.kind === "delta") {
      last.querySelector(".body").textContent += event.payload.text;
      return;
    }
    const row = document.createElement("div");
    row.className = "ev model-delta";
    row.dataset.kind = "delta";
    const kind = document.createElement("div");
    kind.className = "kind";
    kind.textContent = "model";
    const body = document.createElement("div");
    body.className = "body";
    body.textContent = event.payload.text;
    row.append(kind, body);
    timeline.append(row);
    scrollTimeline();
    return;
  }

  state.events.push(event);
  $("status-events").textContent = `${state.events.length} events`;
  $("status-seq").textContent = `seq ${event.sequence}`;

  const row = document.createElement("div");
  row.className = "ev";
  const kind = document.createElement("div");
  kind.className = "kind";
  kind.textContent = String(event.type).replace(/^(task|model|tool)\./, "$1 ");
  const body = document.createElement("div");
  body.className = "body";
  body.append(...describe(event));
  row.append(kind, body);
  if (live) row.style.animation = "none";
  timeline.append(row);
  scrollTimeline();
}

function scrollTimeline() {
  const timeline = $("timeline");
  const nearBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 120;
  if (nearBottom) timeline.scrollTop = timeline.scrollHeight;
}

function tag(text, cls) {
  const span = document.createElement("span");
  span.className = `tag ${cls}`;
  span.textContent = text;
  return span;
}

function details(summary, content) {
  const element = document.createElement("details");
  const head = document.createElement("summary");
  head.textContent = summary;
  const pre = document.createElement("pre");
  pre.textContent = typeof content === "string" ? content : JSON.stringify(content, null, 2);
  element.append(head, pre);
  return element;
}

function text(value) {
  const span = document.createElement("span");
  span.textContent = value;
  return span;
}

function describe(event) {
  const p = event.payload ?? {};
  switch (event.type) {
    case "task.created":
      return [text(p.profile?.goal ?? ""), details("profile", p.profile)];
    case "route.decided":
      return [
        tag(String(p.runnerType), "thinking"),
        text(String(p.reason ?? "")),
        p.upgradedFrom ? tag(`↑ from ${p.upgradedFrom}`, "warn") : document.createDocumentFragment(),
        details("evidence", p.evidence)
      ];
    case "model.requested":
      return [text(`turn ${p.turn} · ${p.messageCount} messages · ${p.model}`)];
    case "model.completed":
      return [
        tag(String(p.finishReason), p.finishReason === "tool_call" ? "tool" : "ok"),
        p.usage ? text(`${p.usage.promptTokens}→${p.usage.completionTokens} tok`) : document.createDocumentFragment(),
        p.costUsd !== undefined ? text(` · $${p.costUsd.toFixed(4)}`) : document.createDocumentFragment(),
        p.text ? details("text", p.text) : document.createDocumentFragment()
      ];
    case "tool.requested":
      return [
        tag(p.call?.toolName ?? "tool", "tool"),
        details("arguments", p.call?.input ?? {})
      ];
    case "tool.completed":
      return [
        tag("ok", "ok"),
        text(`${p.durationMs ?? 0}ms`),
        details("output", p.output ?? {})
      ];
    case "tool.failed":
      return [tag(p.error?.code ?? "failed", "err"), text(p.error?.message ?? "")];
    case "tool.timed_out":
      return [tag("timeout", "err"), text(`after ${p.timeoutMs}ms`)];
    case "approval.requested":
      return [
        tag(p.risk ?? "approval", "warn"),
        text(`${p.toolName} — ${p.reason ?? ""}`),
        details("approval id", p.approvalId ?? "")
      ];
    case "approval.resolved":
      return [tag(p.decision ?? "", p.decision === "approved" ? "ok" : "err"), text(`${p.actor ?? ""}`)];
    case "verification.recorded":
      return [
        tag(p.result?.status ?? "verification", p.result?.status === "passed" ? "ok" : "err"),
        details("checks", p.result?.checks ?? [])
      ];
    case "context.compressed":
      return [
        tag("compressed", "warn"),
        text(`${p.beforeTokens}→${p.afterTokens} tok (${Math.round((p.reductionRatio ?? 0) * 100)}% less)`),
        p.qualityPassed === false ? tag("constraint lost", "err") : document.createDocumentFragment()
      ];
    case "retry.scheduled":
      return [tag("retry", "warn"), text(`${p.operation} attempt ${p.attempt}/${p.maxAttempts}: ${p.reason ?? ""}`)];
    case "task.step_completed":
      return [tag("step", "ok"), text(p.step ?? "")];
    case "session.ended":
      return [tag(String(p.status ?? ""), p.status === "completed" ? "ok" : "warn")];
    case "task.failed":
      return [tag(p.error?.code ?? "failed", "err"), text(p.error?.message ?? "")];
    case "compensation.executed":
      return [tag(p.status ?? "", p.status === "succeeded" ? "ok" : "err"), text(p.action ?? "")];
    case "decision.evaluated":
      return [
        tag(`${p.provider}:${p.choice}`, p.authoritative ? "ok" : "warn"),
        text(`conf ${(p.confidence ?? 0).toFixed(2)} · ${p.latencyMs ?? 0}ms${p.fallback ? " · fallback" : ""}`)
      ];
    default:
      return [text(JSON.stringify(p).slice(0, 200))];
  }
}

/* ---------------- actions ---------------- */

async function runTask() {
  const goal = $("goal").value.trim();
  if (goal === "") return;
  const runnerType = $("runner").value;
  const button = $("btn-run");
  button.disabled = true;
  button.textContent = "Running…";
  try {
    const created = await api("/tasks", {
      method: "POST",
      body: JSON.stringify(runnerType === "" ? { goal } : { goal, runnerType })
    });
    await refreshTasks();
    await selectTask(created.taskId);
    await api(`/tasks/${encodeURIComponent(created.taskId)}/run`, { method: "POST", body: "{}" });
    await refreshTasks();
    await refreshStatePanel();
  } catch (error) {
    appendEvent({
      type: "task.failed",
      sequence: "—",
      taskId: state.current,
      payload: { error: { code: "CLIENT", message: String(error.message ?? error) } }
    });
  } finally {
    button.disabled = false;
    button.textContent = "Run";
  }
}

async function taskAction(action) {
  if (state.current === null) return;
  try {
    await api(`/tasks/${encodeURIComponent(state.current)}/${action}`, { method: "POST", body: "{}" });
    await refreshTasks();
    await refreshStatePanel();
  } catch (error) {
    console.warn(error);
  }
}

function updateActionButtons() {
  const enabled = state.current !== null;
  for (const id of ["btn-verify", "btn-rollback", "btn-pause", "btn-cancel"]) {
    $(id).disabled = !enabled;
  }
  $("status-task").textContent = state.current === null ? "no task" : state.current.slice(0, 18);
}

/* ---------------- approvals ---------------- */

async function refreshPending() {
  if (state.current === null) {
    $("panel-approvals").innerHTML = '<div class="hint">Select a task first.</div>';
    return;
  }
  try {
    state.pending = await api(`/tasks/${encodeURIComponent(state.current)}/approvals`);
  } catch {
    state.pending = [];
  }
  renderApprovals();
}

function renderApprovals() {
  const panel = $("panel-approvals");
  panel.innerHTML = "";
  if (state.pending.length === 0) {
    panel.innerHTML = '<div class="hint">Nothing waiting. Blocked tool calls appear here for a decision.</div>';
    return;
  }
  for (const approvalId of state.pending) {
    const event = [...state.events].reverse().find(
      (candidate) => candidate.type === "approval.requested" && candidate.payload.approvalId === approvalId
    );
    const card = document.createElement("div");
    card.className = "approval";
    const risk = document.createElement("div");
    risk.className = "risk";
    risk.textContent = `${event?.payload?.risk ?? "review"} · ${event?.payload?.toolName ?? "tool"}`;
    const reason = document.createElement("div");
    reason.className = "hint";
    reason.textContent = event?.payload?.reason ?? "";
    const actions = document.createElement("div");
    actions.className = "actions";
    const approve = document.createElement("button");
    approve.className = "sm ok";
    approve.textContent = "Approve";
    approve.onclick = () => decide(approvalId, "approve");
    const reject = document.createElement("button");
    reject.className = "sm err";
    reject.textContent = "Reject";
    reject.onclick = () => decide(approvalId, "reject");
    actions.append(approve, reject);
    card.append(risk, reason, actions);
    panel.append(card);
  }
}

async function decide(approvalId, decision) {
  try {
    await api(`/tasks/${encodeURIComponent(state.current)}/approvals`, {
      method: "POST",
      body: JSON.stringify({ approvalId, decision })
    });
    await refreshPending();
    await refreshTasks();
    // An approval unblocks the task: continue it from where it paused.
    await api(`/tasks/${encodeURIComponent(state.current)}/run`, { method: "POST", body: "{}" });
    await refreshTasks();
    await refreshStatePanel();
  } catch (error) {
    console.warn(error);
  }
}

/* ---------------- memory ---------------- */

async function searchMemory() {
  const query = $("mem-q").value.trim();
  if (query === "") return;
  const results = await api(`/memories?q=${encodeURIComponent(query)}`).catch(() => []);
  const container = $("mem-results");
  container.innerHTML = "";
  if (results.length === 0) {
    container.innerHTML = '<div class="hint">No matches.</div>';
    return;
  }
  for (const record of results) {
    const card = document.createElement("div");
    card.className = "card";
    const title = document.createElement("div");
    title.className = "title";
    title.innerHTML = `<b></b><span class="hint"></span>`;
    title.querySelector("b").textContent = record.key;
    title.querySelector(".hint").textContent = `${record.scope} · v${record.version}`;
    const content = document.createElement("div");
    content.textContent = record.content;
    const actions = document.createElement("div");
    actions.className = "actions";
    const remove = document.createElement("button");
    remove.className = "sm err";
    remove.textContent = "Delete";
    remove.onclick = async () => {
      await api(`/memories/${encodeURIComponent(record.memoryId)}`, { method: "DELETE" }).catch(() => {});
      await searchMemory();
    };
    actions.append(remove);
    card.append(title, content, actions);
    container.append(card);
  }
}

async function addMemory() {
  const key = $("mem-key").value.trim();
  const content = $("mem-content").value.trim();
  if (key === "" || content === "") return;
  await api("/memories", {
    method: "POST",
    body: JSON.stringify({ key, content, scope: $("mem-scope").value })
  }).catch((error) => console.warn(error));
  $("mem-key").value = "";
  $("mem-content").value = "";
  await searchMemory();
}

/* ---------------- tools & state ---------------- */

async function loadTools() {
  const tools = await api("/tools").catch(() => []);
  const panel = $("panel-tools");
  panel.innerHTML = "";
  if (tools.length === 0) {
    panel.innerHTML = '<div class="hint">No tools registered.</div>';
    return;
  }
  for (const tool of tools) {
    const card = document.createElement("div");
    card.className = "card";
    const title = document.createElement("div");
    title.className = "title";
    const name = document.createElement("b");
    name.textContent = tool.name;
    title.append(name);
    const description = document.createElement("div");
    description.className = "hint";
    description.textContent = tool.description;
    card.append(title, description, details("parameters", tool.parameters));
    panel.append(card);
  }
}

async function refreshStatePanel() {
  if (state.current === null) return;
  const task = await api(`/tasks/${encodeURIComponent(state.current)}`).catch(() => null);
  const panel = $("panel-state");
  if (task === null) {
    panel.innerHTML = '<div class="hint">Task not found.</div>';
    return;
  }
  panel.innerHTML = "";
  const card = document.createElement("div");
  card.className = "card";
  const kv = document.createElement("dl");
  kv.className = "kv";
  const rows = [
    ["status", task.status],
    ["runner", task.profile?.runnerType ?? "—"],
    ["sequence", String(task.lastEventSequence)],
    ["steps", task.completedSteps?.length ? task.completedSteps.join(" · ") : "—"],
    ["tool calls", String(task.toolCalls?.length ?? 0)],
    ["checkpoint", task.lastCheckpointId ?? "—"],
    ["verification", task.verification?.status ?? "—"]
  ];
  for (const [key, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = key;
    const dd = document.createElement("dd");
    dd.textContent = value;
    kv.append(dt, dd);
  }
  card.append(kv);
  panel.append(card);
}

/* ---------------- wiring ---------------- */

function selectTab(name) {
  for (const button of $("tabs").querySelectorAll("button")) {
    button.classList.toggle("active", button.dataset.tab === name);
  }
  for (const panel of document.querySelectorAll("[data-panel]")) {
    panel.hidden = panel.dataset.panel !== name;
  }
}

function wire() {
  $("tabs").addEventListener("click", (event) => {
    const target = event.target.closest("button");
    if (target) selectTab(target.dataset.tab);
  });
  $("btn-run").onclick = () => void runTask();
  $("goal").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void runTask();
  });
  $("btn-verify").onclick = () => void taskAction("verify");
  $("btn-rollback").onclick = () => void taskAction("rollback");
  $("btn-pause").onclick = () => void taskAction("pause");
  $("btn-cancel").onclick = () => void taskAction("cancel");
  $("btn-mem-search").onclick = () => void searchMemory();
  $("btn-mem-add").onclick = () => void addMemory();
  $("mem-q").addEventListener("keydown", (event) => {
    if (event.key === "Enter") void searchMemory();
  });
}

async function boot() {
  wire();
  const provider = await api("/provider").catch(() => null);
  if (provider !== null) {
    const badge = $("provider-badge");
    badge.textContent = `${provider.name} · ${provider.live ? "live" : "offline"}`;
    badge.className = `badge ${provider.live ? "live" : "fake"}`;
    $("model-badge").textContent = provider.model;
    document.querySelector("#brand .dot").title = provider.reason;
  }
  await refreshTasks();
  await loadTools();
  connectStream();
}

void boot();
