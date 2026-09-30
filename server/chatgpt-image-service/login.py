"""直接启动系统 Edge 人工登录，关闭窗口后再交给生图服务。"""
import os
import subprocess
from pathlib import Path

def open_login_browser(profile, proxy=''):
    candidates = [
        Path(os.environ.get('PROGRAMFILES(X86)', r'C:\Program Files (x86)')) / 'Microsoft/Edge/Application/msedge.exe',
        Path(os.environ.get('PROGRAMFILES', r'C:\Program Files')) / 'Microsoft/Edge/Application/msedge.exe',
        Path(os.environ.get('LOCALAPPDATA', '')) / 'Microsoft/Edge/Application/msedge.exe',
    ]
    edge = next((path for path in candidates if path.is_file()), None)
    if edge is None: raise RuntimeError('未找到系统 Edge，请先安装 Edge。')
    Path(profile).mkdir(parents=True, exist_ok=True)
    args = [str(edge), f'--user-data-dir={Path(profile).resolve()}', '--no-first-run', '--no-default-browser-check']
    if proxy: args.append(f'--proxy-server={proxy}')
    args.append('https://chatgpt.com/auth/login')
    return subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == '__main__':
    try:
        browser = open_login_browser(Path(os.environ['CARLSTAGE_CHATGPT_DATA']) / 'browser-profile', os.environ.get('CARLSTAGE_CHATGPT_PROXY', ''))
        print('请在 Edge 中完成登录，看到聊天界面后关闭此窗口。')
        browser.wait()
        print('浏览器已关闭，可以使用 CarlStage 生图。')
    except Exception:
        print('登录窗口无法启动，请检查 Edge 和登录目录是否正在使用。')
        raise SystemExit(1)
