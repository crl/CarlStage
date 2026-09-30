"""CarlStage 管理的本机图片服务。浏览器操作沿用 ChatGPT-Image-Svc。"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
import os
import threading
import time
import uuid
import subprocess
import uvicorn
from fastapi import FastAPI, File, UploadFile, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from chatgpt_bot import BotWorker, COMPOSER_SELECTORS, LOGIN_HINTS
from login import open_login_browser

DATA = Path(os.environ['CARLSTAGE_CHATGPT_DATA']).resolve()
UPLOADS = DATA / 'input_uploads'
OUTPUT = DATA / 'output'
for directory in [DATA, UPLOADS, OUTPUT]: directory.mkdir(parents=True, exist_ok=True)
TOKEN = os.environ['CARLSTAGE_CHATGPT_TOKEN']
PORT = int(os.environ['CARLSTAGE_CHATGPT_PORT'])
CFG = dict(profile_dir=str(DATA / 'browser-profile'), output_dir=str(OUTPUT),
           proxy=os.environ.get('CARLSTAGE_CHATGPT_PROXY', ''), browser_channel='msedge',
           headless=False, gen_timeout_ms=240000, nav_timeout_ms=60000,
           session_mode='reuse', session_persist_path=str(DATA / 'session.json'))
worker = BotWorker(CFG)
gate = threading.Lock()
cancel_event = threading.Event()
active_refs = set()
login_message = '尚未检查登录状态'
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

@app.exception_handler(RequestValidationError)
async def invalid_request(request, exception):
    return JSONResponse({'detail': '请求参数无效，参考图最多 8 张'}, status_code=422)

@app.middleware('http')
async def authenticate(request: Request, call_next):
    if request.headers.get('x-carlstage-service-token') != TOKEN:
        return JSONResponse({'detail': '请求未授权'}, status_code=403)
    return await call_next(request)

class GenerateRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=16000)
    ref_images: list[str] = Field(default_factory=list, max_length=8)
    timeout_sec: float = Field(default=240, ge=1, le=1800)

class UploadCleanup(BaseModel):
    paths: list[str] = Field(default_factory=list, max_length=8)

@app.post('/uploads/cleanup')
def cleanup(req: UploadCleanup):
    for value in req.paths:
        path = Path(value).resolve()
        if path.parent == UPLOADS and str(path) not in active_refs:
            path.unlink(missing_ok=True)
    return {'ok': True}

@app.post('/cancel')
def cancel():
    cancel_event.set()
    return {'ok': True}

@app.get('/health')
def health():
    return {'service': 'carlstage-chatgpt-image', 'busy': gate.locked() or worker.busy, 'message': login_message}

@app.get('/status')
def status():
    global login_message
    if worker.busy or not gate.acquire(blocking=False): return health()
    try:
        def task(bot):
            if bot._page is None or bot._page.is_closed(): return login_message
            if bot._first_visible(COMPOSER_SELECTORS, 0) is not None and not bot._has_any(LOGIN_HINTS): return '已登录 ChatGPT'
            return '页面尚未就绪，请检查 Edge 登录或网页验证'
        login_message = worker.submit(task, 10)
    except Exception: login_message = '无法检查登录状态，请重新登录 ChatGPT'
    finally: gate.release()
    return health()

def login_job():
    global login_message
    try:
        worker.submit(lambda bot: bot.stop(), 30)
        browser = open_login_browser(CFG['profile_dir'], CFG['proxy'])
        browser.wait()
        login_message = '登录窗口已关闭，可开始生图；登录状态尚未验证'
    except Exception: login_message = '登录未完成，请检查 Edge、网络或网页验证'
    finally: gate.release()

@app.post('/login')
def login():
    global login_message
    if worker.busy or not gate.acquire(blocking=False): raise HTTPException(409, '浏览器正在使用')
    login_message = '请在普通 Edge 中完成登录，看到聊天界面后关闭该窗口'
    threading.Thread(target=login_job, daemon=True).start()
    return {'message': login_message}

@app.post('/session/reset')
def reset():
    if worker.busy or not gate.acquire(blocking=False): raise HTTPException(409, '浏览器正在使用')
    try:
        worker.submit(lambda bot: (bot.start(), bot.reset_session()), 120)
        return {'message': '会话已重置'}
    except Exception: raise HTTPException(500, '会话重置失败，请检查浏览器')
    finally: gate.release()

@app.post('/upload')
async def upload(files: list[UploadFile] = File(...)):
    saved = []
    for file in files:
        suffix = Path(file.filename or '').suffix.lower()
        if suffix not in ['.png', '.jpg', '.jpeg', '.webp']: raise HTTPException(400, '图片格式无效')
        raw = await file.read(20 * 1024 * 1024 + 1)
        if not raw or len(raw) > 20 * 1024 * 1024: raise HTTPException(400, '图片大小无效')
        path = UPLOADS / (uuid.uuid4().hex + suffix)
        path.write_bytes(raw)
        saved.append({'path': str(path)})
    return {'files': saved}

@app.post('/generate')
def generate(req: GenerateRequest):
    if worker.busy or not gate.acquire(blocking=False): raise HTTPException(409, '正在登录或生成，请稍后重试')
    refs = []
    cancel_event.clear()
    try:
        for value in req.ref_images:
            path = Path(value).resolve()
            if path.parent != UPLOADS or not path.is_file(): raise HTTPException(400, '参考图无效')
            refs.append(str(path))
        active_refs.update(refs)
        def task(bot):
            try:
                return bot.generate(req.prompt, timeout_ms=int(req.timeout_sec * 1000), ref_images=refs or None, cancel_event=cancel_event)
            finally:
                for value in refs: Path(value).unlink(missing_ok=True)
                active_refs.difference_update(refs)
        result = worker.submit(task, req.timeout_sec + 180)
        if cancel_event.is_set():
            for entry in result['images']:
                name = entry['file']
                if Path(name).name == name: (OUTPUT / name).unlink(missing_ok=True)
            raise HTTPException(409, '生成已取消')
        return {'ok': True, 'images': [{'file': entry['file']} for entry in result['images']]}
    except HTTPException: raise
    except Exception: raise HTTPException(500, '生成失败，请检查登录、额度、网络或网页验证')
    finally:
        for value in refs:
            if value not in active_refs: Path(value).unlink(missing_ok=True)
        gate.release()

@app.get('/files/{name}')
def files(name: str):
    path = OUTPUT / name
    if Path(name).name != name or not path.is_file(): raise HTTPException(404, '图片不存在')
    return FileResponse(path)

server = uvicorn.Server(uvicorn.Config(app, host='127.0.0.1', port=PORT, log_level='critical', access_log=False))

def parent_watch():
    # The managed stdin pipe reaches EOF even if Node is killed unexpectedly.
    sys.stdin.buffer.read()
    server.should_exit = True
    time.sleep(3)
    if os.name == 'nt':
        subprocess.run(['taskkill', '/PID', str(os.getpid()), '/T', '/F'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW)
    else: os._exit(0)

if __name__ == '__main__':
    threading.Thread(target=parent_watch, daemon=True).start()
    server.run()
    worker._stop_flag.set()
    worker._q.put((None, None))
    worker._thread.join(timeout=2)
    if worker._thread.is_alive() and os.name == 'nt':
        subprocess.run(['taskkill', '/PID', str(os.getpid()), '/T', '/F'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW)
