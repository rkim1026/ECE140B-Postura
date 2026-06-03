from contextlib import asynccontextmanager
from fastapi import (
    FastAPI,
    WebSocket,
    WebSocketDisconnect,
    Request,
    Depends,
    HTTPException,
    Response,
    Cookie,
    Query,
)
from fastapi.templating import Jinja2Templates
from fastapi.staticfiles import StaticFiles
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
import uvicorn
import asyncio
import json
import os
import csv
import copy
import uuid
import random
import bcrypt
import mysql.connector
import paho.mqtt.client as mqtt
from dotenv import load_dotenv
import pandas as pd
from datetime import datetime

load_dotenv()

# --- Config & Posture Sensor Globals ---
MQTT_BROKER = os.getenv("MQTT_BROKER", "broker.emqx.io")
CLIENT_ID = os.getenv("CLIENT_ID", "chuach1234")
MQTT_TOPIC = os.getenv("MQTT_TOPIC", "chuach1234")

TOPIC_DATA = f"{MQTT_TOPIC}/data"
TOPIC_CAL = f"{MQTT_TOPIC}/calibration"
TOPIC_STATUS = f"{MQTT_TOPIC}/status"
CMD_TOPIC = f"{MQTT_TOPIC}/cmd"

DB_CONFIG = {
    "host": os.getenv("DB_HOST", "127.0.0.1"),
    "user": os.getenv("DB_USER", "root"),
    "password": os.getenv("DB_PASSWORD", "password"),
    "database": os.getenv("DB_NAME", "postura_db"),
}

CSV_FILE = "posture_data.csv"

CSV_HEADERS = (
    ["timestamp", "label", "vert", "d_vert", "cal_vert", "mean", "leanback_thresh"]
    + [f"dev{i}" for i in range(64)]
    + [f"raw{i}" for i in range(64)]
    + [f"cal{i}" for i in range(64)]
    + [f"stddev{i}" for i in range(64)]
    + [f"valid{i}" for i in range(64)]
)

VALID_LABELS = ["GOOD", "MILD_SLOUCH", "SEVERE_SLOUCH", "LEANING_BACK"]

POSTURE_IMAGE_MAP = {
    "GOOD": "Good.png",
    "MILD_SLOUCH": "Slouch.png",
    "SEVERE_SLOUCH": "Slouch.png",
    "LEANING_BACK": "Back.png",
}

BREAK_IMAGE = "Break.png"

# --- Break Tips ---
BREAK_HEALTH_TIPS = [
    {
        "source": "Columbia University Irving Medical Center",
        "url": "https://www.cuimc.columbia.edu/news/rx-prolonged-sitting-five-minute-stroll-every-half-hour",
        "summary": "Columbia University researchers tested five different walking schedules on office workers who sat for eight straight hours. Their key finding: just five minutes of light walking every 30 minutes was the only routine that significantly lowered both blood sugar and blood pressure.",
    },
    {
        "source": "Harvard Health Publishing",
        "url": "https://www.health.harvard.edu/healthy-aging-and-longevity/walking-breaks-counter-the-effects-of-sitting",
        "summary": "Harvard Health reviewed a controlled study where adults aged 40–70 sat for eight hours while researchers tracked blood sugar and blood pressure every 15–60 minutes. The verdict: five minutes of walking after every 30 minutes of sitting was the only pattern that meaningfully lowered both metrics.",
    },
    {
        "source": "National Institutes of Health",
        "url": "https://pmc.ncbi.nlm.nih.gov/articles/PMC8628304/",
        "summary": "A peer-reviewed NIH study from the University of Illinois at Chicago examined the full-body physiological cost of prolonged sitting. Every extra hour of daily sedentary time reduced cardiorespiratory fitness by up to 0.24 METs.",
    },
]

# --- Runtime State ---
latest_frame = None
last_good_frame = None
calibration = None
system_status = "waiting"
break_active = False
break_demo_mode = False
break_compliance_log = []
clients: list[WebSocket] = []
latest_frame_seq = 0


# --- Pydantic Models ---
class UserLogin(BaseModel):
    username: str
    password: str


class UserRegister(BaseModel):
    full_name: str
    username: str
    password: str


class CommandPayload(BaseModel):
    cmd: str


# --- Normalizers / Payload Helpers ---
def normalize_posture_label(value: str) -> str:
    value = (value or "").strip().upper()
    aliases = {
        "GOOD": "GOOD",
        "GOOD_POSTURE": "GOOD",
        "MILD": "MILD_SLOUCH",
        "SLOUCH": "MILD_SLOUCH",
        "MILD_SLOUCH": "MILD_SLOUCH",
        "SEVERE": "SEVERE_SLOUCH",
        "SEVERE_SLOUCH": "SEVERE_SLOUCH",
        "LEANING": "LEANING_BACK",
        "LEAN_BACK": "LEANING_BACK",
        "LEANING_BACK": "LEANING_BACK",
        "BACK": "LEANING_BACK",
    }
    return aliases.get(value, value)


def ensure_list_64(value, fill=0):
    if not isinstance(value, list):
        return [fill] * 64
    out = value[:64]
    while len(out) < 64:
        out.append(fill)
    return out


def normalize_frame(parsed: dict | None) -> dict:
    frame = copy.deepcopy(parsed) if isinstance(parsed, dict) else {}

    frame["posture"] = normalize_posture_label(frame.get("posture", ""))
    frame["vert"] = frame.get("vert", 0)
    frame["d_vert"] = frame.get("d_vert", 0)
    frame["cal_vert"] = frame.get("cal_vert", 0)
    frame["mean"] = frame.get("mean", 0)

    frame["dev"] = ensure_list_64(frame.get("dev", []), 0)
    frame["grid"] = ensure_list_64(frame.get("grid", frame.get("raw", [])), 0)
    frame["raw"] = ensure_list_64(frame.get("raw", frame.get("grid", [])), 0)
    frame["cal"] = ensure_list_64(frame.get("cal", []), 0)
    frame["stddev"] = ensure_list_64(frame.get("stddev", []), 0)
    frame["valid"] = ensure_list_64(frame.get("valid", [1] * 64), 0)

    return frame


def normalize_calibration(parsed: dict | None) -> dict:
    cal = copy.deepcopy(parsed) if isinstance(parsed, dict) else {}

    cal["frames"] = cal.get("frames", 0)
    cal["cal_vert"] = cal.get("cal_vert", 0)
    cal["cal_mean_dist"] = cal.get("cal_mean_dist", 0)
    cal["leanback_thresh"] = cal.get("leanback_thresh", -150)

    cal["baseline"] = ensure_list_64(cal.get("baseline", cal.get("grid", [])), 0)
    cal["stddev"] = ensure_list_64(cal.get("stddev", []), 0)
    cal["valid"] = ensure_list_64(cal.get("valid", [1] * 64), 0)

    return cal


def current_posture_label() -> str:
    frame = latest_frame or last_good_frame or {}
    return normalize_posture_label(frame.get("posture", ""))


def current_posture_image() -> str:
    label = current_posture_label()
    image = POSTURE_IMAGE_MAP.get(label, "")
    return f"/images/{image}" if image else ""


# --- Database Dependency ---
def get_db():
    conn = mysql.connector.connect(**DB_CONFIG)
    try:
        yield conn
    finally:
        conn.close()


def get_current_user(session_token: str | None = Cookie(None), conn=Depends(get_db)):
    if not session_token:
        raise HTTPException(status_code=401, detail="Not authenticated")

    cursor = conn.cursor(dictionary=True)
    try:
        cursor.execute("SELECT user_id FROM sessions WHERE session_token = %s", (session_token,))
        session = cursor.fetchone()
        if not session:
            raise HTTPException(status_code=401, detail="Invalid session")
        return session["user_id"]
    finally:
        cursor.close()


def get_user_data(user_id: int, conn):
    cursor = conn.cursor(dictionary=True)
    cursor.execute("SELECT full_name, username FROM users WHERE id = %s", (user_id,))
    user_data = cursor.fetchone()
    cursor.close()
    return user_data


# --- CSV Helpers ---
def init_csv():
    if not os.path.exists(CSV_FILE):
        with open(CSV_FILE, "w", newline="") as f:
            csv.writer(f).writerow(CSV_HEADERS)


def count_csv_rows() -> int:
    if not os.path.exists(CSV_FILE):
        return 0
    with open(CSV_FILE, "r") as f:
        return max(0, sum(1 for _ in f) - 1)


def save_to_csv(label: str, frame: dict, cal: dict) -> int:
    init_csv()

    row = (
        [
            datetime.now().isoformat(),
            label,
            frame.get("vert", 0),
            frame.get("d_vert", 0),
            frame.get("cal_vert", 0),
            frame.get("mean", 0),
            cal.get("leanback_thresh", 0),
        ]
        + frame.get("dev", [0] * 64)
        + frame.get("grid", [0] * 64)
        + cal.get("baseline", [0] * 64)
        + cal.get("stddev", [0] * 64)
        + cal.get("valid", [0] * 64)
    )

    with open(CSV_FILE, "a", newline="") as f:
        csv.writer(f).writerow(row)

    return count_csv_rows()


def get_csv_stats():
    csv_path = CSV_FILE
    if not os.path.exists(csv_path):
        return None

    try:
        df = pd.read_csv(csv_path)
        if df.empty:
            return None

        df["timestamp"] = pd.to_datetime(df["timestamp"])
        total_rows = len(df)

        good_df = df[df["label"] == "GOOD"]
        severe_df = df[df["label"] == "SEVERE_SLOUCH"]
        leaning_df = df[~df["label"].isin(["GOOD", "SEVERE_SLOUCH"])]

        good_pct = round((len(good_df) / total_rows) * 100) if total_rows > 0 else 0
        leaning_pct = round((len(leaning_df) / total_rows) * 100) if total_rows > 0 else 0
        severe_pct = round((len(severe_df) / total_rows) * 100) if total_rows > 0 else 0

        def format_time(seconds):
            h, m = divmod(seconds // 60, 60)
            return f"{h}h {m}m" if h > 0 else f"{m}m"

        df = df.copy()
        df["quality_score"] = df["label"].apply(lambda x: 100 if x == "GOOD" else 0)
        df_resample = df.set_index("timestamp")
        resampled = df_resample["quality_score"].resample("15min").mean().fillna(0)

        timeline = resampled.round().tolist()
        chart_labels = resampled.index.strftime("%H:%M").tolist()

        alerts = df[df["label"] != "GOOD"].tail(5).copy()
        alerts_list = []
        for _, row in alerts.iloc[::-1].iterrows():
            alerts_list.append(
                {
                    "msg": row["label"].replace("_", " ").title(),
                    "time": row["timestamp"].strftime("%I:%M %p"),
                    "type": "red" if "SEVERE" in row["label"] else "yellow",
                }
            )

        return {
            "good_pct": good_pct,
            "leaning_pct": leaning_pct,
            "severe_pct": severe_pct,
            "good_time": format_time(len(good_df) * 5),
            "leaning_time": format_time(len(leaning_df) * 5),
            "severe_time": format_time(len(severe_df) * 5),
            "total_time": format_time(total_rows * 5),
            "chart_data": timeline[-12:],
            "chart_labels": chart_labels[-12:],
            "alerts": alerts_list,
        }
    except Exception as e:
        print(f"[CSV] Error processing CSV: {e}")
        return None


# --- MQTT Handlers ---
def on_connect(client, userdata, flags, reason_code, properties):
    try:
        print(f"[MQTT] Connected to {MQTT_BROKER} with reason_code={reason_code}")
        client.subscribe(TOPIC_DATA)
        client.subscribe(TOPIC_CAL)
        client.subscribe(TOPIC_STATUS)
        print(f"[MQTT] Subscribed: {TOPIC_DATA}, {TOPIC_CAL}, {TOPIC_STATUS}")
    except Exception as e:
        print(f"[MQTT] on_connect error: {e}")


def on_disconnect(client, userdata, disconnect_flags, reason_code, properties):
    print(f"[MQTT] Disconnected reason_code={reason_code}")


def on_message(client, userdata, msg):
    global latest_frame, last_good_frame, calibration, system_status, latest_frame_seq

    try:
        topic = msg.topic
        payload = msg.payload.decode(errors="ignore")

        if topic == TOPIC_DATA:
            parsed = json.loads(payload)
            parsed = normalize_frame(parsed)
            latest_frame = parsed
            last_good_frame = copy.deepcopy(parsed)
            latest_frame_seq += 1
            print(
                f"[MQTT] Frame #{latest_frame_seq} posture={parsed.get('posture')} "
                f"vert={parsed.get('vert')} mean={parsed.get('mean')}"
            )

        elif topic == TOPIC_CAL:
            parsed = json.loads(payload)
            calibration = normalize_calibration(parsed)
            print(
                f"[MQTT] Calibration received frames={calibration.get('frames')} "
                f"cal_vert={calibration.get('cal_vert')}"
            )

        elif topic == TOPIC_STATUS:
            system_status = payload.strip() or "waiting"
            print(f"[MQTT] Status={system_status}")

    except Exception as e:
        print(f"[MQTT] Parse error topic={msg.topic}: {e}")


mqtt_client = mqtt.Client(
    mqtt.CallbackAPIVersion.VERSION2,
    client_id=f"{CLIENT_ID}-main-{uuid.uuid4().hex[:6]}",
)
mqtt_client.on_connect = on_connect
mqtt_client.on_disconnect = on_disconnect
mqtt_client.on_message = on_message


# --- WebSocket Broadcast Helpers ---
def _build_frame_msg(msg_type: str, frame_override=None) -> str:
    frame = frame_override if frame_override is not None else (latest_frame or last_good_frame)
    posture_label = normalize_posture_label((frame or {}).get("posture", ""))
    posture_image = POSTURE_IMAGE_MAP.get(posture_label, "")

    return json.dumps(
        {
            "type": msg_type,
            "status": system_status,
            "frame": frame,
            "calibration": calibration,
            "csv_count": count_csv_rows(),
            "posture_label": posture_label,
            "posture_image": f"/images/{posture_image}" if posture_image else "",
            "break_active": break_active,
            "break_demo": break_demo_mode,
            "break_image": f"/images/{BREAK_IMAGE}",
            "frame_seq": latest_frame_seq,
        }
    )


async def broadcast_loop():
    while True:
        try:
            if clients:
                payload = _build_frame_msg("frame", latest_frame or last_good_frame)
                dead = []

                for ws in clients:
                    try:
                        await ws.send_text(payload)
                    except Exception:
                        dead.append(ws)

                for ws in dead:
                    if ws in clients:
                        clients.remove(ws)

            await asyncio.sleep(0.15)

        except Exception as e:
            print(f"[WS] Broadcast loop error: {e}")
            await asyncio.sleep(0.5)


# --- App Lifespan ---
@asynccontextmanager
async def lifespan(app: FastAPI):
    init_csv()

    try:
        print("[APP] Starting MQTT client")
        mqtt_client.connect(MQTT_BROKER, 1883, 60)
        mqtt_client.loop_start()
    except Exception as e:
        print(f"[APP] MQTT startup failed: {e}")

    broadcaster = asyncio.create_task(broadcast_loop())

    try:
        yield
    finally:
        print("[APP] Shutting down")
        broadcaster.cancel()
        try:
            await broadcaster
        except asyncio.CancelledError:
            pass

        try:
            mqtt_client.loop_stop()
            mqtt_client.disconnect()
        except Exception as e:
            print(f"[APP] MQTT shutdown error: {e}")


app = FastAPI(lifespan=lifespan)
app.mount("/static", StaticFiles(directory="static"), name="static")
app.mount("/images", StaticFiles(directory="images"), name="images")
templates = Jinja2Templates(directory="templates")


# --- Page Routes ---
@app.get("/")
async def root(session_token: str = Cookie(None), conn=Depends(get_db)):
    if not session_token:
        return RedirectResponse("/login")

    cursor = conn.cursor()
    cursor.execute("SELECT id FROM sessions WHERE session_token = %s", (session_token,))
    if not cursor.fetchone():
        cursor.close()
        return RedirectResponse("/login")

    cursor.close()
    return RedirectResponse("/dashboard")


@app.get("/login")
async def login_page(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/dashboard")
async def dashboard_page(request: Request, user_id=Depends(get_current_user), conn=Depends(get_db)):
    return templates.TemplateResponse(
        "dashboard.html",
        {
            "request": request,
            "user": get_user_data(user_id, conn),
            "stats": get_csv_stats(),
            "active_page": "dashboard",
        },
    )


@app.get("/work-session")
async def work_session_page(request: Request, user_id=Depends(get_current_user), conn=Depends(get_db)):
    return templates.TemplateResponse(
        "work_session.html",
        {
            "request": request,
            "user": get_user_data(user_id, conn),
            "active_page": "work_session",
        },
    )


@app.get("/profile")
async def profile_page(request: Request, user_id=Depends(get_current_user), conn=Depends(get_db)):
    return templates.TemplateResponse(
        "profile.html",
        {
            "request": request,
            "user": get_user_data(user_id, conn),
            "stats": get_csv_stats(),
            "active_page": "profile",
        },
    )


@app.get("/summary")
async def summary_page(request: Request, user_id=Depends(get_current_user), conn=Depends(get_db)):
    return templates.TemplateResponse(
        "postura-summary.html",
        {
            "request": request,
            "user": get_user_data(user_id, conn),
            "stats": get_csv_stats(),
            "active_page": "summary",
            "today": datetime.now().strftime("%A, %B %-d"),
        },
    )


# --- Auth API ---
@app.post("/api/register")
async def register(creds: UserRegister, conn=Depends(get_db)):
    cursor = conn.cursor()
    cursor.execute("SELECT id FROM users WHERE username = %s", (creds.username,))
    if cursor.fetchone():
        cursor.close()
        raise HTTPException(status_code=400, detail="Account already exists.")

    hashed = bcrypt.hashpw(creds.password.encode(), bcrypt.gensalt()).decode()
    cursor.execute(
        "INSERT INTO users (username, full_name, password_hash) VALUES (%s, %s, %s)",
        (creds.username, creds.full_name, hashed),
    )
    conn.commit()
    cursor.close()
    return {"success": True}


@app.post("/api/login")
async def login(creds: UserLogin, response: Response, conn=Depends(get_db)):
    cursor = conn.cursor(dictionary=True)
    cursor.execute("SELECT id, password_hash FROM users WHERE username = %s", (creds.username,))
    user = cursor.fetchone()

    if not user or not bcrypt.checkpw(creds.password.encode(), user["password_hash"].encode()):
        cursor.close()
        raise HTTPException(status_code=401, detail="Incorrect credentials.")

    token = str(uuid.uuid4())
    cursor.execute("INSERT INTO sessions (user_id, session_token) VALUES (%s, %s)", (user["id"], token))
    conn.commit()
    cursor.close()

    response.set_cookie(key="session_token", value=token, httponly=True)
    return {"success": True}


@app.post("/api/logout")
async def logout(response: Response, session_token: str = Cookie(None), conn=Depends(get_db)):
    if session_token:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM sessions WHERE session_token = %s", (session_token,))
        conn.commit()
        cursor.close()

    response.delete_cookie("session_token")
    return {"success": True}


# --- Hardware & Break API ---
@app.post("/api/command")
async def send_command(payload: CommandPayload):
    try:
        info = mqtt_client.publish(CMD_TOPIC, payload.cmd)
        print(f"[MQTT] Command published topic={CMD_TOPIC} cmd={payload.cmd} rc={info.rc}")
        return {"status": "success", "message": f"Sent {payload.cmd} to hardware."}
    except Exception as e:
        print(f"[MQTT] Command error: {e}")
        raise HTTPException(status_code=500, detail="Failed to send command to hardware")


@app.post("/api/calibrate")
async def trigger_calibrate():
    info = mqtt_client.publish(CMD_TOPIC, "CALIBRATE")
    print(f"[MQTT] Calibration command sent rc={info.rc}")
    return {"success": True, "message": "Calibration command sent"}


@app.post("/api/save-posture")
async def collect_frame(request: Request):
    frame_snap = copy.deepcopy(last_good_frame or latest_frame)
    cal_snap = copy.deepcopy(calibration)

    if frame_snap is None:
        return {"success": False, "error": "No frame received yet"}

    if cal_snap is None:
        return {"success": False, "error": "No calibration — press Start Calibration first"}

    body = await request.json()
    label = body.get("label", "").strip().upper()

    if label not in VALID_LABELS:
        return {"success": False, "error": f"Invalid label '{label}'"}

    total = save_to_csv(label, frame_snap, cal_snap)
    return {"success": True, "label": label, "csv_count": total}


@app.get("/api/status")
async def get_status():
    return {
        "status": system_status,
        "has_frame": (latest_frame or last_good_frame) is not None,
        "has_calibration": calibration is not None,
        "calibration_frames": calibration.get("frames") if calibration else None,
        "cal_vert": calibration.get("cal_vert") if calibration else None,
        "csv_count": count_csv_rows(),
        "posture_label": current_posture_label(),
        "posture_image": current_posture_image(),
        "break_active": break_active,
        "break_demo": break_demo_mode,
        "break_image": f"/images/{BREAK_IMAGE}",
        "frame_seq": latest_frame_seq,
    }


@app.get("/api/calibration")
async def get_calibration():
    if calibration:
        return {"success": True, "calibration": calibration}
    return {"success": False, "error": "No calibration data yet"}


@app.post("/api/break/start")
async def break_start(demo: bool = Query(default=False)):
    global break_active, break_demo_mode
    break_active = True
    break_demo_mode = demo
    return {
        "success": True,
        "break_active": True,
        "break_demo": demo,
        "break_image": f"/images/{BREAK_IMAGE}",
    }


@app.post("/api/break/end")
async def break_end():
    global break_active, break_demo_mode
    break_active = False
    break_demo_mode = False
    break_compliance_log.append({"timestamp": datetime.now().isoformat(), "complied": True})
    return {"success": True, "break_active": False, "complied": True}


@app.post("/api/break/skip")
async def break_skip():
    global break_active, break_demo_mode
    break_active = False
    break_demo_mode = False
    break_compliance_log.append({"timestamp": datetime.now().isoformat(), "complied": False})
    tip = random.choice(BREAK_HEALTH_TIPS)
    return {
        "success": True,
        "break_active": False,
        "complied": False,
        "tip": {
            "source": tip["source"],
            "url": tip["url"],
            "summary": tip["summary"],
            "image": f"/images/{BREAK_IMAGE}",
        },
    }


@app.get("/api/break/status")
async def break_status():
    return {
        "break_active": break_active,
        "break_demo": break_demo_mode,
        "break_image": f"/images/{BREAK_IMAGE}",
    }


@app.get("/api/break/compliance")
async def get_compliance():
    total = len(break_compliance_log)
    complied = sum(1 for e in break_compliance_log if e["complied"])
    skipped = total - complied
    rate = round((complied / total) * 100, 1) if total > 0 else 0.0

    return {
        "total_breaks": total,
        "complied": complied,
        "skipped": skipped,
        "compliance_rate": rate,
        "log": break_compliance_log,
    }


# --- WebSocket Endpoints ---
@app.websocket("/ws")
@app.websocket("/ws/work_session")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    clients.append(websocket)
    print(f"[WS] Client connected. total_clients={len(clients)}")

    try:
        await websocket.send_text(_build_frame_msg("init", last_good_frame or latest_frame))

        while True:
            try:
                incoming = await asyncio.wait_for(websocket.receive_text(), timeout=30)

                if incoming == "ping":
                    await websocket.send_text(json.dumps({"type": "pong"}))
                elif incoming == "get_state":
                    await websocket.send_text(_build_frame_msg("state", latest_frame or last_good_frame))

            except asyncio.TimeoutError:
                await websocket.send_text(json.dumps({"type": "ping"}))

    except WebSocketDisconnect:
        print("[WS] Client disconnected")
    except Exception as e:
        print(f"[WS] Error: {e}")
    finally:
        if websocket in clients:
            clients.remove(websocket)
        print(f"[WS] Client removed. total_clients={len(clients)}")


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=False)