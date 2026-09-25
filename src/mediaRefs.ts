export function imageKey(source: string): string {
  // Keep data URLs out of deletion metadata while preserving stable identity.
  let a = 2166136261; let b = 0x9e3779b9;
  for (let i = 0; i < source.length; i++) {
    const code = source.charCodeAt(i);
    a = Math.imul(a ^ code, 16777619);
    b = Math.imul(b ^ code, 2246822519);
  }
  return `${source.length}:${(a >>> 0).toString(36)}:${(b >>> 0).toString(36)}`;
}

export function ownedMediaUrl(source: string | undefined, owner: string): boolean {
  return !!source && /^[a-zA-Z0-9_-]{3,80}$/.test(owner) && source.startsWith(`/api/media/${owner}/`) && /^\/api\/media\/[a-zA-Z0-9_-]{3,80}\/[a-f0-9-]{36}\.(?:png|jpg|jpeg|webp|mp4|webm|mov)$/.test(source);
}
