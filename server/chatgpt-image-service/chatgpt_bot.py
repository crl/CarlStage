# -*- coding: utf-8 -*-
"""ChatGPT 生图自动化核心。

用 Playwright 驱动本机 Edge 的独立 profile，直接操作 https://chatgpt.com/images 页面：
输入提示词 -> 点击发送 -> 等待出图 -> 把图片下载到本地目录。

所有 Playwright 调用都必须发生在 BotWorker 那一个工作线程里（sync API 不跨线程）。
"""

from __future__ import annotations

import base64
import json
import logging
import os
import queue
import re
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Optional

from playwright.sync_api import TimeoutError as PWTimeoutError
from playwright.sync_api import sync_playwright

log = logging.getLogger("chatgpt_bot")
log.disabled = True

COMPOSER_SELECTORS = [
    "div#prompt-textarea[contenteditable='true']",
    "div[contenteditable='true']#prompt-textarea",
    "textarea#prompt-textarea",
    "form div[contenteditable='true']",
    "div[contenteditable='true'][role='textbox']",
]

# 上传图片的入口（按优先级）：input[type=file] -> 触发按钮（点开后再找 input）
IMAGE_UPLOAD_INPUT_SELECTORS = [
    "input[type='file'][aria-label*='添加照片']",
    "input[type='file'][aria-label*='照片']",
    "input[type='file'][aria-label*='Attach photo']",
    "input[type='file'][aria-label*='image']",
    "input[type='file'][accept*='image']",
]

IMAGE_UPLOAD_BUTTON_SELECTORS = [
    "button[aria-label*='添加文件']",
    "button[aria-label*='添加照片']",
    "button[aria-label*='Attach']",
    "button[aria-label*='Add photos']",
    "button[data-testid='composer-plus-btn']",
]

# 附件上传成功的判定选择器（页面出现附件预览即代表上传完成）
ATTACHMENT_PRESENT_SELECTORS = [
    "[data-composer-attachments]:not([hidden])",
    "div[data-composer-attachments] img",
    "img[alt*='已上传']",
    "img[src^='blob:']",
    "button[aria-label*='移除']",
    "button[aria-label*='Remove']",
]

UPLOAD_DONE_JS = r"""
() => {
  const box = document.querySelector('[data-composer-attachments]');
  if (box && !box.hasAttribute('hidden')) {
    const n = box.querySelectorAll('img').length;
    if (n > 0) return n;
    if (box.children.length > 0) return box.children.length;
  }
  let n = 0;
  document.querySelectorAll("button[aria-label*='移除'],button[aria-label*='Remove']").forEach(b => {
    if (b.offsetParent !== null) n++;
  });
  return n;
}
"""

SEND_SELECTORS = [
    "button[data-testid='send-button']",
    "button[aria-label='Send message']",
    "button[aria-label*='Send message']",
    "button[aria-label='发送消息']",
    "button[aria-label*='发送']",
    "button[data-testid='composer-send-button']",
]

STOP_SELECTORS = [
    "button[data-testid='stop-button']",
    "button[aria-label='Stop generating']",
    "button[aria-label*='Stop']",
    "button[aria-label*='停止']",
]

LOGIN_HINTS = [
    "button[data-testid='login-button']",
    "a[href*='/auth/login']",
    "button:has-text('Log in')",
    "button:has-text('登录')",
]

LIMIT_HINTS = [
    "you've reached",
    "reached the limit",
    "limit of",
    "try again later",
    "something went wrong",
    "达到上限",
    "配额",
    "额度已用完",
    "出了点问题",
]

COLLECT_IMG_JS = r"""
() => {
  const out = [];
  document.querySelectorAll('img').forEach(img => {
    const s = img.currentSrc || img.src || '';
    if (!s) return;
    // 用户消息中的附件不能作为生成结果；尺寸相同不能判断图片身份。
    if (img.closest('[data-message-author-role="user"]')) return;

    // 规则一（最本质）：引用图预览是内联的 data:image/...，生成结果一定是远程/blob
    if (s.startsWith('data:')) return;

    const ok = s.startsWith('blob:') || s.includes('oaiusercontent')
            || s.includes('backend-api') || s.includes('estuary');
    if (!ok) return;

    // 规则二：元素自身或任意祖先带 composer 特征（含 class 名）即视为输入框内的引用图
    let node = img;
    for (let i = 0; i < 14 && node; i++) {
      const cls = (typeof node.className === 'string') ? node.className : '';
      const tag = node.tagName || '';
      const hasMark = node.getAttribute && (
           node.hasAttribute('data-composer-attachments')
        || node.hasAttribute('data-chatgpt-composer')
        || node.hasAttribute('data-composer-layout')
        || node.hasAttribute('data-composer-body')
        || node.hasAttribute('data-composer-surface-variant')
      );
      if (hasMark || /(^|[\s-])composer/i.test(cls) || tag === 'FORM') return;
      node = node.parentElement;
    }

    // 规则三：昵称/头像等小图
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    if (w < 200 || h < 200) return;

    out.push({ src: s, w: w, h: h });
  });
  return out;
}
"""

MESSAGE_STATE_JS = r"""
() => {
  const users = [...document.querySelectorAll('[data-message-author-role="user"]')];
  const last = users.at(-1);
  const key = last?.getAttribute('data-message-id') || last?.closest('[data-testid^="conversation-turn-"]')?.getAttribute('data-testid') || '';
  return {key, count: users.length};
}
"""

LATEST_RESPONSE_JS = r"""
(before) => {
  const users = [...document.querySelectorAll('[data-message-author-role="user"]')];
  const user = users.at(-1);
  if (!user) return [];
  const key = user.getAttribute('data-message-id') || user.closest('[data-testid^="conversation-turn-"]')?.getAttribute('data-testid') || '';
  if (key ? key === before.key : users.length <= before.count) return [];
  const replies = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
  const reply = replies.at(-1);
  if (!reply || !(user.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING)) return [];
  return [...reply.querySelectorAll('img')].filter(img => img.complete && img.naturalWidth >= 200 && img.naturalHeight >= 200)
    .map(img => ({src: img.currentSrc || img.src, w: img.naturalWidth, h: img.naturalHeight}))
    .filter(img => /^(https?:|blob:)/.test(img.src));
}
"""


def load_config(path: Optional[str] = None) -> dict:
    cfg_path = Path(path or os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json"))
    with open(cfg_path, "r", encoding="utf-8") as f:
        return json.load(f)


class ChatGPTImageBot:
    """单浏览器上下文 + 单页面，串行执行生成任务。

    会话策略：默认把多次生成**复用同一个会话**，避免每跑一次就在侧边栏多出一个新会话。
    - `session_mode="reuse"`（默认）：锁定一个会话，后续请求都往里面发
    - `session_mode="new"`：每次生成都开新会话（老行为）
    """

    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.profile_dir = cfg["profile_dir"]
        self.output_dir = cfg["output_dir"]
        self.proxy = (cfg.get("proxy") or "").strip() or None
        self.channel = cfg.get("browser_channel", "msedge")
        self.headless = bool(cfg.get("headless", False))
        self.nav_timeout = int(cfg.get("nav_timeout_ms", 60000))
        self.gen_timeout = int(cfg.get("gen_timeout_ms", 240000))
        self.start_url = cfg.get("start_url", "https://chatgpt.com/images")
        self.fallback_url = cfg.get("fallback_url", "https://chatgpt.com/")
        self.max_images_before_new_chat = int(cfg.get("new_chat_when_images_over", 30))
        self.session_mode = (cfg.get("session_mode") or "reuse").lower()
        self.session_url = (cfg.get("session_url") or "").strip() or None
        self.session_persist_path = cfg.get("session_persist_path") or os.path.join(
            os.path.dirname(os.path.abspath(__file__)), "session.json"
        )
        self.auto_reuse_detection = bool(cfg.get("auto_reuse_detection", True))

        os.makedirs(self.profile_dir, exist_ok=True)
        os.makedirs(self.output_dir, exist_ok=True)

        self._pw = None
        self._ctx = None
        self._page = None
        self.state = "stopped"
        self.last_error: Optional[str] = None
        self.on_images_page = False
        self._seq = 0
        self._seen_urls: set[str] = set()
        self.upload_ok: bool = False
        self.last_upload_error: Optional[str] = None
        self._ref_fingerprints: set[tuple] = set()
        self._reuse_url: Optional[str] = self.session_url
        self.last_session_url: Optional[str] = None
        self.session_reused_count: int = 0

        if not self._reuse_url:
            self._load_persisted_session()

    # ------------------------------------------------------------------ 生命周期

    def start(self) -> None:
        if self._ctx is not None:
            return
        self.state = "starting"
        launch_kwargs: dict[str, Any] = dict(
            user_data_dir=self.profile_dir,
            channel=self.channel,
            headless=self.headless,
            viewport={"width": 1440, "height": 960},
            locale="zh-CN",
            timezone_id="Asia/Shanghai",
        )
        if self.proxy:
            launch_kwargs["proxy"] = {"server": self.proxy}

        self._pw = sync_playwright().start()
        try:
            self._ctx = self._pw.chromium.launch_persistent_context(**launch_kwargs)
        except Exception as exc:
            self._pw.stop()
            self._pw = None
            self.state = "error"
            msg = str(exc)
            hint = ""
            if any(k in msg.lower() for k in ("in use", "lock", "singleton", "profile")):
                hint = "（浏览器 profile 正被占用：请先关闭正在运行的服务窗口或本项目拉起的 Edge，再重试）"
            self.last_error = f"浏览器启动失败: {msg}{hint}"
            raise
        self._ctx.set_default_timeout(self.nav_timeout)
        self._page = self._ctx.pages[0] if self._ctx.pages else self._ctx.new_page()
        self._page.set_default_timeout(self.nav_timeout)
        self.state = "ready"
        log.info("浏览器已启动 (channel=%s, headless=%s, proxy=%s)", self.channel, self.headless, self.proxy)

    def stop(self) -> None:
        for closer in (getattr(self._ctx, "close", None), getattr(self._pw, "stop", None)):
            try:
                if closer:
                    closer()
            except Exception:
                pass
        self._ctx = None
        self._pw = None
        self._page = None
        self.state = "stopped"

    # ------------------------------------------------------------------ 会话复用

    def _load_persisted_session(self) -> None:
        try:
            if os.path.isfile(self.session_persist_path):
                with open(self.session_persist_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                url = (data or {}).get("session_url") or ""
                if url.startswith("http"):
                    self._reuse_url = url
                    log.info("已加载持久化会话: %s", url)
        except Exception as exc:
            log.debug("读取会话持久化文件失败: %s", exc)

    def _persist_session(self, url: str) -> None:
        try:
            with open(self.session_persist_path, "w", encoding="utf-8") as f:
                json.dump({"session_url": url, "updated": time.strftime("%Y-%m-%d %H:%M:%S")}, f,
                          ensure_ascii=False, indent=2)
        except Exception as exc:
            log.debug("写入会话持久化文件失败: %s", exc)

    @staticmethod
    def _looks_like_session_url(url: str) -> bool:
        """chatgpt.com/c/<id> 或 chatgpt.com/images/c/<id> 这类会话页。"""
        if not url:
            return False
        return bool(re.search(r"chatgpt\.com/(?:images/)?c/[0-9a-f]{8,}", url, re.IGNORECASE))

    def _current_session_url(self) -> Optional[str]:
        try:
            url = self._page.url or ""
        except Exception:
            return None
        return url if self._looks_like_session_url(url) else None

    def _maybe_reuse_session(self) -> None:
        """发送前把页面导航到复用会话（若不在该会话中）。"""
        if self.session_mode != "reuse" or not self._reuse_url:
            return
        page = self._page
        try:
            current = page.url or ""
        except Exception:
            current = ""
        if current.rstrip("/") == self._reuse_url.rstrip("/"):
            return
        log.info("复用已有会话: %s", self._reuse_url)
        try:
            page.goto(self._reuse_url, wait_until="domcontentloaded", timeout=self.nav_timeout)
            self._first_visible(COMPOSER_SELECTORS, 30000)
            self.on_images_page = True
            self.session_reused_count += 1
        except Exception as exc:
            log.warning("进入复用会话失败（将退回新建会话）: %s", exc)
            self._reuse_url = None

    def _remember_session(self) -> None:
        """发送后记录当前会话 URL，供下次复用。"""
        url = self._current_session_url()
        if not url:
            return
        self.last_session_url = url
        if self.session_mode == "reuse" and url != self._reuse_url:
            self._reuse_url = url
            self._persist_session(url)
            log.info("已锁定生成会话（后续请求将复用）: %s", url)

    def reset_session(self, keep_history: bool = True) -> dict:
        """显式开新会话。reuse 模式下更新锁定的会话地址；old 会话仍在侧边栏可回看。"""
        old = self._reuse_url
        self._reuse_url = None
        self.last_session_url = None
        try:
            if os.path.isfile(self.session_persist_path):
                os.remove(self.session_persist_path)
        except Exception:
            pass
        if self._ctx is not None:
            self.goto_images()
            self._remember_session()
        return {"old_session": old, "new_session": self._reuse_url}

    # ------------------------------------------------------------------ 页面工具

    def _ensure_page(self):
        """页面被关掉/崩溃时自动重建，避免整条链路挂掉。"""
        if self._ctx is None:
            return None
        try:
            if self._page is None or self._page.is_closed():
                self._page = self._ctx.pages[-1] if self._ctx.pages else self._ctx.new_page()
                self._page.set_default_timeout(self.nav_timeout)
                log.warning("页面已失效，已重建新页面")
        except Exception as exc:
            log.error("重建页面失败: %s", exc)
        return self._page

    def _first_visible(self, selectors: list[str], timeout_ms: int = 0, within=None):
        """轮询返回第一个可见元素，超时或页面失效时返回 None。"""
        page = self._ensure_page()
        if page is None:
            return None
        root = within or page
        deadline = time.time() + timeout_ms / 1000.0
        while True:
            for sel in selectors:
                try:
                    loc = root.locator(sel).first
                    if loc.count() > 0 and loc.is_visible():
                        return loc
                except Exception:
                    continue
            if time.time() >= deadline:
                return None
            try:
                page.wait_for_timeout(400)
            except Exception:
                self._page = None
                self._ensure_page()
                return None

    def _has_any(self, selectors: list[str]) -> bool:
        return self._first_visible(selectors, 0) is not None

    def _page_text(self) -> str:
        try:
            return (self._page.inner_text("body") or "").lower()
        except Exception:
            return ""

    def goto_images(self, timeout_ms: Optional[int] = None) -> bool:
        """打开生图页面，返回是否找到输入框。"""
        page = self._ensure_page()
        if page is None:
            self.start()
            page = self._ensure_page()
        timeout_ms = timeout_ms or self.nav_timeout
        try:
            page.goto(self.start_url, wait_until="domcontentloaded", timeout=timeout_ms)
        except PWTimeoutError:
            log.warning("打开 %s 超时，继续尝试后续探测", self.start_url)

        composer = self._first_visible(COMPOSER_SELECTORS, 45000)
        self.on_images_page = composer is not None
        if composer is not None:
            return True

        if self._has_any(LOGIN_HINTS):
            self.state = "need_login"
            return False

        log.warning("/images 未找到输入框，回退到主对话页 %s", self.fallback_url)
        try:
            page.goto(self.fallback_url, wait_until="domcontentloaded", timeout=timeout_ms)
        except PWTimeoutError:
            pass
        composer = self._first_visible(COMPOSER_SELECTORS, 45000)
        self.on_images_page = False
        if composer is not None:
            self.state = "ready"
            return True
        if self._has_any(LOGIN_HINTS):
            self.state = "need_login"
        return False

    def login_state(self) -> str:
        """logged_in / need_login / unknown"""
        try:
            if self._first_visible(COMPOSER_SELECTORS, 0) is not None:
                return "logged_in"
            if self._has_any(LOGIN_HINTS):
                return "need_login"
            txt = self._page_text()
            if "log in" in txt or "登录" in txt:
                return "need_login"
        except Exception:
            pass
        return "unknown"

    # ------------------------------------------------------------------ 图片采集

    def _register_ref_fingerprints(self, paths: list[str]) -> None:
        """记录引用图的尺寸指纹，用于兜底排除误采集的预览图。"""
        self._ref_fingerprints = set()
        for p in paths or []:
            size = self._read_png_size(p) or self._read_jpeg_size(p)
            if size:
                self._ref_fingerprints.add(size)
        if self._ref_fingerprints:
            log.info("引用图尺寸指纹: %s", self._ref_fingerprints)

    @staticmethod
    def _read_png_size(path: str) -> Optional[tuple]:
        try:
            with open(path, "rb") as f:
                head = f.read(24)
            if len(head) >= 24 and head[:8] == b"\x89PNG\r\n\x1a\n":
                import struct
                w, h = struct.unpack(">II", head[16:24])
                return (int(w), int(h))
        except Exception:
            pass
        return None

    @staticmethod
    def _read_jpeg_size(path: str) -> Optional[tuple]:
        try:
            import struct
            with open(path, "rb") as f:
                data = f.read()
            if data[:2] != b"\xff\xd8":
                return None
            i = 2
            while i < len(data) - 9:
                if data[i] != 0xFF:
                    i += 1
                    continue
                marker = data[i + 1]
                if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
                              0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                    h, w = struct.unpack(">HH", data[i + 5:i + 9])
                    return (int(w), int(h))
                seg = struct.unpack(">H", data[i + 2:i + 4])[0]
                i += 2 + seg
        except Exception:
            pass
        return None

    def collect_images(self) -> list[dict]:
        try:
            items = self._page.evaluate(COLLECT_IMG_JS) or []
        except Exception as exc:
            log.debug("采集图片失败: %s", exc)
            return []
        seen, out = set(), []
        for it in items:
            src = it.get("src")
            if not src or src in seen:
                continue
            seen.add(src)
            out.append(it)
        return out

    def _is_generating(self) -> bool:
        if self._has_any(STOP_SELECTORS):
            return True
        return False

    def response_state(self):
        return self._page.evaluate(MESSAGE_STATE_JS)

    def collect_response_images(self, before):
        return self._page.evaluate(LATEST_RESPONSE_JS, before) or []

    def _check_limit_error(self) -> Optional[str]:
        txt = self._page_text()
        for hint in LIMIT_HINTS:
            if hint in txt:
                return hint
        return None

    def _maybe_new_chat(self, count: int) -> None:
        if count < self.max_images_before_new_chat:
            return
        for sel in ("a[href='/images']", "button[data-testid='new-chat-button']", "a[data-testid='new-chat-button']"):
            try:
                loc = self._page.locator(sel).first
                if loc.count() > 0 and loc.is_visible():
                    loc.click()
                    self._page.wait_for_timeout(2000)
                    log.info("会话图片过多，已开启新会话")
                    return
            except Exception:
                continue

    # ------------------------------------------------------------------ 引用图片上传

    def _wait_upload_done(self, expected: int, timeout_ms: int = 120000) -> int:
        """等待附件预览出现，返回检测到的附件数量。"""
        deadline = time.time() + timeout_ms / 1000.0
        best = 0
        while time.time() < deadline:
            try:
                n = int(self._page.evaluate(UPLOAD_DONE_JS) or 0)
            except Exception:
                n = 0
            best = max(best, n)
            if n >= expected:
                # 再多等一会儿确保缩略图/服务端校验完成
                self._page.wait_for_timeout(1200)
                return n
            self._page.wait_for_timeout(500)
        return best

    def attach_images(self, paths: list[str], timeout_ms: int = 120000) -> dict:
        """把本地图片作为引用图上传到输入框。路径需为绝对路径，且文件存在。"""
        if not paths:
            return {"attached": 0}

        existing = [p for p in paths if os.path.isfile(p)]
        missing = [p for p in paths if not os.path.isfile(p)]
        if missing:
            raise FileNotFoundError("以下图片不存在: " + "; ".join(missing))
        if not existing:
            raise ValueError("没有可用的图片路径")

        page = self._ensure_page()
        if self._first_visible(COMPOSER_SELECTORS, 0) is None:
            if not self.goto_images():
                raise RuntimeError("找不到输入框，无法上传引用图（可能未登录）")

        # 1) 先尝试直接定位可用的 file input
        target = self._find_usable_file_input()
        if target is None:
            # 2) 点「添加文件等内容」按钮，让它把 input 渲染出来
            btn = self._first_visible(IMAGE_UPLOAD_BUTTON_SELECTORS, 8000)
            if btn is not None:
                try:
                    btn.click()
                    page.wait_for_timeout(1200)
                except Exception as exc:
                    log.warning("点击上传按钮失败: %s", exc)
            target = self._find_usable_file_input()
        if target is None:
            raise RuntimeError(
                "未找到可用的图片上传入口。可能是页面结构变化或未登录，"
                "可运行 selftest.py 查看 logs/selftest.png 确认页面状态。"
            )

        before = self._count_attachments()
        target.set_input_files(existing)
        log.info("已提交 %d 张引用图，等待上传完成...", len(existing))

        got = self._wait_upload_done(before + len(existing), timeout_ms)
        if got <= before:
            self.upload_ok = False
            self.last_upload_error = f"未检测到附件预览（等待 {timeout_ms / 1000:.0f}s）"
            raise TimeoutError(
                f"上传后未检测到附件预览（超时 {timeout_ms / 1000:.0f}s）。"
                "可能是图片过大或网络过慢，也可能页面结构已变。"
            )
        self.upload_ok = True
        self.last_upload_error = None
        page.wait_for_timeout(800)
        return {"attached": got - before, "requested": len(existing), "files": existing}

    def _find_usable_file_input(self):
        """返回第一个未被 disabled 的图片上传 input，找不到返回 None。"""
        for sel in IMAGE_UPLOAD_INPUT_SELECTORS:
            try:
                loc = self._page.locator(sel)
                for i in range(min(loc.count(), 6)):
                    item = loc.nth(i)
                    if item.is_enabled():
                        return item
            except Exception:
                continue
        # 兜底：任意 enabled 的 file input
        try:
            loc = self._page.locator("input[type='file']")
            for i in range(min(loc.count(), 8)):
                item = loc.nth(i)
                if item.is_enabled():
                    return item
        except Exception:
            pass
        return None

    def _count_attachments(self) -> int:
        try:
            return int(self._page.evaluate(UPLOAD_DONE_JS) or 0)
        except Exception:
            return 0

    # ------------------------------------------------------------------ 生成主流程

    def generate(self, prompt: str, timeout_ms: Optional[int] = None,
                 ref_images: Optional[list[str]] = None, cancel_event=None) -> dict:
        self.start()
        timeout_ms = timeout_ms or self.gen_timeout
        page = self._ensure_page()

        if self._first_visible(COMPOSER_SELECTORS, 0) is None or not self.on_images_page:
            if not self.goto_images():
                raise RuntimeError(
                    "找不到输入框：可能未登录，或 chatgpt.com 被 Cloudflare 拦截。"
                    "请先运行 login.py 完成登录，并确认代理可用。"
                )

        composer = self._first_visible(COMPOSER_SELECTORS, 30000)
        if composer is None:
            raise RuntimeError("输入框未能就绪")

        # 先记录当前已有图片（用于判断"哪些是新生成的"），再视情况决定是否开新会话
        before = {it["src"] for it in self.collect_images()}
        if self.session_mode == "reuse" and self.auto_reuse_detection:
            self._maybe_reuse_session()
        else:
            self._maybe_new_chat(len(before))

        # 上传引用图（必须在输入提示词之前，避免附件状态与文本互相干扰）
        attach_info = {"attached": 0}
        if ref_images:
            self._register_ref_fingerprints(ref_images)
            attach_info = self.attach_images(ref_images)
            composer = self._first_visible(COMPOSER_SELECTORS, 30000)
            if composer is None:
                raise RuntimeError("上传引用图后输入框丢失")
        else:
            self._ref_fingerprints = set()

        # 输入提示词
        try:
            composer.click()
        except Exception:
            composer.click(force=True)
        page.keyboard.press("Control+A")
        page.keyboard.press("Delete")
        composer.click()
        page.keyboard.insert_text(prompt)
        page.wait_for_timeout(500)

        # 提交
        before = {it["src"] for it in self.collect_images()}
        if cancel_event and cancel_event.is_set():
            raise RuntimeError("生成已取消")
        response_before = self.response_state()
        send = self._first_visible(SEND_SELECTORS, 5000)
        if send is not None and send.is_enabled():
            send.click()
        else:
            page.keyboard.press("Enter")
        log.info("已提交提示词: %s", prompt[:60])

        # 等待出图
        deadline = time.time() + timeout_ms / 1000.0
        found: list[dict] = []
        started_at = time.time()
        while time.time() < deadline:
            if cancel_event and cancel_event.is_set():
                stop = self._first_visible(['button[data-testid="stop-button"]', 'button[aria-label="Stop streaming"]'], 0)
                if stop is not None:
                    try: stop.click(timeout=2000)
                    except Exception: pass
                raise RuntimeError("生成已取消")
            page.wait_for_timeout(1500)
            items = self.collect_response_images(response_before)
            new_items = [it for it in items if it["src"] not in before and it["src"] not in self._seen_urls]
            if new_items:
                # 出图后仍可能有第二张，等一下确认生成结束
                if time.time() - started_at < 8:
                    continue
                if self._is_generating():
                    continue
                page.wait_for_timeout(2000)
                items = self.collect_response_images(response_before)
                found = [it for it in items if it["src"] not in before and it["src"] not in self._seen_urls][-1:]
                break
            hit = self._check_limit_error()
            if hit and time.time() - started_at > 12:
                raise RuntimeError(f"页面提示异常/额度问题（命中关键字：{hit}）")

        if not found:
            raise TimeoutError(f"等待出图超时（{timeout_ms / 1000:.0f}s）。可调大 config.json 的 gen_timeout_ms。")

        files = []
        for it in found:
            if cancel_event and cancel_event.is_set():
                raise RuntimeError("生成已取消")
            try:
                files.append(self._save_image(it["src"], it.get("w"), it.get("h")))
                self._seen_urls.add(it["src"])
            except Exception as exc:
                log.error("图片保存失败: %s -> %s", it["src"][:80], exc)
        if not files:
            raise RuntimeError("图片已生成但下载全部失败，请检查网络/代理。")

        # 记住这次生成所在的会话，下次复用（避免侧边栏被新会话刷屏）
        self._remember_session()

        return {
            "ok": True,
            "prompt": prompt,
            "ref_images": attach_info.get("files", []),
            "count": len(files),
            "images": files,
            "page": "images" if self.on_images_page else "chat",
            "session": {
                "mode": self.session_mode,
                "url": self._reuse_url or self.last_session_url,
                "reused": self.session_mode == "reuse" and bool(self._reuse_url),
            },
        }

    # ------------------------------------------------------------------ 保存

    def _save_image(self, url: str, w: Any = None, h: Any = None) -> dict:
        self._seq += 1
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        name = f"chatgpt-{stamp}-{self._seq:03d}.png"
        path = os.path.join(self.output_dir, name)

        if url.startswith("blob:"):
            data_url = self._page.evaluate(
                """async (u) => {
                    const r = await fetch(u);
                    const b = await r.blob();
                    return await new Promise(res => {
                        const fr = new FileReader();
                        fr.onload = () => res(fr.result);
                        fr.readAsDataURL(b);
                    });
                }""",
                url,
            )
            raw = base64.b64decode(data_url.split(",", 1)[1])
        else:
            resp = self._ctx.request.get(url, timeout=180000)
            if not resp.ok:
                raise RuntimeError(f"HTTP {resp.status} 下载失败")
            raw = resp.body()

        Path(path).write_bytes(raw)
        log.info("已保存 %s (%.2f MB)", name, len(raw) / 1048576)
        return {
            "file": name,
            "path": path,
            "url": url if not url.startswith("blob:") else "blob",
            "width": w,
            "height": h,
            "bytes": len(raw),
        }


class BotWorker:
    """把 Bot 锁在一个专属线程里，外部通过队列提交任务。"""

    def __init__(self, cfg: dict):
        self.cfg = cfg
        self._q: "queue.Queue[tuple]" = queue.Queue()
        self._thread = threading.Thread(target=self._loop, name="chatgpt-bot", daemon=True)
        self.bot: Optional[ChatGPTImageBot] = None
        self.busy = False
        self.current_prompt: Optional[str] = None
        self.started_at = time.time()
        self._stop_flag = threading.Event()
        self._thread.start()

    def _loop(self) -> None:
        self.bot = ChatGPTImageBot(self.cfg)
        while not self._stop_flag.is_set():
            try:
                fn, box = self._q.get(timeout=0.5)
            except queue.Empty:
                continue
            if fn is None:
                break
            box["event"].set()  # 表示已开始处理
            self.busy = True
            try:
                box["result"] = fn(self.bot)
                box["ok"] = True
            except Exception as exc:  # noqa: BLE001
                box["ok"] = False
                box["error"] = "ChatGPT 浏览器操作失败，请检查登录、网络和网页验证。"
                self.bot.last_error = box["error"]
                self.bot.state = "error"
                log.exception("任务执行失败")
            finally:
                self.busy = False
                self.current_prompt = None
                box["done"].set()

        if self.bot:
            self.bot.stop()

    def submit(self, fn: Callable[[ChatGPTImageBot], Any], wait_seconds: float) -> Any:
        box = {"event": threading.Event(), "done": threading.Event()}
        self._q.put((fn, box))
        if not box["done"].wait(wait_seconds):
            raise TimeoutError(f"任务在 {wait_seconds:.0f}s 内未完成（队列繁忙或生成过慢）")
        if not box["ok"]:
            raise RuntimeError(box["error"])
        return box["result"]

    def status(self) -> dict:
        bot = self.bot
        info = {
            "process_up": True,
            "busy": self.busy,
            "queue": self._q.qsize(),
            "current_prompt": self.current_prompt,
            "uptime_sec": round(time.time() - self.started_at, 1),
        }
        if bot:
            info.update(
                {
                    "bot_state": bot.state,
                    "browser_running": bot._ctx is not None,
                    "last_error": bot.last_error,
                    "output_dir": bot.output_dir,
                    "upload_ok": bot.upload_ok,
                    "last_upload_error": bot.last_upload_error,
                }
            )
        return info
