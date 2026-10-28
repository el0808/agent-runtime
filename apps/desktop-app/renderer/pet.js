// Pet renderer. Tries the imported Live2D model first; falls back to a drawn
// character when no model or Cubism runtime is present. State always comes from
// the runtime event stream — this file never infers it.

const params = new URLSearchParams(location.search);
// Same origin: the app server proxies /api to the gateway.
const GATEWAY = "/api";
const MODEL = params.get("model") ?? "models/yachiyo-kaguya/八千代辉夜姬.model3.json";

const STATES = ["idle", "listening", "thinking", "working", "waiting_approval", "verifying", "success", "error", "sleeping"];
const PALETTE = {
  idle: "#6ea8fe", listening: "#a5b4fc", thinking: "#c4b5fd", working: "#6ea8fe",
  waiting_approval: "#fbbf24", verifying: "#4ade80", success: "#4ade80",
  error: "#f87171", sleeping: "#64748b"
};

const bubble = document.getElementById("bubble");
const stateLabel = document.getElementById("state");
const note = document.getElementById("note");

let state = "idle";
let mouth = 0;
let targetMouth = 0;
let emotion = "neutral";
let model = null;

function setState(next) {
  if (!STATES.includes(next)) return;
  state = next;
  stateLabel.textContent = next;
  applyExpression(next);
}

function applyExpression(next) {
  if (model === null) return;
  const expression = next === "success" ? "笑咪咪" : next === "error" ? "眯眯眼" : null;
  if (emotion === expression) return;
  emotion = expression;
  try {
    if (expression === null) model.internalModel.motionManager.expressionManager?.resetExpression?.();
    else model.expression(expression);
  } catch { /* expression set may be absent */ }
}

function playMotion(group) {
  if (model === null) return;
  try { model.motion(group); } catch { /* motion group may be absent */ }
}

let bubbleTimer;
function showBubble(text) {
  bubble.textContent = text.slice(-300);
  bubble.classList.add("on");
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => bubble.classList.remove("on"), 4000);
}

function speak(text) {
  targetMouth = Math.min(1, 0.35 + text.length / 20);
}

/* ---------------- event mapping (mirrors packages/pet-adapter) ---------------- */

function mapState(event) {
  switch (event.type) {
    case "task.created": return "listening";
    case "task.started":
    case "session.started":
    case "model.requested":
    case "model.delta": return "thinking";
    case "tool.requested": return "working";
    case "approval.requested": return "waiting_approval";
    case "verification.recorded": return "verifying";
    case "context.compressed": return "thinking";
    case "task.completed": return "success";
    case "session.ended": return event.payload?.status === "paused" ? "sleeping"
      : event.payload?.status === "failed" ? "error" : "idle";
    case "task.failed":
    case "model.failed":
    case "tool.failed": return "error";
    case "task.paused": return "sleeping";
    case "task.cancelled": return "idle";
    default: return "working";
  }
}

function applyEvent(event) {
  setState(mapState(event));
  if (event.type === "model.delta") {
    const text = event.payload?.text ?? "";
    speak(text);
    showBubble(text);
  }
  if (event.type === "task.completed") {
    showBubble("完成");
    playMotion("Tap");
  }
  if (event.type === "tool.requested") playMotion("Tap");
}

const EVENT_TYPES = [
  "task.created", "task.started", "task.paused", "task.resumed", "task.completed",
  "task.failed", "task.cancelled", "session.started", "session.ended",
  "model.requested", "model.delta", "model.completed", "model.failed",
  "tool.requested", "tool.completed", "tool.failed", "approval.requested",
  "verification.recorded", "context.compressed"
];

function connect() {
  const source = new EventSource(`${GATEWAY}/events`);
  for (const type of EVENT_TYPES) {
    source.addEventListener(type, (message) => {
      try { applyEvent(JSON.parse(message.data)); } catch { /* ignore */ }
    });
  }
  source.onopen = () => { note.textContent = ""; };
  source.onerror = () => { note.textContent = "gateway offline"; };
}

/* ---------------- fallback character ---------------- */

const fallback = document.getElementById("fallback");
const ctx = fallback.getContext("2d");
let bob = 0;
let drawFallback = true;

function paint(t) {
  const accent = PALETTE[state];
  const cx = fallback.width / 2;
  const cy = fallback.height / 2 + Math.sin(bob) * 3;

  ctx.clearRect(0, 0, fallback.width, fallback.height);

  const glow = ctx.createRadialGradient(cx, cy + 110, 6, cx, cy + 110, 130);
  glow.addColorStop(0, `${accent}44`);
  glow.addColorStop(1, "transparent");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, fallback.width, fallback.height);

  ctx.fillStyle = "#182030";
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.ellipse(cx, cy, 86, 100, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  const eyeY = cy - 22;
  const look = state === "thinking" ? Math.sin(t / 320) * 3 : 0;
  ctx.fillStyle = accent;
  for (const dx of [-30, 30]) {
    ctx.beginPath();
    if (state === "sleeping" || state === "error") ctx.rect(cx + dx - 10, eyeY - 2, 20, 4);
    else ctx.ellipse(cx + dx + look, eyeY, 10, 13, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  targetMouth = Math.max(0, targetMouth - 0.018);
  mouth += (targetMouth - mouth) * 0.22;
  ctx.fillStyle = "#f472b6";
  ctx.beginPath();
  ctx.ellipse(cx, cy + 32, 18, 4 + mouth * 16, 0, 0, Math.PI * 2);
  ctx.fill();

  if (state === "working" || state === "verifying") {
    const angle = (t / 480) % (Math.PI * 2);
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(angle) * 106, cy + Math.sin(angle) * 106, 5, 0, Math.PI * 2);
    ctx.fill();
  }
  if (state === "waiting_approval") {
    const pulse = 1 + Math.sin(t / 240) * 0.05;
    ctx.strokeStyle = "#fbbf24";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, 108 * pulse, 0, Math.PI * 2);
    ctx.stroke();
  }

  bob += 0.028;
  if (drawFallback) requestAnimationFrame(paint);
}

requestAnimationFrame(paint);

/* ---------------- Live2D attempt ---------------- */

async function loadLive2D() {
  if (typeof window.PIXI === "undefined" || typeof window.Live2DModel === "undefined") {
    note.textContent = "live2d runtime not bundled — run pnpm import-live2d";
    return false;
  }
  try {
    const pixiApp = new window.PIXI.Application({
      view: document.getElementById("live2d"),
      backgroundAlpha: 0,
      autoStart: true,
      resizeTo: window
    });
    const loaded = await window.PIXI.live2d.Live2DModel.from(MODEL);
    pixiApp.stage.addChild(loaded);
    const scale = Math.min(window.innerWidth / loaded.width, window.innerHeight / loaded.height) * 0.95;
    loaded.scale.set(scale);
    loaded.x = (window.innerWidth - loaded.width * scale) / 2;
    loaded.y = (window.innerHeight - loaded.height * scale) / 2;
    loaded.anchor.set(0.5, 0.5);
    loaded.x = window.innerWidth / 2;
    loaded.y = window.innerHeight / 2;
    model = loaded;
    fallback.style.display = "none";
    drawFallback = false;
    note.textContent = "";
    return true;
  } catch (error) {
    note.textContent = `model failed: ${String(error.message ?? error).slice(0, 60)}`;
    return false;
  }
}

const usingLive2D = await loadLive2D();
if (usingLive2D) playMotion("Idle");
connect();

if (params.get("demo") === "1") {
  const script = [
    { type: "task.created", payload: {} },
    { type: "model.delta", payload: { text: "正在读取文件…" } },
    { type: "tool.requested", payload: { call: { toolName: "read_file" } } },
    { type: "approval.requested", payload: { risk: "medium", toolName: "write_file" } },
    { type: "verification.recorded", payload: {} },
    { type: "task.completed", payload: {} }
  ];
  let index = 0;
  setInterval(() => {
    applyEvent(script[index % script.length]);
    index += 1;
  }, 1600);
}
