document.addEventListener('DOMContentLoaded', () => {
    updateDashboardMetadata();
    setupTabListeners();
});

/**
 * Handles Date and Time-based Greeting
 */
function updateDashboardMetadata() {
    const dateEl = document.getElementById('current-date');
    const greetingEl = document.getElementById('time-greeting');
    
    if (!dateEl) return;

    const now = new Date();

    // 1. Format the Date (e.g., "May 13")
    const dateOptions = { month: 'long', day: 'numeric' };
    const dateString = now.toLocaleDateString('en-US', dateOptions);
    
    // 2. Update text while preserving the SVG calendar icon
    const icon = dateEl.querySelector('svg');
    dateEl.innerHTML = ''; 
    if (icon) dateEl.appendChild(icon);
    dateEl.append(` ${dateString}`);

    // 3. Dynamic Greeting
    if (greetingEl) {
        const hours = now.getHours();
        if (hours < 12) greetingEl.textContent = "Good morning!";
        else if (hours < 18) greetingEl.textContent = "Good afternoon!";
        else greetingEl.textContent = "Good evening!";
    }
}

/**
 * Creates and updates the Charts
 */
function initCharts() {
    // Access the data sent from the backend via Jinja2
    const stats = window.DASHBOARD_DATA || { 
        donut: [0, 0, 0], 
        line: [], 
        labels: [] 
    };

    // --- DONUT CHART (Today's Score) ---
    const donutCtx = document.getElementById('donutChart')?.getContext('2d');
    if (donutCtx) {
        // Destroy existing instance to prevent flickering
        const existingDonut = Chart.getChart("donutChart");
        if (existingDonut) existingDonut.destroy();

        new Chart(donutCtx, {
            type: 'doughnut',
            data: {
                datasets: [{
                    // Order: [Good, Leaning, Severe]
                    data: stats.donut, 
                    backgroundColor: ['#22c55e', '#eab308', '#ef4444'],
                    borderWidth: 0,
                    hoverOffset: 4
                }]
            },
            options: {
                cutout: '75%',
                plugins: { 
                    legend: { display: false }, 
                    tooltip: { enabled: true } 
                },
                animation: { animateRotate: true, duration: 1000 }
            }
        });
    }

    // --- LINE CHART (Posture Quality Over Time) ---
    const lineCtx = document.getElementById('lineChart')?.getContext('2d');
    if (lineCtx) {
        const existingLine = Chart.getChart("lineChart");
        if (existingLine) existingLine.destroy();

        new Chart(lineCtx, {
            type: 'line',
            data: {
                labels: stats.labels,
                datasets: [{
                    label: 'Posture Score',
                    data: stats.line,
                    borderColor: '#3B6EF8',
                    borderWidth: 3,
                    pointRadius: 2,
                    tension: 0.4, // Smooth curves
                    fill: true,
                    // Create the blue gradient fill
                    backgroundColor: (ctx) => {
                        const canvas = ctx.chart.ctx;
                        const gradient = canvas.createLinearGradient(0, 0, 0, 300);
                        gradient.addColorStop(0, 'rgba(59,110,248,0.2)');
                        gradient.addColorStop(1, 'rgba(59,110,248,0)');
                        return gradient;
                    }
                }]
            },
            options: { 
                responsive: true, 
                maintainAspectRatio: false,
                plugins: { 
                    legend: { display: false },
                    tooltip: {
                        mode: 'index',
                        intersect: false,
                        backgroundColor: '#fff',
                        titleColor: '#1a2035',
                        bodyColor: '#6b7a99',
                        borderColor: '#e4e8f0',
                        borderWidth: 1,
                        callbacks: {
                            label: ctx => ` Score: ${ctx.parsed.y}%`
                        }
                    }
                },
                scales: {
                    x: { 
                        grid: { display: false },
                        ticks: { color: '#9aa3b8', font: { size: 11, family: 'DM Sans' } }
                    },
                    y: { 
                        min: 0, 
                        max: 100, 
                        ticks: { 
                            stepSize: 25, 
                            color: '#9aa3b8', 
                            font: { size: 11, family: 'DM Sans' } 
                        },
                        grid: { color: '#f0f2f7' }
                    }
                }
            }
        });
    }
}

/**
 * Handles Tab Switching for charts (Today vs Week)
 */
function setupTabListeners() {
    document.querySelectorAll('.chart-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.chart-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            // Logic for switching data ranges can be added here
        });
    });
}

// ════════════════════════════════
// ESP32 CONNECTION TRACKER
// ════════════════════════════════

const sensorDot = document.getElementById('sensor-dot');
const sensorStatusText = document.getElementById('sensor-status');
let espTimeout;

function updateSensorStatus(state) {
  if (!sensorDot || !sensorStatusText) return;
  // Clear previous states
  sensorDot.classList.remove('offline', 'connecting');
  sensorStatusText.classList.remove('offline', 'connecting');

  if (state === 'online') {
    sensorStatusText.textContent = 'Connected';
    // Uses default green CSS
  } else if (state === 'offline') {
    sensorDot.classList.add('offline');
    sensorStatusText.classList.add('offline');
    sensorStatusText.textContent = 'Disconnected';
  } else if (state === 'connecting') {
    sensorDot.classList.add('connecting');
    sensorStatusText.classList.add('connecting');
    sensorStatusText.textContent = 'Connecting...';
  }
}

function initWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  let host = window.location.host;
  // Fallback for local file opening, assumes standard FastAPI port
  if (!host) host = 'localhost:8000'; 
  
  const wsUrl = `${protocol}//${host}/ws`;
  const ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    // We connected to the Python server, now waiting for ESP32 data
    updateSensorStatus('connecting'); 
  };

  ws.onmessage = (event) => {
    // If we receive a message, the ESP32 is actively publishing!
    updateSensorStatus('online');

    // Reset the timeout. If no data arrives for 2.5 seconds, assume the ESP32 disconnected.
    clearTimeout(espTimeout);
    espTimeout = setTimeout(() => {
      updateSensorStatus('offline');
    }, 2500);
  };

  ws.onclose = () => {
    // The Python server itself went offline
    updateSensorStatus('offline');
    // Try to automatically reconnect every 3 seconds
    setTimeout(initWebSocket, 3000);
  };

  ws.onerror = () => {
    ws.close();
  };
}

// Start the listener only on pages with sensor UI
if (sensorDot && sensorStatusText) {
  initWebSocket();
}

// ════════════════════════════════
// LIVE STATS REFRESH
// ════════════════════════════════

let donutChartInstance = null;
let lineChartInstance  = null;

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function pctColor(pct) {
  if (pct > 70) return '#22c55e';
  if (pct > 40) return '#eab308';
  return '#ef4444';
}

async function refreshDashboardStats() {
  try {
    const res = await fetch('/api/dashboard-stats');
    if (!res.ok) return;
    const s = await res.json();

    // Stat cards
    setText('stat-good-pct',    `${s.good_pct}%`);
    setText('stat-good-time',   s.good_time);
    setText('stat-leaning-pct', `${s.leaning_pct}%`);
    setText('stat-leaning-time',s.leaning_time);
    setText('stat-severe-pct',  `${s.severe_pct}%`);
    setText('stat-severe-time', s.severe_time);

    // Donut center label
    const donutPct = document.getElementById('donut-pct-label');
    if (donutPct) {
      donutPct.textContent = `${s.good_pct}%`;
      donutPct.style.color = pctColor(s.good_pct);
    }

    // Legend percentages
    setText('legend-good-pct',    `${s.good_pct}%`);
    setText('legend-leaning-pct', `${s.leaning_pct}%`);
    setText('legend-severe-pct',  `${s.severe_pct}%`);

    // Alerts list
    const alertsEl = document.getElementById('alerts-list');
    if (alertsEl) {
      alertsEl.innerHTML = s.alerts.length
        ? s.alerts.map(a => `
            <div class="alert-item ${a.type}-bg">
              <span class="alert-msg">${a.msg}</span>
              <span class="alert-time">${a.time}</span>
            </div>`).join('')
        : '<div class="alert-item" style="color:#9ca3af;font-size:13px;">No alerts today</div>';
    }

    // Donut chart
    const donutCtx = document.getElementById('donutChart')?.getContext('2d');
    if (donutCtx) {
      if (donutChartInstance) {
        donutChartInstance.data.datasets[0].data = [s.good_pct, s.leaning_pct, s.severe_pct];
        donutChartInstance.update();
      } else {
        donutChartInstance = new Chart(donutCtx, {
          type: 'doughnut',
          data: {
            datasets: [{
              data: [s.good_pct, s.leaning_pct, s.severe_pct],
              backgroundColor: ['#22c55e', '#eab308', '#ef4444'],
              borderWidth: 0,
              hoverOffset: 4
            }]
          },
          options: {
            cutout: '75%',
            plugins: { legend: { display: false }, tooltip: { enabled: true } },
            animation: { animateRotate: true, duration: 600 }
          }
        });
      }
    }

    // Line chart
    const lineCtx = document.getElementById('lineChart')?.getContext('2d');
    if (lineCtx) {
      if (lineChartInstance) {
        lineChartInstance.data.labels = s.chart_labels;
        lineChartInstance.data.datasets[0].data = s.chart_data;
        lineChartInstance.update();
      } else {
        lineChartInstance = new Chart(lineCtx, {
          type: 'line',
          data: {
            labels: s.chart_labels,
            datasets: [{
              label: 'Posture Score',
              data: s.chart_data,
              borderColor: '#3B6EF8',
              borderWidth: 3,
              pointRadius: 2,
              tension: 0.4,
              fill: true,
              backgroundColor: (ctx) => {
                const gradient = ctx.chart.ctx.createLinearGradient(0, 0, 0, 300);
                gradient.addColorStop(0, 'rgba(59,110,248,0.2)');
                gradient.addColorStop(1, 'rgba(59,110,248,0)');
                return gradient;
              }
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { display: false },
              tooltip: {
                mode: 'index', intersect: false,
                backgroundColor: '#fff', titleColor: '#1a2035',
                bodyColor: '#6b7a99', borderColor: '#e4e8f0', borderWidth: 1,
                callbacks: { label: ctx => ` Score: ${ctx.parsed.y}%` }
              }
            },
            scales: {
              x: { grid: { display: false }, ticks: { color: '#9aa3b8', font: { size: 11, family: 'DM Sans' } } },
              y: { min: 0, max: 100, ticks: { stepSize: 25, color: '#9aa3b8', font: { size: 11, family: 'DM Sans' } }, grid: { color: '#f0f2f7' } }
            }
          }
        });
      }
    }
  } catch (e) {
    console.warn('[Dashboard] Stats refresh failed:', e);
  }
}

// Initial load + poll every 15 seconds
refreshDashboardStats();
setInterval(refreshDashboardStats, 15000);
