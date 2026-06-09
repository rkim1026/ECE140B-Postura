// ── Posture Constants and Config ──────────────────────────
const POSTURE_DISPLAY_NAMES = {
  GOOD: "Good Posture ✓",
  MILD_SLOUCH: "Mild Slouch",
  SEVERE_SLOUCH: "Severe Slouch !!",
  LEANING_BACK: "Leaning Back",
};

const POSTURE_IMAGE_MAP = {
  GOOD: "/images/Good.png",
  MILD_SLOUCH: "/images/Slouch.png",
  SEVERE_SLOUCH: "/images/Slouch.png",
  LEANING_BACK: "/images/Back.png",
};

const COLLECT_LABELS = ["GOOD", "MILD_SLOUCH", "SEVERE_SLOUCH", "LEANING_BACK"];
const PILL_CLS = {
  GOOD: "lc-good",
  MILD_SLOUCH: "lc-mild",
  SEVERE_SLOUCH: "lc-severe",
  LEANING_BACK: "lc-leanback"
};

const WS_PATHS = ["/ws", "/ws/work_session"];

const VERT_MILD = 20;
const VERT_SEVERE = 35;
const MAX_GRAD = 150;
const GRID_SIZE = 64;

// ── Runtime State ─────────────────────────────────────────
let labelCounts = {};
let calVertStatic = null;
let calMeanStatic = null;
let calLbThresh = null;
let breakConfirmTimer = null;

let latestFrame = null;
let latestCalibration = null;
let latestBackendStatus = "waiting";

let ws = null;
let wsReconnectTimer = null;
let wsHeartbeatTimer = null;
let wsPathIndex = 0;

// ── Small helpers ─────────────────────────────────────────
function byId(id) {
  return document.getElementById(id);
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeArray(arr, len = GRID_SIZE, fill = 0) {
  const out = Array.isArray(arr) ? arr.slice(0, len) : [];
  while (out.length < len) out.push(fill);
  return out.map(v => (typeof v === "number" ? v : safeNum(v, fill)));
}

function formatGridValue(v) {
  const n = safeNum(v, 0);
  return Math.round(n);
}

function fmt(v) {
  const n = safeNum(v, 0);
  return (n >= 0 ? "+" : "") + n + " mm";
}

function prettyPostureName(label) {
  return POSTURE_DISPLAY_NAMES[label] || label || "Waiting";
}

function postureNote(label) {
  switch (label) {
    case "GOOD":
      return "Your posture is currently being detected as good posture.";
    case "MILD_SLOUCH":
      return "The live posture feed indicates mild slouching.";
    case "SEVERE_SLOUCH":
      return "The live posture feed indicates severe slouching.";
    case "LEANING_BACK":
      return "The live posture feed indicates you are leaning back.";
    default:
      return "When the ESP32 sends posture data, this panel will show the current posture and matching image.";
  }
}

function badgeClassForPosture(label) {
  if (label === "GOOD") return "badge good";
  if (label === "MILD_SLOUCH") return "badge mild";
  if (label === "SEVERE_SLOUCH") return "badge severe";
  if (label === "LEANING_BACK") return "badge leanback";
  return "badge neutral";
}

function imageForPosture(label, explicitImage = "") {
  if (explicitImage) return explicitImage;
  return POSTURE_IMAGE_MAP[label] || "";
}

// ── Color helpers ─────────────────────────────────────────
function devColor(dev, valid) {
  if (!valid) return "#cbd5e1";
  if (dev > 60) return "#1e3a8a";
  if (dev > 25) return "#1d4ed8";
  if (dev > 10) return "#0369a1";
  if (dev > -10) return "#065f46";
  if (dev > -30) return "#b45309";
  if (dev > -60) return "#b91c1c";
  return "#7f1d1d";
}

function distColor(dist, valid) {
  if (!valid || dist === 0) return "#cbd5e1";
  const t = Math.max(0, Math.min(1, (dist - 50) / 550));
  const r = Math.round(10 + (30 - 10) * t);
  const g = Math.round(200 + (50 - 200) * t);
  const b = Math.round(80 + (150 - 80) * t);
  return `rgb(${r},${g},${b})`;
}

// ── Placeholder / Grid rendering ──────────────────────────
function buildPlaceholderGrid(id, text = "—") {
  const el = byId(id);
  if (!el) return;
  el.innerHTML = "";
  for (let i = 0; i < GRID_SIZE; i++) {
    const z = document.createElement("div");
    z.className = "zone zone-placeholder";
    z.textContent = text;
    el.appendChild(z);
  }
}

function buildGrid(id, values, colorFn, validArr) {
  const el = byId(id);
  if (!el) return;

  const vals = normalizeArray(values, GRID_SIZE, 0);
  const valids = Array.isArray(validArr)
    ? normalizeArray(validArr, GRID_SIZE, 0).map(Boolean)
    : vals.map(v => safeNum(v, 0) !== 0);

  el.innerHTML = "";

  for (let i = 0; i < GRID_SIZE; i++) {
    const z = document.createElement("div");
    const valid = !!valids[i];
    const value = safeNum(vals[i], 0);

    z.className = "zone";
    z.style.background = colorFn(value, valid);
    z.textContent = valid ? formatGridValue(value) : "×";

    el.appendChild(z);
  }
}

function ensureInitialGrids() {
  buildPlaceholderGrid("live-grid", "—");
  buildPlaceholderGrid("cal-grid", "—");
}

// ── Sensor / status UI ────────────────────────────────────
function setSensorUi(status, hasFrame = false) {
  const statEl = byId("sensor-status");
  const dotEl = byId("sensor-dot");

  if (!statEl || !dotEl) return;

  const normalized = String(status || "").toLowerCase();

  if (normalized === "live" || normalized === "running" || hasFrame) {
    statEl.textContent = "Live — Receiving Data";
    statEl.className = "sensor-status live";
    dotEl.className = "sensor-dot live";
    return;
  }

  if (normalized === "calibrating") {
    statEl.textContent = "Calibrating Matrix...";
    statEl.className = "sensor-status connecting";
    dotEl.className = "sensor-dot connecting";
    return;
  }

  if (normalized === "offline" || normalized === "disconnected") {
    statEl.textContent = "Offline";
    statEl.className = "sensor-status offline";
    dotEl.className = "sensor-dot offline";
    return;
  }

  statEl.textContent = "Waiting for ESP32...";
  statEl.className = "sensor-status connecting";
  dotEl.className = "sensor-dot connecting";
}

function setTopPostureBadges(postureLabel) {
  const badgeMain = byId("posture-badge");
  const badgeTop = byId("posture-badge-top");
  const text = postureLabel ? prettyPostureName(postureLabel) : "WAITING";
  const cls = badgeClassForPosture(postureLabel);

  if (badgeMain) {
    badgeMain.textContent = text;
    badgeMain.className = cls;
  }

  if (badgeTop) {
    badgeTop.textContent = text;
    badgeTop.className = cls;
  }
}

// ── Gradient helpers ──────────────────────────────────────
function deltaClass(delta, mild, severe) {
  const abs = Math.abs(delta);
  if (abs < mild) return "delta-ok";
  if (abs < severe) return "delta-mild";
  return "delta-severe";
}

function deltaColor(delta, mild, severe) {
  const abs = Math.abs(delta);
  if (abs < mild) return "#22c55e";
  if (abs < severe) return "#f59e0b";
  return "#ef4444";
}

function setBar(fillId, value, maxVal) {
  const bar = byId(fillId);
  if (!bar) return;

  const pct = Math.min(Math.abs(safeNum(value, 0)) / maxVal, 0.5);
  if (value >= 0) {
    bar.style.left = "50%";
    bar.style.width = (pct * 100) + "%";
  } else {
    bar.style.left = (50 - pct * 100) + "%";
    bar.style.width = (pct * 100) + "%";
  }
}

function resetGradientPanel() {
  const ids = [
    "gp-cal-vert", "gp-live-vert", "gp-d-vert",
    "gp-live-mean", "gp-d-mean",
    "cgs-vert", "cgs-mean-dist", "cgs-leanback-thresh"
  ];

  ids.forEach(id => {
    const el = byId(id);
    if (el) el.textContent = "—";
  });

  const calMeanEl = byId("gp-cal-mean");
  if (calMeanEl) calMeanEl.textContent = "0 mm";

  const barIds = ["gp-bar-vert", "gp-bar-mean", "cgs-bar-vert"];
  barIds.forEach(id => {
    const el = byId(id);
    if (el) {
      el.style.left = "50%";
      el.style.width = "0";
    }
  });

  const summary = byId("cal-gradient-summary");
  if (summary) summary.style.display = "none";
}

function renderGradientPanel(calVert, liveVert, liveMean) {
  const dVert = safeNum(liveVert, 0) - safeNum(calVert, 0);
  const calMean = calMeanStatic ?? 0;
  const dMean = safeNum(liveMean, 0) - safeNum(calMean, 0);

  const calVertEl = byId("gp-cal-vert");
  const liveVertEl = byId("gp-live-vert");
  const dVertEl = byId("gp-d-vert");

  if (calVertEl) calVertEl.textContent = fmt(calVert);
  if (liveVertEl) liveVertEl.textContent = fmt(liveVert);
  if (dVertEl) {
    dVertEl.textContent = fmt(dVert);
    dVertEl.className = "gp-val gp-delta " + deltaClass(dVert, VERT_MILD, VERT_SEVERE);
  }

  const calMarker = byId("gp-marker-cal-vert");
  if (calMarker) {
    const calPct = 50 + Math.max(-50, Math.min(50, (safeNum(calVert, 0) / MAX_GRAD) * 50));
    calMarker.style.left = calPct + "%";
  }

  const barVert = byId("gp-bar-vert");
  if (barVert) {
    setBar("gp-bar-vert", safeNum(liveVert, 0), MAX_GRAD);
    barVert.style.background = deltaColor(dVert, VERT_MILD, VERT_SEVERE);
  }

  const calMeanEl = byId("gp-cal-mean");
  const liveMeanEl = byId("gp-live-mean");
  const dMeanEl = byId("gp-d-mean");

  if (calMeanEl) calMeanEl.textContent = "0 mm";
  if (liveMeanEl) liveMeanEl.textContent = fmt(liveMean);
  if (dMeanEl) {
    dMeanEl.textContent = fmt(dMean);
    const lbT = calLbThresh ?? -150;
    const cls = dMean <= lbT ? "delta-leanback" : dMean < -30 ? "delta-mild" : "delta-ok";
    dMeanEl.className = "gp-val gp-delta " + cls;
  }

  const barMean = byId("gp-bar-mean");
  if (barMean) {
    setBar("gp-bar-mean", safeNum(liveMean, 0), MAX_GRAD);
    const lbT = calLbThresh ?? -150;
    barMean.style.background = safeNum(liveMean, 0) <= lbT ? "#818cf8" : "#7a8eaa";
  }
}

// ── Calibration summary ───────────────────────────────────
function renderCalSummary(cal) {
  const summary = byId("cal-gradient-summary");
  if (!summary) return;

  summary.style.display = "block";

  const cv = safeNum(cal.cal_vert, 0);
  const md = safeNum(cal.cal_mean_dist, 0);
  const lb = safeNum(cal.leanback_thresh, 0);

  const vertEl = byId("cgs-vert");
  const meanEl = byId("cgs-mean-dist");
  const threshEl = byId("cgs-leanback-thresh");

  if (vertEl) vertEl.textContent = fmt(cv);
  if (meanEl) meanEl.textContent = md + " mm";
  if (threshEl) threshEl.textContent = lb + " mm (meanDev trigger)";

  const barVert = byId("cgs-bar-vert");
  if (barVert) setBar("cgs-bar-vert", cv, MAX_GRAD);
}

// ── Posture display ───────────────────────────────────────
function setPostureWaitingUi() {
  const waiting = byId("posture-waiting-state");
  const banner = byId("posture-banner");
  const note = byId("posture-banner-note");
  const sourceState = byId("posture-source-state");
  const streamState = byId("posture-stream-state");
  const img = byId("posture-banner-img");
  const imgEmpty = byId("posture-banner-empty");

  if (waiting) waiting.style.display = "flex";
  if (banner) banner.style.display = "none";
  if (note) note.textContent = postureNote("");
  if (sourceState) sourceState.textContent = "Waiting for MQTT";
  if (streamState) streamState.textContent = "No frames yet";
  if (img) {
    img.style.display = "none";
    img.removeAttribute("src");
  }
  if (imgEmpty) imgEmpty.style.display = "flex";

  setTopPostureBadges("");
}

function updatePostureBanner(postureLabel, postureImage) {
  const waiting = byId("posture-waiting-state");
  const banner = byId("posture-banner");
  const img = byId("posture-banner-img");
  const imgEmpty = byId("posture-banner-empty");
  const labelEl = byId("posture-banner-label");
  const note = byId("posture-banner-note");
  const sourceState = byId("posture-source-state");
  const streamState = byId("posture-stream-state");

  if (!banner || !labelEl) return;

  if (!postureLabel) {
    setPostureWaitingUi();
    return;
  }

  if (waiting) waiting.style.display = "none";
  banner.style.display = "flex";

  labelEl.textContent = prettyPostureName(postureLabel);
  labelEl.className = "posture-banner-label posture-label-" + postureLabel.toLowerCase();

  if (sourceState) sourceState.textContent = "ESP32 via MQTT";
  if (streamState) streamState.textContent = "Live frames received";
  if (note) note.textContent = postureNote(postureLabel);

  const resolvedImage = imageForPosture(postureLabel, postureImage);

  if (img && resolvedImage) {
    if (img.src !== location.origin + resolvedImage) {
      img.src = resolvedImage;
    }
    img.alt = prettyPostureName(postureLabel);
    img.style.display = "block";
    if (imgEmpty) imgEmpty.style.display = "none";
  } else {
    if (img) {
      img.style.display = "none";
      img.removeAttribute("src");
    }
    if (imgEmpty) imgEmpty.style.display = "flex";
  }

  setTopPostureBadges(postureLabel);
}

// ── Live / calibration panels ─────────────────────────────
function resetLiveGridUi() {
  buildPlaceholderGrid("live-grid", "—");

  const hint = byId("live-grid-hint");
  if (hint) {
    hint.textContent = "Waiting for live sensor frames. The 8×8 grid will fill as soon as MQTT data is received.";
  }

  setTopPostureBadges("");
  setPostureWaitingUi();

  const gpLiveVert = byId("gp-live-vert");
  const gpDVert = byId("gp-d-vert");
  const gpLiveMean = byId("gp-live-mean");
  const gpDMean = byId("gp-d-mean");

  if (gpLiveVert) gpLiveVert.textContent = "—";
  if (gpDVert) gpDVert.textContent = "—";
  if (gpLiveMean) gpLiveMean.textContent = "—";
  if (gpDMean) gpDMean.textContent = "—";
}

function resetCalibrationUi() {
  latestCalibration = null;
  calVertStatic = null;
  calMeanStatic = null;
  calLbThresh = null;

  buildPlaceholderGrid("cal-grid", "—");

  const hint = byId("cal-grid-hint");
  if (hint) {
    hint.textContent = "No calibration baseline yet. Press “Calibrate Good Posture” to populate this 8×8 reference grid.";
  }

  const summary = byId("cal-gradient-summary");
  if (summary) summary.style.display = "none";
}

function applyCalibration(cal) {
  if (!cal) return;

  latestCalibration = cal;
  calVertStatic = safeNum(cal.cal_vert, 0);
  calMeanStatic = safeNum(cal.cal_mean_dist, 0);
  calLbThresh = safeNum(cal.leanback_thresh, -150);

  const baseline = normalizeArray(cal.baseline, GRID_SIZE, 0);
  const valid = normalizeArray(cal.valid, GRID_SIZE, 0).map(Boolean);

  buildGrid("cal-grid", baseline, distColor, valid);
  renderCalSummary(cal);

  const hint = byId("cal-grid-hint");
  if (hint) {
    hint.textContent = "Calibration baseline received from backend.";
  }
}

function inferValidMaskFromFrame(frame) {
  if (Array.isArray(frame.valid)) {
    return normalizeArray(frame.valid, GRID_SIZE, 0).map(Boolean);
  }

  if (Array.isArray(frame.grid)) {
    return normalizeArray(frame.grid, GRID_SIZE, 0).map(v => safeNum(v, 0) > 0);
  }

  if (Array.isArray(frame.dev)) {
    return normalizeArray(frame.dev, GRID_SIZE, 0).map(v => safeNum(v, 0) !== 0);
  }

  return new Array(GRID_SIZE).fill(false);
}

function applyFrame(frame, payload = {}) {
  if (!frame) return;

  latestFrame = frame;

  const dev = normalizeArray(frame.dev, GRID_SIZE, 0);
  const valid = inferValidMaskFromFrame(frame);

  buildGrid("live-grid", dev, devColor, valid);

  const hint = byId("live-grid-hint");
  if (hint) {
    hint.textContent = "Live sensor frame received from backend.";
  }

  const postureLabel = payload.posture_label || frame.posture || "";
  const postureImage = imageForPosture(postureLabel, payload.posture_image || "");
  updatePostureBanner(postureLabel, postureImage);

  const calVertForPanel =
    frame.cal_vert ??
    calVertStatic ??
    latestCalibration?.cal_vert ??
    0;

  renderGradientPanel(
    safeNum(calVertForPanel, 0),
    safeNum(frame.vert, 0),
    safeNum(frame.mean, 0)
  );
}

// ── Data Collection Helpers ───────────────────────────────
function updateCounter(total) {
  const el = byId("csv-count");
  if (el) el.textContent = total;
}

function updateLabelCounts() {
  const el = byId("label-counts");
  if (!el) return;

  el.innerHTML = COLLECT_LABELS.map(lbl => {
    const count = labelCounts[lbl] || 0;
    const pretty = lbl.replace(/_/g, " ");
    const cls = PILL_CLS[lbl] || "";
    return `<span class="lc-pill ${count > 0 ? "has-data" : ""} ${cls}">${pretty} <b>${count}</b></span>`;
  }).join("");
}

async function savePosture(label) {
  const stat = byId("collect-status");
  if (stat) {
    stat.textContent = "Saving...";
    stat.className = "collect-status";
  }

  try {
    const res = await fetch("/api/save-posture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label })
    });

    const data = await res.json();

    if (data.success) {
      if (stat) {
        stat.textContent = `Saved ${label} (Row #${data.csv_count})`;
        stat.className = "collect-status ok";
      }
      updateCounter(data.csv_count);
      labelCounts[label] = (labelCounts[label] || 0) + 1;
      updateLabelCounts();
    } else {
      if (stat) {
        stat.textContent = "Error: " + (data.error || "Unknown error");
        stat.className = "collect-status err";
      }
    }
  } catch (_err) {
    if (stat) {
      stat.textContent = "Network Error";
      stat.className = "collect-status err";
    }
  }
}

// ── Break Time ────────────────────────────────────────────
async function startBreak() {
  await fetch("/api/break/start?demo=true", { method: "POST" });
  const overlay = byId("break-overlay");
  const box = byId("break-confirm-box");
  if (overlay) overlay.style.display = "flex";
  if (box) box.style.display = "block";
}

async function endBreak() {
  clearTimeout(breakConfirmTimer);
  await fetch("/api/break/end", { method: "POST" });
  const overlay = byId("break-overlay");
  const box = byId("break-confirm-box");
  if (overlay) overlay.style.display = "none";
  if (box) box.style.display = "none";
}

async function skipBreak() {
  clearTimeout(breakConfirmTimer);

  const res = await fetch("/api/break/skip", { method: "POST" });
  const data = await res.json();

  const overlay = byId("break-overlay");
  const box = byId("break-confirm-box");
  if (overlay) overlay.style.display = "none";
  if (box) box.style.display = "none";

  if (data.tip) {
    const tipSource = byId("tip-source");
    const tipSummary = byId("tip-summary");
    const tipLink = byId("tip-link");
    const tipOverlay = byId("tip-overlay");

    if (tipSource) tipSource.textContent = "Source: " + data.tip.source;
    if (tipSummary) tipSummary.textContent = data.tip.summary;
    if (tipLink) tipLink.href = data.tip.url;
    if (tipOverlay) tipOverlay.style.display = "flex";
  }
}

function closeTip() {
  const tipOverlay = byId("tip-overlay");
  if (tipOverlay) tipOverlay.style.display = "none";
}

// ── Session Timer Logic ───────────────────────────────────
let sessionTimerInterval = null;
let sessionSecondsLeft = 30;
let isSessionActive = false;

function updateTimerDisplay() {
  const display = byId("timer-display");
  if (!display) return;

  const m = Math.floor(sessionSecondsLeft / 60);
  const s = sessionSecondsLeft % 60;
  display.textContent = `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function startSession() {
  const btn = byId("start-session-btn");
  const btnText = byId("start-btn-text");

  if (!btn || !btnText) return;

  if (isSessionActive) {
    clearInterval(sessionTimerInterval);
    isSessionActive = false;
    btnText.textContent = "Resume Session";
    btn.style.background = "linear-gradient(135deg, #4f6ef7 0%, #3730c4 100%)";
    fetch("/api/session/stop", { method: "POST" })
      .then(r => r.json()).then(d => console.log("[Session] stopped", d))
      .catch(e => console.error("[Session] stop failed", e));
    return;
  }

  isSessionActive = true;
  btnText.textContent = "Pause Session";
  btn.style.background = "#ef4444";
  fetch("/api/session/start", { method: "POST" })
    .then(r => r.json()).then(d => console.log("[Session] started", d))
    .catch(e => console.error("[Session] start failed", e));

  sessionTimerInterval = setInterval(() => {
    if (sessionSecondsLeft > 0) {
      sessionSecondsLeft--;
      updateTimerDisplay();
      return;
    }

    clearInterval(sessionTimerInterval);
    isSessionActive = false;
    btnText.textContent = "Start Session";
    btn.style.background = "linear-gradient(135deg, #4f6ef7 0%, #3730c4 100%)";
    sessionSecondsLeft = 30;
    updateTimerDisplay();
    fetch("/api/session/stop", { method: "POST" })
      .then(r => r.json()).then(d => console.log("[Session] auto-stopped", d))
      .catch(e => console.error("[Session] auto-stop failed", e));
    startBreak();
  }, 1000);
}

// ── Calibration Button Logic ──────────────────────────────
async function startCalibration() {
  const calibrateBtn = byId("cal-btn");
  if (!calibrateBtn) return;

  try {
    await fetch("/api/calibrate", { method: "POST" });
  } catch (err) {
    console.error("Failed to send calibration command", err);
  }

  calibrateBtn.disabled = true;
  let timeLeft = 5;
  calibrateBtn.innerHTML = `⏳ Calibrating... Keep still (${timeLeft}s)`;

  const countdown = setInterval(() => {
    timeLeft--;

    if (timeLeft > 0) {
      calibrateBtn.innerHTML = `⏳ Calibrating... Keep still (${timeLeft}s)`;
      return;
    }

    clearInterval(countdown);
    calibrateBtn.disabled = false;
    calibrateBtn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2">
        <circle cx="12" cy="12" r="10"></circle>
        <circle cx="12" cy="12" r="6"></circle>
        <circle cx="12" cy="12" r="2"></circle>
      </svg>
      Calibrate Good Posture
    `;
  }, 1000);
}

// ── API restore helpers ───────────────────────────────────
async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

async function restoreBreakState() {
  try {
    const d = await fetchJson("/api/break/status");
    if (d.break_active) {
      const overlay = byId("break-overlay");
      const box = byId("break-confirm-box");
      if (overlay) overlay.style.display = "flex";
      if (box) box.style.display = "block";
    }
  } catch (err) {
    console.error("Failed to restore break status", err);
  }
}

async function restoreStatusSnapshot() {
  try {
    const d = await fetchJson("/api/status");

    latestBackendStatus = d.status || "waiting";
    setSensorUi(latestBackendStatus, !!d.has_frame);

    if (d.csv_count !== undefined) updateCounter(d.csv_count);

    if (d.posture_label) {
      updatePostureBanner(d.posture_label, imageForPosture(d.posture_label, d.posture_image || ""));
    } else {
      setPostureWaitingUi();
    }

    if (!d.has_frame) {
      resetLiveGridUi();
    }
  } catch (err) {
    console.error("Failed to restore /api/status snapshot", err);
    setSensorUi("offline", false);
  }
}

async function restoreCalibrationSnapshot() {
  try {
    const d = await fetchJson("/api/calibration");
    if (d.success && d.calibration) {
      applyCalibration(d.calibration);
      return;
    }
    resetCalibrationUi();
  } catch (_err) {
    resetCalibrationUi();
  }
}

// ── WebSocket handling ────────────────────────────────────
function handleFrame(d) {
  latestBackendStatus = d.status || latestBackendStatus;

  const hasFrame = !!d.frame;
  setSensorUi(latestBackendStatus, hasFrame);

  if (d.break_active !== undefined) {
    const overlay = byId("break-overlay");
    const confirm = byId("break-confirm-box");
    if (overlay && d.break_active) overlay.style.display = "flex";
    if (confirm && d.break_active) confirm.style.display = "block";
  }

  if (d.csv_count !== undefined) {
    updateCounter(d.csv_count);
  }

  if (d.calibration) {
    applyCalibration(d.calibration);
  }

  if ((d.type === "frame" || d.type === "init") && d.frame) {
    applyFrame(d.frame, d);
    return;
  }

  if (d.posture_label) {
    updatePostureBanner(d.posture_label, imageForPosture(d.posture_label, d.posture_image || ""));
  }
}

function stopHeartbeat() {
  if (wsHeartbeatTimer) {
    clearInterval(wsHeartbeatTimer);
    wsHeartbeatTimer = null;
  }
}

function startHeartbeat() {
  stopHeartbeat();
  wsHeartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send("ping");
      } catch (_err) {}
    }
  }, 15000);
}

function scheduleReconnect() {
  if (wsReconnectTimer) return;

  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    wsPathIndex = (wsPathIndex + 1) % WS_PATHS.length;
    connectWebSocket();
  }, 2000);
}

function connectWebSocket() {
  stopHeartbeat();

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const path = WS_PATHS[wsPathIndex];
  const url = `${protocol}//${location.host}${path}`;

  try {
    ws = new WebSocket(url);
  } catch (err) {
    console.error("WebSocket creation failed", err);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    setSensorUi(latestBackendStatus || "waiting", !!latestFrame);
    startHeartbeat();
  };

  ws.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      handleFrame(data);
    } catch (err) {
      console.error("Bad websocket payload", err, e.data);
    }
  };

  ws.onerror = (e) => {
    console.error("WebSocket error", e);
  };

  ws.onclose = () => {
    stopHeartbeat();
    setSensorUi("offline", false);
    scheduleReconnect();
  };
}

// ── Initialization ────────────────────────────────────────
async function initializeWorkSession() {
  updateTimerDisplay();
  updateLabelCounts();
  ensureInitialGrids();
  resetGradientPanel();
  resetLiveGridUi();
  resetCalibrationUi();
  setSensorUi("waiting", false);

  await Promise.allSettled([
    restoreBreakState(),
    restoreStatusSnapshot(),
    restoreCalibrationSnapshot()
  ]);

  connectWebSocket();
}

document.addEventListener("DOMContentLoaded", initializeWorkSession);