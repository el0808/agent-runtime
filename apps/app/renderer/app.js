import { renderMarkdown } from "./markdown.js";

const api = window.agent;
const $ = (id) => document.getElementById(id);

const state = {
  settings: null,
  provider: null,
  tasks: [],
  current: null,
  live: new Map(),
  search: "",
  sending: false,
  running: false,
  attachments: []
};

/* ---------------- helpers ---------------- */

/** Compact duration for the worklog: 0.8s, 12s, 1m 04s. */
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function fmtCost(value) {
  if (!value || value <= 0) return "";
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

function shortPath(p) {
  if (!p) return "";
  const home = "/Users/";
  if (p.startsWith(home)) {
    const parts = p.split("/");
    return `~/${parts.slice(3).join("/")}`;
  }
  return p;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/* ---------------- provider chip ---------------- */

function renderProvider(provider) {
  state.provider = provider;
  const chip = $("provider-chip");
  const label = $("provider-label");
  if (!provider) {
    chip.className = "chip offline";
    label.textContent = "no provider";
    return;
  }
  const live = provider.live === true;
  chip.className = `chip ${live ? "live" : "offline"}`;
  label.textContent = `${provider.provider} · ${provider.model}`;
  chip.title = provider.reason ?? "";
}

/* ---------------- conversation list ---------------- */

function renderConversations() {
  const list = $("conv-list");
  const query = state.search.trim().toLowerCase();
  const filtered = query === ""
    ? state.tasks
    : state.tasks.filter((task) => task.goal.toLowerCase().includes(query));

  list.innerHTML = "";
  if (filtered.length === 0) {
    list.append(el("div", "empty-hint", query === "" ? "No conversations yet." : "No matches."));
    return;
  }

  for (const task of filtered) {
    const row = el("div", `conv${task.taskId === state.current ? " active" : ""}`);
    const row1 = el("div", "row1");
    row1.append(el("span", `dot ${task.status}`));
    row1.append(el("span", "goal", task.goal));
    const row2 = el("div", "row2");
    row2.append(el("span", "", task.runnerType));
    if (task.steps > 0) row2.append(el("span", "", `${task.steps} steps`));
    if (task.toolCalls > 0) row2.append(el("span", "", `${task.toolCalls} tools`));
    const cost = fmtCost(task.costUsd);
    if (cost) row2.append(el("span", "", cost));
    row.append(row1, row2);
    row.onclick = () => void openTask(task.taskId);
    list.append(row);
  }
}

/* ---------------- thread rendering ---------------- */

function threadRoot() {
  return $("thread-inner");
}

function scrollToBottom(force) {
  const thread = $("thread");
  const near = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 160;
  if (force || near) thread.scrollTop = thread.scrollHeight;
}

function renderWelcome() {
  const root = threadRoot();
  root.innerHTML = "";
  const wrap = el("div", "welcome");
  wrap.append(el("h1", "", "What should the agent do?"));
  wrap.append(el("p", "", "Every step it takes is visible, and anything that touches your files asks first."));

  const starters = el("div", "starters");
  const ideas = [
    ["Explain this codebase", "Map the packages and how the runtime wires them together."],
    ["Find the bug", "Read a failing test and propose the smallest fix."],
    ["Write a changelog", "Summarise what changed since the last commit."],
    ["Refactor safely", "Plan the change, then verify nothing broke."]
  ];
  for (const [title, detail] of ideas) {
    const button = el("button", "starter");
    button.append(el("b", "", title));
    button.append(el("span", "", detail));
    button.onclick = () => {
      $("goal").value = `${title}: ${detail}`;
      $("goal").focus();
      autoGrow();
    };
    starters.append(button);
  }
  wrap.append(starters);
  root.append(wrap);
}

/** Rebuilds a conversation from the event log, grouping work into collapsible steps. */
function renderThread(events) {
  const root = threadRoot();
  root.innerHTML = "";

  const goal = state.tasks.find((task) => task.taskId === state.current)?.goal;
  if (goal !== undefined) {
    const turn = el("div", "turn turn-user");
    turn.append(el("div", "bubble", goal));
    root.append(turn);
  }

  let assistantText = "";
  let textNode = null;
  let worklog = null;
  let lastAssistantTurn = null;
  // Wall-clock start of the model call now in flight, from model.requested.
  let turnStartedAt = null;

  const ensureTurn = () => {
    if (lastAssistantTurn !== null) return lastAssistantTurn;
    const turn = el("div", "turn turn-assistant");
    const avatar = el("div", "avatar", "◆");
    const body = el("div", "body");
    turn.append(avatar, body);
    root.append(turn);
    lastAssistantTurn = { turn, body };
    return lastAssistantTurn;
  };

  const ensureWorklog = () => {
    if (worklog !== null) return worklog;
    const { body } = ensureTurn();
    const log = el("div", "worklog");
    body.insertBefore(log, body.firstChild);
    worklog = log;
    return log;
  };

  // Tool calls are folded: a run of many steps shows only the newest few, and
  // one click reveals the rest. Without this a busy turn fills the whole screen.
  const VISIBLE_STEPS = 3;
  let runGroup = null;

  const pushStep = (item) => {
    if (runGroup === null) {
      const wrap = el("div", "wl-group");
      ensureWorklog().append(wrap);
      runGroup = { wrap, items: [] };
    }
    runGroup.items.push(item);
    runGroup.wrap.append(item);
    applyCollapse(runGroup);
  };

  const applyCollapse = (group) => {
    const extra = group.items.length - VISIBLE_STEPS;
    let toggle = group.wrap.querySelector(".wl-more");
    if (extra <= 0) {
      if (toggle !== null) toggle.remove();
      group.wrap.classList.remove("collapsed");
      return;
    }
    if (toggle === null) {
      toggle = el("button", "wl-more");
      toggle.onclick = () => {
        const collapsed = group.wrap.classList.toggle("collapsed");
        toggle.textContent = collapsed ? `Show ${extra} earlier steps` : "Collapse";
      };
      group.wrap.prepend(toggle);
    }
    group.wrap.classList.add("collapsed");
    toggle.textContent = `Show ${extra} earlier step${extra === 1 ? "" : "s"}`;
  };

  // The streaming node already holds this text, so only create one when absent.
  const flushText = () => {
    if (assistantText === "") return;
    const block = textNode ?? (() => {
      const created = el("div", "assistant-text");
      ensureTurn().body.append(created);
      return created;
    })();
    block.innerHTML = renderMarkdown(assistantText);
    assistantText = "";
    textNode = null;
    lastAssistantTurn = null;
    worklog = null;
    runGroup = null;
  };

  for (const event of events) {
    const p = event.payload ?? {};

    // The goal is already rendered above, so only later turns are added here.
    if (event.type === "user.message") {
      flushText();
      const turn = el("div", "turn turn-user");
      const bubble = el("div", "bubble");
      if ((p.text ?? "") !== "") bubble.append(el("div", "", p.text));
      const images = p.images ?? [];
      if (images.length > 0) {
        const strip = el("div", "bubble-images");
        for (const image of images) {
          const thumb = document.createElement("img");
          thumb.src = `data:${image.mediaType};base64,${image.data}`;
          strip.append(thumb);
        }
        bubble.append(strip);
      }
      turn.append(bubble);
      root.append(turn);
      continue;
    }

    if (event.type === "model.delta") {
      const text = typeof p.text === "string" ? p.text : "";
      if (text === "") continue;
      if (textNode === null) {
        const { body } = ensureTurn();
        textNode = el("div", "assistant-text");
        body.append(textNode);
      }
      assistantText += text;
      textNode.innerHTML = renderMarkdown(assistantText);
      continue;
    }

    if (event.type === "model.requested") {
      turnStartedAt = Date.parse(event.occurredAt);
      continue;
    }

    if (event.type === "model.completed") {
      // Record how long the model thought, which the text alone never shows.
      const endedAt = Date.parse(event.occurredAt);
      if (turnStartedAt !== null && Number.isFinite(endedAt - turnStartedAt)) {
        const ms = endedAt - turnStartedAt;
        const item = el("div", "wl-item think");
        item.append(el("div", "wl-kind", "think"));
        const body = el("div", "wl-body");
        body.append(el("b", "", `thought for ${formatDuration(ms)}`));
        const u = p.usage;
        if (u !== undefined) {
          body.append(el("span", "arg", ` · ${u.promptTokens ?? 0} in / ${u.completionTokens ?? 0} out`));
        }
        item.append(body);
        pushStep(item);
      }
      turnStartedAt = null;
      continue;
    }

    if (event.type === "tool.requested") {
      const call = p.call ?? {};
      const item = el("div", "wl-item tool");
      item.append(el("div", "wl-kind", "tool"));
      const body = el("div", "wl-body");
      body.append(el("b", "", call.toolName ?? "tool"));
      const args = JSON.stringify(call.input ?? {});
      body.append(el("span", "arg", ` ${args.length > 90 ? `${args.slice(0, 90)}…` : args}`));
      item.append(body);
      pushStep(item);
      continue;
    }

    if (event.type === "tool.completed" || event.type === "tool.failed" || event.type === "tool.timed_out") {
      const failed = event.type !== "tool.completed";
      const label = failed ? (p.error?.message ?? "failed") : `${p.durationMs ?? 0} ms`;
      const details = el("details", "wl");
      const summary = el("summary");
      summary.append(el("span", "wl-kind", failed ? "error" : "done"));
      const body = el("div", "wl-body");
      body.append(el("b", "", failed ? (p.error?.code ?? "error") : "result"));
      body.append(el("span", "arg", ` ${label}`));
      summary.append(body);
      details.append(summary);
      const pre = el("pre", "wl-out");
      pre.textContent = JSON.stringify(failed ? (p.error ?? {}) : (p.output ?? {}), null, 2);
      details.append(pre);
      pushStep(details);
      continue;
    }

    if (event.type === "approval.requested") {
      flushText();
      const card = el("div", "approval-card");
      const head = el("div", "head");
      head.append(el("span", "risk", p.risk ?? "review"));
      head.append(el("b", "", p.toolName ?? "tool"));
      card.append(head);
      card.append(el("div", "why", p.reason ?? "This action needs your decision."));
      const acts = el("div", "acts");
      const yes = el("button", "ok sm", "Approve");
      yes.onclick = () => void decide(p.approvalId, "approve");
      const no = el("button", "err sm", "Reject");
      no.onclick = () => void decide(p.approvalId, "reject");
      acts.append(yes, no);
      card.append(acts);
      root.append(card);
      continue;
    }

    if (event.type === "verification.recorded") {
      const log = ensureWorklog();
      const result = p.result ?? {};
      const item = el("div", `wl-item ${result.status === "passed" ? "ok" : "err"}`);
      item.append(el("div", "wl-kind", "verify"));
      const body = el("div", "wl-body");
      body.append(el("b", "", result.status ?? "unknown"));
      body.append(el("span", "", ` ${result.summary ?? ""}`));
      item.append(body);
      log.append(item);
      continue;
    }

    if (event.type === "task.failed") {
      flushText();
      const { body } = ensureTurn();
      const block = el("div", "assistant-text");
      block.innerHTML = renderMarkdown(`**Failed:** ${p.error?.message ?? "unknown error"}`);
      body.append(block);
      lastAssistantTurn = null;
      worklog = null;
      continue;
    }
  }

  flushText();
  if (root.childNodes.length === 0) {
    renderWelcome();
  }
  scrollToBottom(true);
}

/* ---------------- live event fan-out ---------------- */

function applyLiveEvent(event) {
  if (event.taskId !== state.current) {
    void refreshTasks();
    return;
  }

  if (event.type === "model.delta") {
    const root = threadRoot();
    root.querySelector(".turn.thinking")?.remove();
    let live = root.querySelector(".live-text");
    if (live === null) {
      const turn = el("div", "turn turn-assistant");
      const avatar = el("div", "avatar", "◆");
      const body = el("div", "body");
      live = el("div", "assistant-text live-text cursor");
      body.append(live);
      turn.append(avatar, body);
      root.append(turn);
      state.live.set("buffer", "");
    }
    state.live.set("buffer", (state.live.get("buffer") ?? "") + (event.payload?.text ?? ""));
    live.innerHTML = renderMarkdown(state.live.get("buffer") ?? "");
    scrollToBottom();
    return;
  }

  // A request pauses the task and needs the badge to light up immediately.
  if (event.type === "approval.requested" || event.type === "approval.resolved" || event.type === "task.paused") {
    void refreshPending();
  }

  if (event.type === "task.failed" || event.type === "task.completed" || event.type === "session.ended" || event.type === "task.paused") {
    void refreshTasks();
    void refreshState();
    // Rebuild from the ledger so the streamed view matches what was recorded.
    void resyncThread();
  }

  // Any non-delta event ends the streaming bubble so the next one starts fresh.
  if (event.type !== "model.delta") {
    const stale = threadRoot().querySelector(".live-text");
    if (stale !== null && event.type !== "model.requested") {
      stale.classList.remove("cursor");
      state.live.set("buffer", "");
    }
  }
}

/* ---------------- inspector ---------------- */

async function refreshState() {
  if (state.current === null) return;
  const task = await api.runtime.task(state.current);
  const pane = $("pane-activity");
  pane.innerHTML = "";
  if (!task) {
    pane.innerHTML = '<div class="empty-hint">Task not found.</div>';
    return;
  }

  const card = el("div", "card");
  const title = el("div", "title");
  title.append(el("b", "", "This task"));
  card.append(title);
  const kv = el("dl", "kv");
  const rows = [
    ["status", task.status],
    ["runner", task.runnerType],
    ["events", String(task.sequence)],
    ["steps", task.steps === 0 ? "—" : String(task.steps)],
    ["tool calls", String(task.toolCalls)],
    ["cost", fmtCost(task.costUsd) || "—"]
  ];
  for (const [key, value] of rows) {
    kv.append(el("dt", "", key));
    kv.append(el("dd", "", value));
  }
  card.append(kv);
  pane.append(card);

  // Real prompt-token count from the last model call, not an event-based guess.
  const budget = task.contextBudget || state.settings?.contextTokenBudget || 32000;
  const used = budget > 0 ? Math.min(1, task.contextTokens / budget) : 0;
  const budgetCard = el("div", "card");
  const bTitle = el("div", "title");
  bTitle.append(el("b", "", "Context"));
  bTitle.append(el("span", `when ${used >= 0.85 ? "warn" : ""}`.trim(), `${Math.round(used * 100)}%`));
  budgetCard.append(bTitle);
  budgetCard.append(el("div", "body",
    `${task.contextTokens.toLocaleString()} / ${budget.toLocaleString()} tokens in the last request`));
  const meter = el("div", "meter");
  const fill = el("i");
  fill.style.width = `${Math.round(used * 100)}%`;
  if (used >= 0.85) fill.classList.add("warn");
  meter.append(fill);
  budgetCard.append(meter);
  budgetCard.append(el("div", "body",
    task.compressions === 0
      ? "Not compacted yet. Older turns are summarised automatically near the budget."
      : `Compacted ${task.compressions}× to stay inside the budget.`));
  pane.append(budgetCard);
}

async function refreshPending() {
  if (state.current === null) {
    $("pane-approvals").innerHTML = '<div class="empty-hint">Select a conversation first.</div>';
    return;
  }
  const pending = await api.runtime.approvals(state.current);
  const pane = $("pane-approvals");
  const count = $("approval-count");
  if (pending.length === 0) {
    count.hidden = true;
    pane.innerHTML = '<div class="empty-hint">Nothing waiting. Tool calls that need a decision appear here and pause the task.</div>';
    return;
  }
  count.hidden = false;
  count.textContent = String(pending.length);
  pane.innerHTML = "";
  const events = await api.runtime.events(state.current);
  for (const approvalId of pending) {
    const request = [...events].reverse().find(
      (event) => event.type === "approval.requested" && event.payload?.approvalId === approvalId
    );
    const card = el("div", "approval-card");
    const head = el("div", "head");
    head.append(el("span", "risk", request?.payload?.risk ?? "review"));
    head.append(el("b", "", request?.payload?.toolName ?? "tool"));
    card.append(head);
    card.append(el("div", "why", request?.payload?.reason ?? ""));
    const acts = el("div", "acts");
    const yes = el("button", "ok sm", "Approve");
    yes.onclick = () => void decide(approvalId, "approve");
    const no = el("button", "err sm", "Reject");
    no.onclick = () => void decide(approvalId, "reject");
    acts.append(yes, no);
    card.append(acts);
    pane.append(card);
  }
}

async function refreshTools() {
  const tools = await api.runtime.tools();
  const pane = $("pane-tools");
  pane.innerHTML = "";
  if (tools.length === 0) {
    pane.innerHTML = '<div class="empty-hint">No tools registered.</div>';
    return;
  }
  const card = el("div", "card");
  card.append(el("div", "title")).append(el("b", "", "Available tools"));
  for (const tool of tools) {
    const row = el("div", "tool-row");
    row.append(el("code", "", tool.name));
    row.append(el("span", "", tool.description));
    card.append(row);
  }
  pane.append(card);
  const note = el("div", "empty-hint");
  note.textContent = "Writes and other risky calls go through the approval gate before they run.";
  pane.append(note);
}

/* ---------------- actions ---------------- */

async function openTask(taskId) {
  state.current = taskId;
  state.live.clear();
  const task = state.tasks.find((candidate) => candidate.taskId === taskId);
  $("conv-title").textContent = task?.goal ?? "Conversation";
  renderConversations();
  const events = await api.runtime.events(taskId);
  renderThread(events);
  await refreshState();
  await refreshPending();
  updateActionButtons();
}

/** Re-renders the open conversation from its event log. */
async function resyncThread() {
  if (state.current === null) return;
  const events = await api.runtime.events(state.current);
  state.live.clear();
  renderThread(events);
  scrollToBottom();
}

async function refreshTasks() {
  state.tasks = await api.runtime.tasks();
  const current = state.tasks.find((task) => task.taskId === state.current);
  state.running = current?.status === "running" || current?.status === "pending";
  renderConversations();
}

function updateActionButtons() {
  const enabled = state.current !== null;
  $("btn-verify").disabled = !enabled;
  $("btn-rollback").disabled = !enabled;
  $("btn-cancel").disabled = !enabled;
}

/** Cancelled conversations stay closed; every other status can take a follow-up. */
function canContinue() {
  const task = state.tasks.find((item) => item.taskId === state.current);
  return task !== undefined && task.status !== "cancelled" && !state.running;
}

/** Reads a picked or pasted image into the pending attachment list. */
async function addAttachment(file) {
  if (!file.type.startsWith("image/")) return;
  if (state.attachments.length >= 4) return;
  const data = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  if (data === "") return;
  state.attachments.push({ mediaType: file.type, data, name: file.name || "pasted image" });
  renderAttachments();
}

function renderAttachments() {
  const box = $("attachments");
  box.innerHTML = "";
  box.hidden = state.attachments.length === 0;
  state.attachments.forEach((image, index) => {
    const chip = el("div", "attachment");
    const thumb = document.createElement("img");
    thumb.src = `data:${image.mediaType};base64,${image.data}`;
    thumb.alt = image.name;
    chip.append(thumb);
    const remove = el("button", "attachment-x", "×");
    remove.onclick = () => {
      state.attachments.splice(index, 1);
      renderAttachments();
    };
    chip.append(remove);
    box.append(chip);
  });
}

/** Paints the user's turn before the runtime answers, so the composer never feels stuck. */
function appendOptimisticUserTurn(text, images = []) {
  const root = threadRoot();
  const welcome = root.querySelector(".welcome");
  if (welcome !== null) welcome.remove();
  const turn = el("div", "turn turn-user");
  const bubble = el("div", "bubble");
  bubble.append(el("div", "", text));
  if (images.length > 0) {
    const strip = el("div", "bubble-images");
    for (const image of images) {
      const thumb = document.createElement("img");
      thumb.src = `data:${image.mediaType};base64,${image.data}`;
      strip.append(thumb);
    }
    bubble.append(strip);
  }
  turn.append(bubble);
  root.append(turn);
  const thinking = el("div", "turn turn-assistant thinking");
  const avatar = el("div", "avatar", "◆");
  const body = el("div", "body");
  const live = el("div", "thinking-line");
  live.append(el("span", "spinner"));
  live.append(el("span", "", "Thinking…"));
  body.append(live);
  thinking.append(avatar, body);
  root.append(thinking);
  scrollToBottom(true);
}

async function send() {
  const goal = $("goal").value.trim();
  if ((goal === "" && state.attachments.length === 0) || state.sending) return;
  state.sending = true;
  $("send").disabled = true;
  $("send").textContent = "Sending…";
  const attachments = state.attachments.map((image) => ({ mediaType: image.mediaType, data: image.data }));
  appendOptimisticUserTurn(goal, state.attachments);
  state.attachments = [];
  renderAttachments();
  try {
    // A follow-up typed after the conversation ended continues that task, so
    // the model sees its own history instead of a fresh goal.
    const continued = state.current !== null && canContinue();
    if (continued) {
      await api.runtime.send(state.current, goal, attachments);
    } else {
      const runnerType = $("runner").value;
      const created = await api.runtime.run(goal, attachments, runnerType === "" ? undefined : runnerType);
      state.current = created.taskId;
    }
    $("goal").value = "";
    autoGrow();
    await refreshTasks();
    if (!continued) {
      await openTask(state.current);
    } else {
      await refreshState();
      await refreshPending();
    }
  } finally {
    state.sending = false;
    $("send").disabled = false;
    $("send").textContent = "Send";
  }
}

async function decide(approvalId, decision) {
  await api.runtime.approve(state.current, approvalId, decision);
  await refreshPending();
  await refreshTasks();
}

function autoGrow() {
  const goal = $("goal");
  goal.style.height = "auto";
  goal.style.height = `${Math.min(220, goal.scrollHeight)}px`;
}

/* ---------------- settings ---------------- */

function fillSettings(settings) {
  state.settings = settings;
  $("set-provider").value = settings.provider;
  $("set-model").value = settings.model;
  $("set-effort").value = settings.reasoningEffort ?? "medium";
  $("set-base-url").value = settings.baseUrl;
  $("set-workspace").value = shortPath(settings.workspaceRoot);
  $("set-auto-approve").checked = settings.autoApproveMedium;
  $("set-outside").checked = settings.allowOutsideWorkspace === true;
  $("set-voice").checked = settings.voiceEnabled;
  $("set-enter").checked = settings.sendOnEnter;
  $("set-max-turns").value = String(settings.maxTurns);
  $("set-budget").value = String(settings.contextTokenBudget);
  $("set-in-price").value = String(settings.inputPricePerMillion);
  $("set-out-price").value = String(settings.outputPricePerMillion);
  $("base-url-field").hidden = settings.provider === "anthropic";
  const keyName = settings.provider === "anthropic" ? settings.hasAnthropicKey : settings.hasOpenAIKey;
  $("key-status").textContent = keyName
    ? "A key is stored in the macOS Keychain. Paste a new one to replace it."
    : "No key stored yet. Without a key the app runs the offline model.";
  $("hint").textContent = settings.sendOnEnter ? "↵ send · ⇧↵ newline" : "⌘↵ send · ↵ newline";
  document.documentElement.dataset.theme = settings.theme;
}

async function saveSettings() {
  const patch = {
    provider: $("set-provider").value,
    model: $("set-model").value.trim(),
    reasoningEffort: $("set-effort").value,
    baseUrl: $("set-base-url").value.trim(),
    autoApproveMedium: $("set-auto-approve").checked,
    allowOutsideWorkspace: $("set-outside").checked,
    voiceEnabled: $("set-voice").checked,
    sendOnEnter: $("set-enter").checked,
    maxTurns: Number($("set-max-turns").value),
    contextTokenBudget: Number($("set-budget").value),
    inputPricePerMillion: Number($("set-in-price").value),
    outputPricePerMillion: Number($("set-out-price").value)
  };
  const result = await api.settings.update(patch);
  fillSettings({ ...result.settings, hasOpenAIKey: state.settings.hasOpenAIKey, hasAnthropicKey: state.settings.hasAnthropicKey });
  renderProvider(result.provider);
}

async function saveKey() {
  const value = $("set-key").value.trim();
  if (value === "") return;
  const kind = state.settings.provider === "anthropic" ? "anthropic" : "openai";
  const result = await api.settings.setKey(kind, value);
  $("set-key").value = "";
  fillSettings({
    ...state.settings,
    hasOpenAIKey: kind === "openai" ? result.hasKey : state.settings.hasOpenAIKey,
    hasAnthropicKey: kind === "anthropic" ? result.hasKey : state.settings.hasAnthropicKey
  });
  renderProvider(result.provider);
}

function openSettings() {
  $("overlay").hidden = false;
  void api.settings.get().then(fillSettings);
}

function closeSettings() {
  $("overlay").hidden = true;
}

/* ---------------- wiring ---------------- */

function selectPane(name) {
  for (const button of $("tabs").querySelectorAll("button")) {
    button.classList.toggle("active", button.dataset.pane === name);
  }
  for (const pane of document.querySelectorAll(".pane")) {
    pane.hidden = pane.dataset.pane !== name;
  }
  if (name === "tools") void refreshTools();
  if (name === "approvals") void refreshPending();
}

function wire() {
  $("tabs").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (button) selectPane(button.dataset.pane);
  });

  $("send").onclick = () => void send();
  $("goal").addEventListener("input", autoGrow);
  $("goal").addEventListener("keydown", (event) => {
    const enterSends = state.settings?.sendOnEnter !== false;
    if (event.key !== "Enter") return;
    if (event.shiftKey) return;
    if (enterSends && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      void send();
    } else if (!enterSends && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void send();
    }
  });

  $("new-chat").onclick = () => {
    state.current = null;
    state.live.clear();
    $("conv-title").textContent = "New conversation";
    renderConversations();
    renderWelcome();
    updateActionButtons();
    $("goal").focus();
  };

  $("search").addEventListener("input", () => {
    state.search = $("search").value;
    renderConversations();
  });

  $("btn-settings").onclick = openSettings;
  $("btn-storage").onclick = () => void api.ui.openStorage();
  $("fetch-models").onclick = async () => {
    const status = $("model-status");
    const button = $("fetch-models");
    button.disabled = true;
    status.textContent = "Fetching…";
    try {
      const models = await api.runtime.models();
      const list = $("model-options");
      list.innerHTML = "";
      for (const entry of models) {
        const option = document.createElement("option");
        option.value = entry.id;
        if (entry.contextLength !== undefined) option.label = `${entry.contextLength.toLocaleString()} ctx`;
        list.append(option);
      }
      status.textContent = models.length === 0
        ? "This endpoint did not report any models. Type the name manually."
        : `${models.length} models available — start typing a name to pick one.`;
    } catch (error) {
      status.textContent = `Could not fetch models: ${error?.message ?? error}`;
    } finally {
      button.disabled = false;
    }
  };

  $("settings-close").onclick = closeSettings;
  $("settings-done").onclick = () => {
    void saveSettings();
    closeSettings();
  };
  $("set-key-save").onclick = () => void saveKey();
  $("set-provider").addEventListener("change", () => {
    $("base-url-field").hidden = $("set-provider").value === "anthropic";
  });
  $("set-workspace-pick").onclick = () => {
    void api.settings.pickWorkspace().then((result) => {
      if (!result.canceled) {
        $("set-workspace").value = shortPath(result.workspaceRoot);
        state.settings = { ...state.settings, workspaceRoot: result.workspaceRoot };
      }
    });
  };

  $("btn-verify").onclick = () => {
    if (state.current === null) return;
    void api.runtime.verify(state.current).then((result) => {
      const pane = $("pane-activity");
      const card = el("div", "card");
      const title = el("div", "title");
      title.append(el("b", "", `Verification: ${result.status}`));
      card.append(title);
      card.append(el("div", "body", result.summary));
      pane.prepend(card);
    });
  };

  $("btn-rollback").onclick = () => {
    if (state.current === null) return;
    void api.runtime.rollback(state.current).then(() => openTask(state.current));
  };

  // Attachments live only until send(); they are sent as base64 so the ledger
  // records exactly what the model saw.
  $("attach").onclick = () => $("attach-input").click();
  $("attach-input").addEventListener("change", (event) => {
    for (const file of event.target.files ?? []) void addAttachment(file);
    event.target.value = "";
  });
  $("goal").addEventListener("paste", (event) => {
    const files = [...(event.clipboardData?.items ?? [])]
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file) => file !== null);
    if (files.length === 0) return;
    event.preventDefault();
    for (const file of files) void addAttachment(file);
  });

  $("btn-cancel").onclick = () => {
    if (state.current === null) return;
    void api.runtime.cancel(state.current).then(() => refreshTasks());
  };

  $("mem-add").onclick = () => {
    const key = $("mem-key").value.trim();
    const content = $("mem-content").value.trim();
    if (key === "" || content === "") return;
    void api.memory.add(key, content, $("mem-scope").value).then(() => {
      $("mem-key").value = "";
      $("mem-content").value = "";
      $("mem-query").value = key;
      return searchMemory();
    });
  };

  $("mem-search").onclick = () => void searchMemory();
  $("mem-query").addEventListener("keydown", (event) => {
    if (event.key === "Enter") void searchMemory();
  });

  api.ui.onOpenSettings(openSettings);
  api.ui.onNewConversation(() => $("new-chat").click());

  api.runtime.onProvider(renderProvider);
  api.runtime.onEvent(applyLiveEvent);
}

async function searchMemory() {
  const query = $("mem-query").value.trim();
  // An empty query lists everything: users need to see what is stored without
  // guessing a keyword first.
  const results = query === "" ? await api.memory.list("project") : await api.memory.search(query);
  const box = $("mem-results");
  box.innerHTML = "";
  if (results.length === 0) {
    box.innerHTML = `<div class="empty-hint">${query === "" ? "No memory saved yet." : "No matches."}</div>`;
    return;
  }
  for (const record of results) {
    const card = el("div", "card");
    const title = el("div", "title");
    title.append(el("b", "", record.key));
    title.append(el("span", "when", `${record.scope} · v${record.version}`));
    card.append(title);
    card.append(el("div", "body", record.content));
    const acts = el("div", "row");
    acts.style.marginTop = "8px";
    const del = el("button", "err sm", "Delete");
    del.onclick = () => void api.memory.delete(record.memoryId).then(searchMemory);
    acts.append(del);
    card.append(acts);
    box.append(card);
  }
}

async function boot() {
  wire();
  const settings = await api.settings.get();
  fillSettings(settings);
  // The main process pushes the provider as soon as the window finishes loading.
  api.runtime.onProvider(renderProvider);
  await refreshTasks();
  renderWelcome();
  updateActionButtons();
  $("goal").focus();
}

void boot();
