from contextlib import asynccontextmanager
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, Depends, HTTPException, Response, Cookie
from fastapi.templating import Jinja2Templates
from fastapi.staticfiles import StaticFiles
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
import uvicorn
import asyncio
import json
import os
import uuid
import random
import bcrypt
import mysql.connector
import paho.mqtt.client as mqtt
from dotenv import load_dotenv
import pandas as pd
from datetime import datetime

load_dotenv()

# --- Config ---
# MAKE SURE your .env file or these fallbacks match your C++ code!
MQTT_BROKER = os.getenv("MQTT_BROKER", "test.mosquitto.org") 
MQTT_TOPIC  = os.getenv("MQTT_TOPIC", "chuach1234")
CMD_TOPIC   = f"{MQTT_TOPIC}/cmd"

DB_CONFIG = {
    "host": os.getenv("DB_HOST", "127.0.0.1"),
    "user": os.getenv("DB_USER", "root"),
    "password": os.getenv("DB_PASSWORD", "password"),
    "database": os.getenv("DB_NAME", "postura_db")
}

# --- Break Tips ---
BREAK_HEALTH_TIPS = [
    {
        "source": "Columbia University Irving Medical Center",
        "url": "https://www.cuimc.columbia.edu/news/rx-prolonged-sitting-five-minute-stroll-every-half-hour",
        "summary": "Columbia University researchers tested five different walking schedules on office workers who sat for eight straight hours. Their key finding: just five minutes of light walking every 30 minutes was the only routine that significantly lowered both blood sugar and blood pressure."
    },
    {
        "source": "Harvard Health Publishing",
        "url": "https://www.health.harvard.edu/healthy-aging-and-longevity/walking-breaks-counter-the-effects-of-sitting",
        "summary": "Harvard Health reviewed a controlled study where adults aged 40–70 sat for eight hours while researchers tracked blood sugar and blood pressure every 15–60 minutes. The verdict: five minutes of walking after every 30 minutes of sitting was the only pattern that meaningfully lowered both metrics."
    },
    {
        "source": "National Institutes of Health",
        "url": "https://pmc.ncbi.nlm.nih.gov/articles/PMC8628304/",
        "summary": "A peer-reviewed NIH study from the University of Illinois at Chicago examined the full-body physiological cost of prolonged sitting. Every extra hour of daily sedentary time reduced cardiorespiratory fitness by up to 0.24 METs."
    },
]

# --- State ---
latest_frame = None
last_good_frame = None
calibration = None
system_status = "waiting"
break_active = False
break_demo_mode = False
break_compliance_log = []
clients: list[WebSocket] = []

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
        return session['user_id']
    finally:
        cursor.close()

def get_user_data(user_id: int, conn):
    cursor = conn.cursor(dictionary=True)
    cursor.execute("SELECT full_name, username FROM users WHERE id = %s", (user_id,))
    user_data = cursor.fetchone()
    cursor.close()
    return user_data

# --- CSV Reader Helper ---
def get_csv_stats():
    csv_path = "posture_data.csv"
    if not os.path.exists(csv_path):
        return None

    try:
        df = pd.read_csv(csv_path)
        if df.empty: return None

        df['timestamp'] = pd.to_datetime(df['timestamp'])
        total_rows = len(df)
        good_df = df[df['label'] == 'GOOD']
        severe_df = df[df['label'] == 'SEVERE_SLOUCH']
        leaning_df = df[~df['label'].isin(['GOOD', 'SEVERE_SLOUCH'])]

        good_pct = round((len(good_df) / total_rows) * 100) if total_rows > 0 else 0
        leaning_pct = round((len(leaning_df) / total_rows) * 100) if total_rows > 0 else 0
        severe_pct = round((len(severe_df) / total_rows) * 100) if total_rows > 0 else 0

        def format_time(seconds):
            h, m = divmod(seconds // 60, 60)
            return f"{h}h {m}m" if h > 0 else f"{m}m"

        df['quality_score'] = df['label'].apply(lambda x: 100 if x == 'GOOD' else 0)
        df_resample = df.set_index('timestamp')
        resampled = df_resample['quality_score'].resample('15min').mean().fillna(0)
        
        timeline = resampled.round().tolist()
        chart_labels = resampled.index.strftime('%H:%M').tolist()

        alerts = df[df['label'] != 'GOOD'].tail(5).copy()
        alerts_list = []
        for _, row in alerts.iloc[::-1].iterrows():
            alerts_list.append({
                "msg": row['label'].replace('_', ' ').title(),
                "time": row['timestamp'].strftime('%I:%M %p'),
                "type": "red" if "SEVERE" in row['label'] else "yellow"
            })

        return {
            "good_pct": good_pct, "leaning_pct": leaning_pct, "severe_pct": severe_pct,
            "good_time": format_time(len(good_df) * 5),
            "leaning_time": format_time(len(leaning_df) * 5),
            "severe_time": format_time(len(severe_df) * 5),
            "total_time": format_time(total_rows * 5),
            "chart_data": timeline[-12:], "chart_labels": chart_labels[-12:],
            "alerts": alerts_list
        }
    except Exception as e:
        print(f"Error processing CSV: {e}")
        return None

# --- MQTT Handlers ---
def on_message(client, userdata, msg):
    global latest_frame, last_good_frame, calibration, system_status
    try:
        topic = msg.topic
        if topic == f"{MQTT_TOPIC}/data":
            parsed = json.loads(msg.payload.decode())
            latest_frame = parsed
            last_good_frame = parsed
        elif topic == f"{MQTT_TOPIC}/calibration":
            calibration = json.loads(msg.payload.decode())
        elif topic == f"{MQTT_TOPIC}/status":
            system_status = msg.payload.decode()
    except Exception:
        pass

mqtt_client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
mqtt_client.on_message = on_message

async def broadcast_loop():
    global latest_frame, system_status, calibration
    while True:
        if latest_frame and clients:
            payload = json.dumps({
                "type": "frame", "status": system_status,
                "frame": latest_frame, "calibration": calibration
            })
            for ws in clients[:]:
                try: await ws.send_text(payload)
                except: clients.remove(ws)
            latest_frame = None
        await asyncio.sleep(0.1)

@asynccontextmanager
async def lifespan(app: FastAPI):
    mqtt_client.connect(MQTT_BROKER, 1883, 60)
    mqtt_client.subscribe(f"{MQTT_TOPIC}/#")
    mqtt_client.loop_start()
    asyncio.create_task(broadcast_loop())
    yield
    mqtt_client.loop_stop()

app = FastAPI(lifespan=lifespan)
app.mount("/static", StaticFiles(directory="static"), name="static")
app.mount("/images", StaticFiles(directory="images"), name="images")
templates = Jinja2Templates(directory="templates")

# --- Routes ---
@app.get("/")
async def root(session_token: str = Cookie(None), conn=Depends(get_db)):
    if not session_token: return RedirectResponse("/login")
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
    return templates.TemplateResponse("dashboard.html", {
        "request": request, "user": get_user_data(user_id, conn),
        "stats": get_csv_stats(), "active_page": "dashboard",
    })

@app.get("/work-session")
async def work_session_page(request: Request, user_id=Depends(get_current_user), conn=Depends(get_db)):
    return templates.TemplateResponse("work_session.html", {
        "request": request, "user": get_user_data(user_id, conn),
        "active_page": "work_session",
    })

@app.get("/profile")
async def profile_page(request: Request, user_id=Depends(get_current_user), conn=Depends(get_db)):
    return templates.TemplateResponse("profile.html", {
        "request": request, "user": get_user_data(user_id, conn),
        "stats": get_csv_stats(), "active_page": "profile",
    })

@app.get("/summary")
async def summary_page(request: Request, user_id=Depends(get_current_user), conn=Depends(get_db)):
    return templates.TemplateResponse("postura-summary.html", {
        "request": request, "user": get_user_data(user_id, conn),
        "stats": get_csv_stats(), "active_page": "summary",
        "today": datetime.now().strftime("%A, %B %-d"),
    })

# --- Auth API ---
@app.post("/api/register")
async def register(creds: UserRegister, conn=Depends(get_db)):
    cursor = conn.cursor()
    cursor.execute("SELECT id FROM users WHERE username = %s", (creds.username,))
    if cursor.fetchone():
        cursor.close()
        raise HTTPException(status_code=400, detail="Account already exists.")

    hashed = bcrypt.hashpw(creds.password.encode(), bcrypt.gensalt()).decode()
    cursor.execute("INSERT INTO users (username, full_name, password_hash) VALUES (%s, %s, %s)", 
                   (creds.username, creds.full_name, hashed))
    conn.commit()
    cursor.close()
    return {"success": True}

@app.post("/api/login")
async def login(creds: UserLogin, response: Response, conn=Depends(get_db)):
    cursor = conn.cursor(dictionary=True)
    cursor.execute("SELECT id, password_hash FROM users WHERE username = %s", (creds.username,))
    user = cursor.fetchone()

    if not user or not bcrypt.checkpw(creds.password.encode(), user['password_hash'].encode()):
        cursor.close()
        raise HTTPException(status_code=401, detail="Incorrect credentials.")

    token = str(uuid.uuid4())
    cursor.execute("INSERT INTO sessions (user_id, session_token) VALUES (%s, %s)", (user['id'], token))
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

# --- Hardware / Break API ---
@app.post("/api/command")
async def send_command(payload: CommandPayload):
    """Takes the fetch() from the JS and pushes it out to the ESP32"""
    try:
        # Use the existing background MQTT client to publish
        mqtt_client.publish(CMD_TOPIC, payload.cmd)
        return {"status": "success", "message": f"Sent {payload.cmd} to hardware."}
    except Exception as e:
        print(f"MQTT Error: {e}")
        raise HTTPException(status_code=500, detail="Failed to send command to hardware")

# Kept this just in case you had old UI buttons relying on it
@app.post("/api/calibrate") 
async def trigger_calibrate():
    mqtt_client.publish(CMD_TOPIC, "CALIBRATE")
    return {"success": True}

@app.post("/api/break/start")
async def break_start(demo: bool = False):
    global break_active, break_demo_mode
    break_active = True
    break_demo_mode = demo
    return {"success": True, "break_active": True}

@app.post("/api/break/end")
async def break_end():
    global break_active
    break_active = False
    break_compliance_log.append({"timestamp": datetime.now().isoformat(), "complied": True})
    return {"success": True}

@app.post("/api/break/skip")
async def break_skip():
    global break_active
    break_active = False
    break_compliance_log.append({"timestamp": datetime.now().isoformat(), "complied": False})
    return {"success": True, "tip": random.choice(BREAK_HEALTH_TIPS)}

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    clients.append(websocket)
    try:
        while True: await websocket.receive_text()
    except WebSocketDisconnect:
        if websocket in clients: clients.remove(websocket)

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)