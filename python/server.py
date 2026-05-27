from contextlib import asynccontextmanager
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, Query
from fastapi.templating import Jinja2Templates
from fastapi.staticfiles import StaticFiles
import uvicorn
import asyncio
import json
import os
import csv
import copy
import uuid
import random
from datetime import datetime
import paho.mqtt.client as mqtt
from dotenv import load_dotenv

load_dotenv()

CLIENT_ID    = os.getenv("CLIENT_ID",    "chuach1234")
TOPIC_PREFIX = os.getenv("TOPIC_PREFIX", "chuach1234")
MQTT_BROKER  = os.getenv("MQTT_BROKER",  "broker.emqx.io")

TOPIC_DATA   = f"{TOPIC_PREFIX}/data"
TOPIC_CAL    = f"{TOPIC_PREFIX}/calibration"
TOPIC_STATUS = f"{TOPIC_PREFIX}/status"
TOPIC_CMD    = f"{TOPIC_PREFIX}/cmd"

CSV_FILE = "posture_data.csv"

CSV_HEADERS = (
    ["timestamp", "label",
     "vert", "d_vert", "cal_vert",
     "mean", "leanback_thresh"]
    + [f"dev{i}"    for i in range(64)]
    + [f"raw{i}"    for i in range(64)]
    + [f"cal{i}"    for i in range(64)]
    + [f"stddev{i}" for i in range(64)]
    + [f"valid{i}"  for i in range(64)]
)

VALID_LABELS = ["GOOD", "MILD_SLOUCH", "SEVERE_SLOUCH", "LEANING_BACK"]

POSTURE_IMAGE_MAP = {
    "GOOD":          "Good.png",
    "MILD_SLOUCH":   "Slouch.png",
    "SEVERE_SLOUCH": "Slouch.png",
    "LEANING_BACK":  "Back.png",
}
BREAK_IMAGE = "Break.png"

# ── Break compliance tracking ─────────────────────────────
# Each entry: {"timestamp": ISO, "complied": bool}
break_compliance_log: list[dict] = []


# ── Health tip sources for "No" popup ────────────────────
BREAK_HEALTH_TIPS = [
    {
        "source": "Columbia University Irving Medical Center",
        "url": "https://www.cuimc.columbia.edu/news/rx-prolonged-sitting-five-minute-stroll-every-half-hour",
        "summary": (
            "Columbia University researchers tested five different walking schedules on office workers "
            "who sat for eight straight hours. Their key finding: just five minutes of light walking "
            "every 30 minutes was the only routine that significantly lowered both blood sugar and "
            "blood pressure. That brief stroll reduced after-meal blood sugar spikes by 58% compared "
            "to sitting all day — a result comparable to what you'd expect from six months of daily "
            "exercise. Even one-minute breaks every 30 minutes provided modest blood sugar benefits. "
            "Lead researcher Dr. Keith Diaz put it plainly: small amounts of walking spread through "
            "the workday can significantly lower your risk of heart disease and other chronic illnesses, "
            "even if you already exercise regularly outside of work."
        ),
    },
    {
        "source": "Harvard Health Publishing",
        "url": "https://www.health.harvard.edu/healthy-aging-and-longevity/walking-breaks-counter-the-effects-of-sitting",
        "summary": (
            "Harvard Health reviewed a controlled study where adults aged 40–70 sat for eight hours "
            "while researchers tracked blood sugar and blood pressure every 15–60 minutes. The verdict: "
            "five minutes of walking after every 30 minutes of sitting was the only pattern that "
            "meaningfully lowered both metrics. All walking patterns — even short one-minute breaks — "
            "reduced systolic blood pressure by 4–5 points compared to uninterrupted sitting. That "
            "drop translates to a 13–15% decrease in cardiovascular disease risk, according to the "
            "researchers. Harvard Health notes that mounting evidence now places prolonged sitting in "
            "the same health-risk category as smoking — making a five-minute walk every half hour one "
            "of the simplest, most evidence-backed habits you can build into your workday."
        ),
    },
    {
        "source": "National Institutes of Health — Progress in Cardiovascular Diseases",
        "url": "https://pmc.ncbi.nlm.nih.gov/articles/PMC8628304/",
        "summary": (
            "A peer-reviewed NIH study from the University of Illinois at Chicago examined the "
            "full-body physiological cost of prolonged sitting. Every extra hour of daily sedentary "
            "time reduced cardiorespiratory fitness by up to 0.24 METs — a measurable hit to your "
            "heart's capacity. Prolonged sitting also damages vascular function: just 1.5–6 hours "
            "of uninterrupted sitting decreases arterial blood flow by ~2%, and each 1% drop raises "
            "cardiovascular event risk by 13%. The good news: two-minute walking breaks every "
            "30 minutes were shown to fully prevent these declines in blood flow and cerebral "
            "circulation. The researchers conclude that breaking up sedentary time frequently — "
            "ideally every 30 minutes — is one of the most practical interventions available, "
            "especially for the majority of Americans who don't meet standard exercise guidelines."
        ),
    },
]


# ── Runtime state ─────────────────────────────────────────
clients: list[WebSocket] = []
latest_frame    = None
last_good_frame = None
calibration     = None
system_status   = "waiting"
break_active    = False
break_demo_mode = False


# ── CSV helpers ───────────────────────────────────────────

def init_csv():
    if not os.path.exists(CSV_FILE):
        with open(CSV_FILE, "w", newline="") as f:
            csv.writer(f).writerow(CSV_HEADERS)
        print(f"[CSV] Created {CSV_FILE}")
    else:
        print(f"[CSV] Found existing {CSV_FILE} ({count_csv_rows()} rows)")


def count_csv_rows() -> int:
    if not os.path.exists(CSV_FILE):
        return 0
    with open(CSV_FILE, "r") as f:
        return max(0, sum(1 for _ in f) - 1)


def save_to_csv(label: str, frame: dict, cal: dict) -> int:
    init_csv()
    row = (
        [datetime.now().isoformat(), label,
         frame.get("vert",    0),
         frame.get("d_vert",  0),
         frame.get("cal_vert",0),
         frame.get("mean",    0),
         cal.get("leanback_thresh", 0)]
        + frame.get("dev",  [0] * 64)
        + frame.get("grid", [0] * 64)
        + cal.get("baseline", [0] * 64)
        + cal.get("stddev",   [0] * 64)
        + cal.get("valid",    [0] * 64)
    )
    with open(CSV_FILE, "a", newline="") as f:
        csv.writer(f).writerow(row)
    total = count_csv_rows()
    print(f"[CSV] Saved row #{total} — label: {label}")
    return total


# ── MQTT callbacks ────────────────────────────────────────

def on_connect(client, userdata, flags, reason_code, properties):
    print(f"[MQTT] Connected to {MQTT_BROKER} (rc={reason_code})")
    client.subscribe(TOPIC_DATA)
    client.subscribe(TOPIC_CAL)
    client.subscribe(TOPIC_STATUS)


def on_message(client, userdata, msg):
    global latest_frame, last_good_frame, calibration, system_status
    try:
        topic = msg.topic
        if topic == TOPIC_DATA:
            parsed          = json.loads(msg.payload.decode())
            latest_frame    = parsed
            last_good_frame = copy.deepcopy(parsed)
        elif topic == TOPIC_CAL:
            calibration = json.loads(msg.payload.decode())
            print(f"[MQTT] Calibration received — {calibration.get('frames','?')} frames "
                  f"| NatVert={calibration.get('cal_vert','?')}")
        elif topic == TOPIC_STATUS:
            system_status = msg.payload.decode()
            print(f"[MQTT] Status: {system_status}")
    except Exception as e:
        print(f"[MQTT] Parse error on {msg.topic}: {e}")


def on_disconnect(client, userdata, flags, reason_code, properties):
    print(f"[MQTT] Disconnected (rc={reason_code})")


mqtt_client = mqtt.Client(
    mqtt.CallbackAPIVersion.VERSION2,
    client_id=f"{CLIENT_ID}-server-{uuid.uuid4().hex[:6]}"
)
mqtt_client.on_connect    = on_connect
mqtt_client.on_message    = on_message
mqtt_client.on_disconnect = on_disconnect


# ── WebSocket broadcast ───────────────────────────────────

def _build_frame_msg(msg_type: str) -> str:
    posture_label = (latest_frame or last_good_frame or {}).get("posture", "")
    posture_image = POSTURE_IMAGE_MAP.get(posture_label, "")
    return json.dumps({
        "type":          msg_type,
        "status":        system_status,
        "frame":         latest_frame if msg_type == "frame" else last_good_frame,
        "calibration":   calibration,
        "csv_count":     count_csv_rows(),
        "posture_label": posture_label,
        "posture_image": f"/images/{posture_image}" if posture_image else "",
        "break_active":  break_active,
        "break_demo":    break_demo_mode,
        "break_image":   f"/images/{BREAK_IMAGE}",
    })


async def broadcast_frames():
    global latest_frame
    while True:
        if latest_frame and clients:
            msg  = _build_frame_msg("frame")
            dead = []
            for ws in clients:
                try:
                    await ws.send_text(msg)
                except Exception:
                    dead.append(ws)
            for ws in dead:
                if ws in clients:
                    clients.remove(ws)
            latest_frame = None
        await asyncio.sleep(0.1)


# ── App lifespan ──────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    init_csv()
    mqtt_client.connect(MQTT_BROKER, 1883, 60)
    mqtt_client.loop_start()
    asyncio.create_task(broadcast_frames())
    yield
    mqtt_client.loop_stop()
    mqtt_client.disconnect()


# ── FastAPI app ───────────────────────────────────────────

app = FastAPI(lifespan=lifespan)
templates = Jinja2Templates(directory="templates")
app.mount("/static", StaticFiles(directory="static"), name="static")
app.mount("/images", StaticFiles(directory="images"), name="images")


# ── Routes ────────────────────────────────────────────────

@app.get("/")
async def home(request: Request):
    return templates.TemplateResponse(request, "index.html")


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    clients.append(websocket)
    print(f"[WS] Client connected ({len(clients)} total)")
    if calibration or last_good_frame:
        await websocket.send_text(_build_frame_msg("init"))
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        if websocket in clients:
            clients.remove(websocket)
        print(f"[WS] Client disconnected ({len(clients)} remaining)")


@app.post("/api/calibrate")
async def trigger_calibrate():
    mqtt_client.publish(TOPIC_CMD, "CALIBRATE")
    print("[API] Sent CALIBRATE to ESP32")
    return {"success": True, "message": "Calibration command sent"}


@app.post("/api/save-posture")
async def collect_frame(request: Request):
    frame_snap = copy.deepcopy(last_good_frame)
    cal_snap   = copy.deepcopy(calibration)

    if frame_snap is None:
        return {"success": False,
                "error": "No frame received yet — is the ESP32 on and publishing?"}
    if cal_snap is None:
        return {"success": False,
                "error": "No calibration — press Start Calibration first"}

    body  = await request.json()
    label = body.get("label", "").strip()

    if label not in VALID_LABELS:
        return {"success": False, "error": f"Invalid label '{label}'"}

    total = save_to_csv(label, frame_snap, cal_snap)
    return {"success": True, "label": label, "csv_count": total}


@app.get("/api/status")
async def get_status():
    posture_label = (last_good_frame or {}).get("posture", "")
    return {
        "status":             system_status,
        "has_frame":          last_good_frame is not None,
        "has_calibration":    calibration is not None,
        "calibration_frames": calibration.get("frames")   if calibration else None,
        "cal_vert":           calibration.get("cal_vert") if calibration else None,
        "csv_count":          count_csv_rows(),
        "posture_label":      posture_label,
        "posture_image":      f"/images/{POSTURE_IMAGE_MAP[posture_label]}" if posture_label in POSTURE_IMAGE_MAP else "",
        "break_active":       break_active,
        "break_demo":         break_demo_mode,
        "break_image":        f"/images/{BREAK_IMAGE}",
    }


@app.get("/api/calibration")
async def get_calibration():
    if calibration:
        return {"success": True, "calibration": calibration}
    return {"success": False, "error": "No calibration data yet"}


# ── Break Time endpoints ──────────────────────────────────

@app.post("/api/break/start")
async def break_start(demo: bool = Query(default=False)):
    global break_active, break_demo_mode
    break_active    = True
    break_demo_mode = demo
    mode = "DEMO (instant confirm)" if demo else "normal (5 min timer)"
    print(f"[API] Break Time started — mode: {mode}")
    return {
        "success":      True,
        "break_active": True,
        "break_demo":   demo,
        "break_image":  f"/images/{BREAK_IMAGE}",
    }


@app.post("/api/break/end")
async def break_end():
    global break_active, break_demo_mode
    break_active    = False
    break_demo_mode = False
    print("[API] Break Time ended — user confirmed (YES)")
    break_compliance_log.append({
        "timestamp": datetime.now().isoformat(),
        "complied":  True,
    })
    return {"success": True, "break_active": False, "complied": True}


@app.post("/api/break/skip")
async def break_skip():
    """
    Called when the user presses NO on the break confirmation.
    Closes the break popup immediately — no forced lock-out.
    Returns a randomly chosen health tip to display in a follow-up popup.
    """
    global break_active, break_demo_mode
    break_active    = False
    break_demo_mode = False
    print("[API] Break skipped — user declined (NO) — logging non-compliance")
    break_compliance_log.append({
        "timestamp": datetime.now().isoformat(),
        "complied":  False,
    })
    tip = random.choice(BREAK_HEALTH_TIPS)
    return {
        "success":      True,
        "break_active": False,
        "complied":     False,
        "tip": {
            "source":  tip["source"],
            "url":     tip["url"],
            "summary": tip["summary"],
            "image":   f"/images/{BREAK_IMAGE}",
        },
    }


@app.get("/api/break/status")
async def break_status():
    return {
        "break_active": break_active,
        "break_demo":   break_demo_mode,
        "break_image":  f"/images/{BREAK_IMAGE}",
    }


@app.get("/api/break/compliance")
async def get_compliance():
    """Returns the full break compliance history for stats display."""
    total    = len(break_compliance_log)
    complied = sum(1 for e in break_compliance_log if e["complied"])
    skipped  = total - complied
    rate     = round((complied / total) * 100, 1) if total > 0 else 0.0
    return {
        "total_breaks":     total,
        "complied":         complied,
        "skipped":          skipped,
        "compliance_rate":  rate,
        "log":              break_compliance_log,
    }


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)