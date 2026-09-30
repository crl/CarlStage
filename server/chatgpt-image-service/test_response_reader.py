"""使用系统 Edge 验证图片页面的回读规则，不访问账号或发起生成。"""
import unittest
from playwright.sync_api import sync_playwright
from chatgpt_bot import MESSAGE_STATE_JS, LATEST_RESPONSE_JS


class ResponseReaderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(channel='msedge', headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self): self.page = self.browser.new_page()
    def tearDown(self): self.page.close()

    def render(self, html):
        self.page.set_content(html)
        self.page.evaluate("""() => document.querySelectorAll('img').forEach(img => {
            Object.defineProperties(img, {complete:{value:true},naturalWidth:{value:1536},naturalHeight:{value:1024}});
        })""")

    def gallery(self, turn, source):
        return f'<div data-turn-key="{turn}"><div data-chatgpt-search-message-ids="message"><div data-testid="generated-image-gallery"><button data-testid="generated-image-preview"><img src="{source}"></button></div></div></div>'

    def test_images_page_without_message_roles_reads_newest_gallery(self):
        self.render(self.gallery('old', 'https://example.invalid/old.png'))
        before = self.page.evaluate(MESSAGE_STATE_JS)
        self.render(self.gallery('old', 'https://example.invalid/old.png') + '<img src="https://example.invalid/reference.png">' + self.gallery('new', 'https://example.invalid/new.png'))
        images = self.page.evaluate(LATEST_RESPONSE_JS, before)
        self.assertEqual([item['src'] for item in images], ['https://example.invalid/new.png'])

    def test_old_gallery_url_change_is_not_a_new_result(self):
        self.render(self.gallery('old', 'https://example.invalid/old.png'))
        before = self.page.evaluate(MESSAGE_STATE_JS)
        self.render(self.gallery('old', 'https://example.invalid/refreshed.png'))
        self.assertEqual(self.page.evaluate(LATEST_RESPONSE_JS, before), [])

    def test_new_turn_is_detected_when_visible_gallery_count_stays_equal(self):
        self.render(self.gallery('old', 'https://example.invalid/old.png'))
        before = self.page.evaluate(MESSAGE_STATE_JS)
        self.render(self.gallery('new', 'https://example.invalid/new.png'))
        self.assertEqual(len(self.page.evaluate(LATEST_RESPONSE_JS, before)), 1)

    def test_incomplete_new_image_waits_instead_of_using_old_image(self):
        self.render(self.gallery('old', 'https://example.invalid/old.png'))
        before = self.page.evaluate(MESSAGE_STATE_JS)
        self.render(self.gallery('old', 'https://example.invalid/old.png') + '<div data-turn-key="new"><div data-testid="generated-image-gallery"></div></div>')
        self.assertEqual(self.page.evaluate(LATEST_RESPONSE_JS, before), [])

    def test_regular_chat_result_can_be_a_sibling_of_assistant_text(self):
        self.render('<article data-testid="conversation-turn-0"><div data-message-author-role="user" data-message-id="old"></div></article>')
        before = self.page.evaluate(MESSAGE_STATE_JS)
        self.render('<article data-testid="conversation-turn-1"><div data-message-author-role="user" data-message-id="new"></div></article><article data-testid="conversation-turn-2"><div data-message-author-role="assistant"></div><img src="https://example.invalid/new.png"></article>')
        self.assertEqual(len(self.page.evaluate(LATEST_RESPONSE_JS, before)), 1)


if __name__ == '__main__': unittest.main()
