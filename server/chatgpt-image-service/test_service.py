"""仅模拟浏览器工作线程，不使用用户账号。"""
import importlib.util
import os
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
from pathlib import Path

class Worker:
    busy = False
    def __init__(self, cfg): self.cfg = cfg
    def submit(self, task, timeout): return task(self.bot)

class ServiceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        os.environ.update(CARLSTAGE_CHATGPT_DATA=cls.temp.name, CARLSTAGE_CHATGPT_TOKEN='test-token', CARLSTAGE_CHATGPT_PORT='8317')
        sys.modules['chatgpt_bot'] = types.SimpleNamespace(BotWorker=Worker, COMPOSER_SELECTORS=[], LOGIN_HINTS=[])
        spec = importlib.util.spec_from_file_location('service', Path(__file__).with_name('service.py'))
        cls.service = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.service)

    @classmethod
    def tearDownClass(cls): cls.temp.cleanup()

    def setUp(self):
        self.s = self.service
        self.s.worker.busy = False
        self.s.cancel_event.clear()

    def test_eight_references_in_order_and_cleanup(self):
        refs = []
        for i in range(8):
            path = self.s.UPLOADS / f'{i}.png'
            path.write_bytes(b'image')
            refs.append(str(path))
        def generate(prompt, **options):
            self.assertEqual(options['ref_images'], refs)
            self.assertEqual(options['timeout_ms'], 240000)
            return {'images': [{'file': 'new.png', 'url': 'private'}]}
        self.s.worker.bot = types.SimpleNamespace(generate=generate)
        result = self.s.generate(self.s.GenerateRequest(prompt='test', ref_images=refs))
        self.assertEqual(result, {'ok': True, 'images': [{'file': 'new.png'}]})
        self.assertTrue(all(not Path(path).exists() for path in refs))
        with self.assertRaises(ValueError): self.s.GenerateRequest(prompt='test', ref_images=['ref'] * 9)

    def test_no_references_and_login_mutex(self):
        self.s.worker.bot = types.SimpleNamespace(generate=lambda prompt, **options: {'images': [{'file': 'new.png'}]})
        self.assertTrue(self.s.generate(self.s.GenerateRequest(prompt='test'))['ok'])
        self.s.gate.acquire()
        try:
            with self.assertRaises(self.s.HTTPException): self.s.generate(self.s.GenerateRequest(prompt='test'))
            with self.assertRaises(self.s.HTTPException): self.s.login()
        finally: self.s.gate.release()

    def test_manual_login_releases_browser_before_opening_edge(self):
        events = []
        self.s.worker.bot = types.SimpleNamespace(stop=lambda: events.append('stop'))
        browser = types.SimpleNamespace(wait=lambda: events.append('closed'))
        def open_browser(profile, proxy):
            events.append('open')
            self.assertEqual(profile, self.s.CFG['profile_dir'])
            return browser
        self.s.gate.acquire()
        with patch.object(self.s, 'open_login_browser', open_browser): self.s.login_job()
        self.assertEqual(events, ['stop', 'open', 'closed'])
        self.assertFalse(self.s.gate.locked())

    def test_cancel_discards_output(self):
        output = self.s.OUTPUT / 'cancelled.png'
        def generate(prompt, **options):
            output.write_bytes(b'image')
            self.s.cancel()
            return {'images': [{'file': output.name}]}
        self.s.worker.bot = types.SimpleNamespace(generate=generate)
        with self.assertRaises(self.s.HTTPException): self.s.generate(self.s.GenerateRequest(prompt='test'))
        self.assertFalse(output.exists())

    def test_timeout_and_download_errors_are_safe(self):
        for error in [TimeoutError('private prompt'), RuntimeError('private path and credentials')]:
            def generate(prompt, **options): raise error
            self.s.worker.bot = types.SimpleNamespace(generate=generate)
            with self.assertRaises(self.s.HTTPException) as caught: self.s.generate(self.s.GenerateRequest(prompt='test'))
            self.assertNotIn('private', caught.exception.detail)
            self.assertFalse(self.s.gate.locked())

    def test_reused_conversation_old_images_are_excluded(self):
        spec = importlib.util.spec_from_file_location('original_bot', Path(__file__).with_name('chatgpt_bot.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        bot = module.ChatGPTImageBot({'profile_dir': self.temp.name, 'output_dir': self.temp.name, 'session_persist_path': str(Path(self.temp.name) / 'session.json')})
        state = {'clock': 0, 'history': 'first-history', 'submitted': False}
        def wait(ms): state['clock'] += ms / 1000
        composer = types.SimpleNamespace(click=lambda **kwargs: None)
        def send(): state['submitted'] = True
        submit = types.SimpleNamespace(is_enabled=lambda: True, click=send)
        page = types.SimpleNamespace(wait_for_timeout=wait, keyboard=types.SimpleNamespace(press=lambda key: None, insert_text=lambda text: None))
        bot.start = lambda: None
        bot._ensure_page = lambda: page
        bot.on_images_page = True
        bot._first_visible = lambda selectors, timeout: submit if selectors is module.SEND_SELECTORS else composer
        bot._maybe_reuse_session = lambda: state.update(history='reused-history')
        bot.collect_images = lambda: [{'src': state['history']}] + ([{'src': 'new-result'}] if state['submitted'] else [])
        bot.response_state = lambda: {'key': 'previous-user', 'count': 1}
        bot.collect_response_images = lambda before: [{'src': 'new-result'}] if state['submitted'] else []
        bot._is_generating = lambda: False
        bot._check_limit_error = lambda: None
        bot._remember_session = lambda: None
        saved = []
        def save(src, *args):
            saved.append(src)
            return {'file': 'new.png'}
        bot._save_image = save
        with patch.object(module.time, 'time', lambda: state['clock']): bot.generate('test')
        self.assertEqual(saved, ['new-result'])

    def test_generated_image_same_size_as_reference_is_kept(self):
        spec = importlib.util.spec_from_file_location('collect_bot', Path(__file__).with_name('chatgpt_bot.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        bot = module.ChatGPTImageBot({'profile_dir': self.temp.name, 'output_dir': self.temp.name, 'session_persist_path': str(Path(self.temp.name) / 'session.json')})
        bot._ref_fingerprints = {(1536, 1024)}
        image = {'src': 'new-result', 'w': 1536, 'h': 1024}
        bot._page = types.SimpleNamespace(evaluate=lambda script: [image])
        self.assertEqual(bot.collect_images(), [image])

if __name__ == '__main__': unittest.main()
