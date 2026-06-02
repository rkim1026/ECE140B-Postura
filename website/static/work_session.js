// Posture Constants
const POSTURE_DISPLAY = {
  GOOD: { label: "Good Posture ✓", cls: "good" },
  MILD_SLOUCH: { label: "Mild Slouch", cls: "mild" },
  SEVERE_SLOUCH: { label: "Severe Slouch !!", cls: "severe" },
  LEANING_BACK: { label: "Leaning Back", cls: "neutral" },
};

let calVertStatic = null;
let calMeanStatic = null;
let calLbThresh = null;
let breakConfirmTimer = null;

// Coloring math for the 8x8 matrices
function devColor(dev, valid) {
  if (!valid) return "#cbd5e1";
  if (dev > 60) return "#1e3a8a";
  if (dev > 25) return "#2563eb";
  if (dev > 10) return "#3b82f6";
  if (dev > -10) return "#10b981";
  if (dev > -30) return "#f59e0b";
  if (dev > -60) return "#ef4444";
  return "#991b1b";
}

function distColor(dist, valid) {
  if (!valid || dist === 0) return "#cbd5e1";
  const t = Math.max(0, Math.min(1, (dist - 50) / 550));
  return `rgb(${Math.round(16 + t*30)}, ${Math.round(185 - t*100)}, ${Math.round(129 - t*40)})`;
}

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

// Break Time Overlay Logic
async function startBreak() {
  await fetch("/api/break/start?demo=true", { method: "POST" });
  document.getElementById("break-overlay").style.display = "flex";
  document.getElementById("break-confirm-box").style.display = "block";
}

async function endBreak() {
  await fetch("/api/break/end", { method: "POST" });
  document.getElementById("break-overlay").style.display = "none";
}

async function skipBreak() {
  const res = await fetch("/api/break/skip", { method: "POST" });
  const data = await res.json();
  document.getElementById("break-overlay").style.display = "none";
  if (data.tip) {
    document.getElementById("tip-source").textContent = "Source: " + data.tip.source;
    document.getElementById("tip-summary").textContent = data.tip.summary;
    document.getElementById("tip-link").href = data.tip.url;
    document.getElementById("tip-overlay").style.display = "flex";
  }
}

function closeTip() { 
  document.getElementById("tip-overlay").style.display = "none"; 
}


// Assuming you have an HTML button with id="calibrateBtn"
const calibrateBtn = document.getElementById('calibrateBtn');

calibrateBtn.addEventListener('click', () => {
    // 1. Send the calibration command to the ESP32
    // Replace this with your actual MQTT publish function
    mqttClient.publish("chuach1234/cmd", "CALIBRATE");

    // 2. Lock the button and start the 5-second UI countdown
    calibrateBtn.disabled = true;
    let timeLeft = 5;
    calibrateBtn.innerHTML = `⏳ Calibrating... Keep still (${timeLeft}s)`;

    const countdown = setInterval(() => {
        timeLeft--;
        if (timeLeft > 0) {
            calibrateBtn.innerHTML = `⏳ Calibrating... Keep still (${timeLeft}s)`;
        } else {
            // Timer finished, reset the button
            clearInterval(countdown);
            calibrateBtn.disabled = false;
            calibrateBtn.innerHTML = "🎯 Calibrate Good Posture";
        }
    }, 1000);
});

// WebSocket connection for real-time ESP32 ToF Feed
function handleFrame(d) {
  const statEl = document.getElementById("sensor-status");
  const dotEl = document.getElementById("sensor-dot");
  
  if (d.status === "live") {
    statEl.textContent = "Live — Receiving Data";
    dotEl.className = "sensor-dot live";
    document.getElementById("cal-btn").textContent = "Calibrate Good Posture";
  } else if (d.status === "calibrating") {
    statEl.textContent = "Calibrating Matrix...";
    dotEl.className = "sensor-dot connecting";
  }

  if (d.calibration) {
    calVertStatic = d.calibration.cal_vert;
    calMeanStatic = d.calibration.cal_mean_dist;
    buildGrid("cal-grid", d.calibration.baseline, distColor, d.calibration.valid);
  }

  if ((d.type === "frame" || d.type === "init") && d.frame) {
    const f = d.frame;
    buildGrid("live-grid", f.dev, devColor, f.grid.map(v => v > 0));

    const p = POSTURE_DISPLAY[f.posture] || { label: f.posture, cls: "neutral" };
    const badge = document.getElementById("posture-badge");
    if(badge) {
        badge.textContent = p.label;
        badge.className = "badge " + p.cls;
    }
    
    if(document.getElementById("gp-live-vert")) {
        document.getElementById("gp-live-vert").textContent = f.vert + " mm";
        document.getElementById("gp-live-mean").textContent = f.mean + " mm";
        if(calVertStatic !== null) {
            document.getElementById("gp-d-vert").textContent = (f.vert - calVertStatic) + " mm";
        }
    }
  }
}

// Initialize Websocket
const ws = new WebSocket(`ws://${location.host}/ws`);
ws.onmessage = (e) => handleFrame(JSON.parse(e.data));