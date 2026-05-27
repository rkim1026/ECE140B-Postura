const LABELS = {
  GOOD:          { label: "Good Posture ✓",   cls: "good"     },
  MILD_SLOUCH:   { label: "Mild Slouch",       cls: "mild"     },
  SEVERE_SLOUCH: { label: "Severe Slouch !!",  cls: "severe"   },
  LEANING_BACK:  { label: "Leaning Back",      cls: "leanback" },
};

const COLLECT_LABELS = ["GOOD", "MILD_SLOUCH", "SEVERE_SLOUCH", "LEANING_BACK"];
const PILL_CLS = {
  GOOD: "lc-good", MILD_SLOUCH: "lc-mild",
  SEVERE_SLOUCH: "lc-severe", LEANING_BACK: "lc-leanback"
};

const POSTURE_DISPLAY_NAMES = {
  GOOD:          "Good Posture",
  MILD_SLOUCH:   "Mild Slouch",
  SEVERE_SLOUCH: "Severe Slouch",
  LEANING_BACK:  "Leaning Back",
};

const VERT_MILD   = 20;
const VERT_SEVERE = 35;
const MAX_GRAD    = 150;

let labelCounts   = {};
let calVertStatic = null;
let calMeanStatic = null;
let calLbThresh   = null;
let breakConfirmTimer = null;

// ── Color helpers ─────────────────────────────────────────

function devColor(dev, valid) {
  if (!valid) return "#1e293b";
  if (dev >  60) return "#1e3a8a";
  if (dev >  25) return "#1d4ed8";
  if (dev >  10) return "#0369a1";
  if (dev > -10) return "#065f46";
  if (dev > -30) return "#b45309";
  if (dev > -60) return "#b91c1c";
  return "#7f1d1d";
}

function distColor(dist, valid) {
  if (!valid || dist === 0) return "#1e293b";
  const t = Math.max(0, Math.min(1, (dist - 50) / 550));
  const r = Math.round(10  + (30  - 10)  * t);
  const g = Math.round(200 + (50  - 200) * t);
  const b = Math.round(80  + (150 - 80)  * t);
  return `rgb(${r},${g},${b})`;
}

// ── Grid builder ──────────────────────────────────────────

function buildGrid(id, values, colorFn, validArr) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = "";
  for (let i = 0; i < 64; i++) {
    const z = document.createElement("div");
    z.className = "zone";
    const valid = validArr ? !!validArr[i] : values[i] > 0;
    z.style.background = colorFn(values[i], valid);
    z.textContent = valid ? values[i] : "×";
    el.appendChild(z);
  }
}

// ── Gradient helpers ──────────────────────────────────────

function fmt(v) { return (v >= 0 ? "+" : "") + v + " mm"; }

function deltaClass(delta, mild, severe) {
  const abs = Math.abs(delta);
  if (abs < mild)   return "delta-ok";
  if (abs < severe) return "delta-mild";
  return "delta-severe";
}

function deltaColor(delta, mild, severe) {
  const abs = Math.abs(delta);
  if (abs < mild)   return "#22c55e";
  if (abs < severe) return "#f59e0b";
  return "#ef4444";
}

function setBar(fillId, value, maxVal) {
  const bar = document.getElementById(fillId);
  if (!bar) return;
  const pct = Math.min(Math.abs(value) / maxVal, 0.5);
  if (value >= 0) {
    bar.style.left  = "50%";
    bar.style.width = (pct * 100) + "%";
  } else {
    bar.style.left  = (50 - pct * 100) + "%";
    bar.style.width = (pct * 100) + "%";
  }
}

// ── Gradient panel ────────────────────────────────────────

function renderGradientPanel(calVert, liveVert, liveMean) {
  const dVert   = liveVert - calVert;
  const calMean = calMeanStatic ?? 0;
  const dMean   = liveMean - calMean;

  const calVertEl  = document.getElementById("gp-cal-vert");
  const liveVertEl = document.getElementById("gp-live-vert");
  const dVertEl    = document.getElementById("gp-d-vert");
  if (calVertEl)  calVertEl.textContent  = fmt(calVert);
  if (liveVertEl) liveVertEl.textContent = fmt(liveVert);
  if (dVertEl) {
    dVertEl.textContent = fmt(dVert);
    dVertEl.className   = "gp-val gp-delta " + deltaClass(dVert, VERT_MILD, VERT_SEVERE);
  }

  const calMarker = document.getElementById("gp-marker-cal-vert");
  if (calMarker) {
    const calPct = 50 + Math.max(-50, Math.min(50, (calVert / MAX_GRAD) * 50));
    calMarker.style.left = calPct + "%";
  }

  const barVert = document.getElementById("gp-bar-vert");
  if (barVert) {
    setBar("gp-bar-vert", liveVert, MAX_GRAD);
    barVert.style.background = deltaColor(dVert, VERT_MILD, VERT_SEVERE);
  }

  const calMeanEl  = document.getElementById("gp-cal-mean");
  const liveMeanEl = document.getElementById("gp-live-mean");
  const dMeanEl    = document.getElementById("gp-d-mean");
  if (calMeanEl)  calMeanEl.textContent  = "0 mm";
  if (liveMeanEl) liveMeanEl.textContent = fmt(liveMean);
  if (dMeanEl) {
    dMeanEl.textContent = fmt(dMean);
    const lbT = calLbThresh ?? -150;
    const cls = dMean <= lbT ? "delta-leanback"
              : dMean < -30  ? "delta-mild"
              : "delta-ok";
    dMeanEl.className = "gp-val gp-delta " + cls;
  }

  const barMean = document.getElementById("gp-bar-mean");
  if (barMean) {
    setBar("gp-bar-mean", liveMean, MAX_GRAD);
    const lbT = calLbThresh ?? -150;
    barMean.style.background = liveMean <= lbT ? "#818cf8" : "#7a8eaa";
  }
}

// ── Calibration summary ───────────────────────────────────

function renderCalSummary(cal) {
  const summary = document.getElementById("cal-gradient-summary");
  if (!summary) return;
  summary.style.display = "block";

  const cv = cal.cal_vert        ?? 0;
  const md = cal.cal_mean_dist   ?? 0;
  const lb = cal.leanback_thresh ?? 0;

  const vertEl   = document.getElementById("cgs-vert");
  const meanEl   = document.getElementById("cgs-mean-dist");
  const threshEl = document.getElementById("cgs-leanback-thresh");
  if (vertEl)   vertEl.textContent   = fmt(cv);
  if (meanEl)   meanEl.textContent   = md + " mm";
  if (threshEl) threshEl.textContent = lb + " mm (meanDev trigger)";

  const barVert = document.getElementById("cgs-bar-vert");
  if (barVert) setBar("cgs-bar-vert", cv, MAX_GRAD);
}

// ── Posture banner ────────────────────────────────────────

function updatePostureBanner(postureLabel, postureImage) {
  const banner  = document.getElementById("posture-banner");
  const img     = document.getElementById("posture-banner-img");
  const labelEl = document.getElementById("posture-banner-label");
  if (!banner || !img || !labelEl) return;

  if (!postureLabel || !postureImage) {
    banner.style.display = "none";
    return;
  }

  if (img.src !== location.origin + postureImage) {
    img.src = postureImage;
  }

  labelEl.textContent = POSTURE_DISPLAY_NAMES[postureLabel] || postureLabel;
  labelEl.className   = "posture-banner-label posture-label-" + postureLabel.toLowerCase();
  banner.style.display = "flex";
}


// ── Break Time ────────────────────────────────────────────
// CHANGED: Entire Break Time block updated to support NO skipping and Health Tips

async function startBreak() {
  // CHANGED: Calls with ?demo=true to instantly show the YES/NO buttons
  await fetch("/api/break/start?demo=true", { method: "POST" });
  document.getElementById("break-overlay").style.display = "flex";
  document.getElementById("break-confirm-box").style.display = "block"; // Instantly show for demo/compliance mode
}

// CHANGED: Removed the 'walked' parameter. This is now specifically for the "YES" button.
async function endBreak() {
  clearTimeout(breakConfirmTimer);
  await fetch("/api/break/end", { method: "POST" });
  document.getElementById("break-overlay").style.display = "none";
  document.getElementById("break-confirm-box").style.display = "none";
}

// NEW: Specifically handles the "NO" button, closing the break lock-out and fetching the health tip
async function skipBreak() {
  clearTimeout(breakConfirmTimer);
  
  // Call /api/break/skip — logs non-compliance on python side and returns a health tip
  const res  = await fetch("/api/break/skip", { method: "POST" });
  const data = await res.json();
  
  // Instantly close the forced break popup so they can continue working
  document.getElementById("break-overlay").style.display = "none";
  document.getElementById("break-confirm-box").style.display = "none";

  // Show the informational health tip popup if data was returned
  if (data.tip) {
    document.getElementById("tip-source").textContent  = "Source: " + data.tip.source;
    document.getElementById("tip-summary").textContent = data.tip.summary;
    document.getElementById("tip-link").href           = data.tip.url;
    document.getElementById("tip-overlay").style.display = "flex";
  }
}

// NEW: Closes the health tip popup that appears after skipping a break
function closeTip() {
  document.getElementById("tip-overlay").style.display = "none";
}

// Restore break state on page load
fetch("/api/break/status")
  .then(r => r.json())
  .then(d => {
    if (d.break_active) {
      document.getElementById("break-overlay").style.display = "flex";
      document.getElementById("break-confirm-box").style.display = "block";
    }
  });


// ── Misc UI helpers ───────────────────────────────────────

function updateCounter(total) {
  const el = document.getElementById("csv-count");
  if (el) el.textContent = total;
}

function updateLabelCounts() {
  const el = document.getElementById("label-counts");
  if (!el) return;
  el.innerHTML = COLLECT_LABELS.map(lbl => {
    const count  = labelCounts[lbl] || 0;
    const pretty = lbl.replace(/_/g, " ");
    const cls    = PILL_CLS[lbl] || "";
    return `<div class="lc-pill ${cls} ${count > 0 ? 'has-data' : ''}">${pretty} <b>${count}</b></div>`;
  }).join("");
}

function startCalibration() {
  const btn = document.getElementById("cal-btn");
  btn.disabled    = true;
  btn.textContent = "Calibrating...";
  fetch("/api/calibrate", { method: "POST" })
    .catch(() => { btn.disabled = false; btn.textContent = "Recalibrate"; });
}

function collect(label) {
  const statusEl = document.getElementById("collect-status");
  statusEl.className   = "collect-status";
  statusEl.textContent = `Saving ${label.replace(/_/g, " ")}...`;

  fetch("/api/save-posture", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label })
  })
    .then(r => r.json())
    .then(d => {
      if (d.success) {
        statusEl.className   = "collect-status ok";
        statusEl.textContent = `✓ Saved as ${label.replace(/_/g," ")} — total: ${d.csv_count} rows`;
        updateCounter(d.csv_count);
        labelCounts[label] = (labelCounts[label] || 0) + 1;
        updateLabelCounts();
      } else {
        statusEl.className   = "collect-status err";
        statusEl.textContent = `✗ ${d.error}`;
      }
      setTimeout(() => { statusEl.textContent = ""; statusEl.className = "collect-status"; }, 4000);
    })
    .catch(err => {
      statusEl.className   = "collect-status err";
      statusEl.textContent = `✗ Network error: ${err}`;
    });
}

// ── Status indicator ──────────────────────────────────────

function applyStatus(status) {
  const dot  = document.getElementById("dot");
  const stxt = document.getElementById("status-text");
  const btn  = document.getElementById("cal-btn");

  if (status === "live") {
    dot.className    = "dot dot-live";
    stxt.textContent = "Live — receiving data";
    if (btn.textContent === "Calibrating...") {
      btn.disabled    = false;
      btn.textContent = "Recalibrate";
    }
  } else if (status === "calibrating") {
    dot.className    = "dot dot-cal";
    stxt.textContent = "Calibrating...";
    btn.disabled     = true;
    btn.textContent  = "Calibrating...";
  } else {
    dot.className    = "dot dot-wait";
    stxt.textContent = "Waiting for sensor...";
  }
}

// ── Calibration apply ─────────────────────────────────────

function applyCalibration(cal) {
  if (!cal) return;
  buildGrid("cal-grid", cal.baseline, distColor, cal.valid);

  calVertStatic = cal.cal_vert        ?? 0;
  calMeanStatic = cal.cal_mean_dist   ?? 0;
  calLbThresh   = cal.leanback_thresh ?? null;

  const vals       = cal.baseline.filter((v, i) => cal.valid[i] && v > 0);
  const validCount = cal.valid.reduce((a, v) => a + v, 0);

  document.getElementById("cal-stats").innerHTML = `
    <div class="stat"><span>Frames</span><b>${cal.frames}</b></div>
    <div class="stat"><span>Valid Zones</span><b>${validCount}/64</b></div>
    <div class="stat"><span>Min</span><b>${Math.min(...vals)} mm</b></div>
    <div class="stat"><span>Max</span><b>${Math.max(...vals)} mm</b></div>
    <div class="stat"><span>Mean</span><b>${Math.round(vals.reduce((a,b)=>a+b,0)/vals.length)} mm</b></div>
  `;

  renderCalSummary(cal);
}

// ── Frame handler (exported for HTML inline hooks) ────────

function handleFrame(d) {
  applyStatus(d.status);
  if (typeof d.csv_count === "number") updateCounter(d.csv_count);
  if (d.calibration) applyCalibration(d.calibration);

  if ((d.type === "frame" || d.type === "init") && d.frame) {
    const f         = d.frame;
    const validLive = f.grid.map(v => v > 0);

    buildGrid("live-grid", f.dev, devColor, validLive);

    const p     = LABELS[f.posture] || { label: f.posture, cls: "neutral" };
    const badge = document.getElementById("posture-badge");
    badge.textContent = p.label;
    badge.className   = "badge " + p.cls;

    renderGradientPanel(calVertStatic ?? 0, f.vert ?? 0, f.mean ?? 0);

    const vertEl = document.getElementById("vert");
    const meanEl = document.getElementById("mean");
    if (vertEl) vertEl.textContent = fmt(f.vert ?? 0);
    if (meanEl) meanEl.textContent = fmt(f.mean ?? 0);
  }

  // Update posture banner using server-resolved image path
  updatePostureBanner(d.posture_label, d.posture_image);
}

window.handleFrame = handleFrame;

// ── WebSocket ─────────────────────────────────────────────

let ws;

function connectWS() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen    = () => console.log("[WS] Connected");
  ws.onmessage = (e) => handleFrame(JSON.parse(e.data));
  ws.onclose   = () => { console.log("[WS] Lost — retrying in 2s"); setTimeout(connectWS, 2000); };
  ws.onerror   = err => console.error("[WS] Error", err);
}

updateLabelCounts();
connectWS();