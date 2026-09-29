const TOAST_EVENT = 'carlstage:toast';

function announce(message: string) {
  window.dispatchEvent(new CustomEvent(TOAST_EVENT, { detail: message }));
}

export async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    announce('已复制');
  } catch {
    announce('复制失败，请检查浏览器剪贴板权限');
  }
}

export async function copyImage(png: Blob) {
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    announce('已复制');
  } catch {
    announce('复制失败，请检查浏览器剪贴板权限');
  }
}
