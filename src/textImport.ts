export function decodeImportedText(bytes: Uint8Array, filename = ''): { text: string; encoding: string } {
  const starts = (...mark: number[]) => mark.every((value, index) => bytes[index] === value);
  let encoding = '';
  let offset = 0;
  if (starts(0xef, 0xbb, 0xbf)) { encoding = 'utf-8'; offset = 3; }
  else if (starts(0xff, 0xfe)) { encoding = 'utf-16le'; offset = 2; }
  else if (starts(0xfe, 0xff)) { encoding = 'utf-16be'; offset = 2; }
  else if (/\.html?$/i.test(filename)) {
    const head = new TextDecoder('windows-1252').decode(bytes.subarray(0, 4096));
    encoding = head.match(/<meta\b[^>]*charset\s*=\s*["']?([\w-]+)/i)?.[1] || '';
  }
  const tryDecode = (label: string) => new TextDecoder(label, { fatal: true }).decode(bytes.subarray(offset));
  if (encoding) {
    try { return { text: tryDecode(encoding), encoding }; } catch { /* 文件声明的编码与实际字节不符，继续探测。 */ }
  }
  try { return { text: tryDecode('utf-8'), encoding: 'utf-8' }; }
  catch {
    try { return { text: tryDecode('gb18030'), encoding: 'gb18030' }; }
    catch { throw new Error('无法识别文件编码。请将原文另存为 UTF-8 或 GB18030 后重试。'); }
  }
}
