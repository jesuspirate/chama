import { getScopedStorageItem, setScopedStorageItem } from '../storage/user-scope.js';
export const MAX_AVATAR_BYTES = 48 * 1024;
export interface Avatar { animated: string; still: string }
/** Embedded raster only: no SVG, external fetch, cookies or tracking pixels. */
export function safeAvatarSource(source: unknown): source is string {
  if (typeof source !== 'string' || source.length > MAX_AVATAR_BYTES * 4 / 3 + 128) return false;
  return /^data:image\/(?:gif|png|webp|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(source);
}
/** Do not trust a remote profile's claim that its fallback is a still image. */
function staticPng(source: string): boolean {
  if (!source.startsWith('data:image/png;base64,')) return false;
  try {
    const bytes = Uint8Array.from(atob(source.slice(source.indexOf(',') + 1)), c => c.charCodeAt(0));
    if ([137,80,78,71,13,10,26,10].some((b,i) => bytes[i] !== b)) return false;
    const view = new DataView(bytes.buffer);
    let offset = 8, header = false, pixels = false;
    while (offset + 12 <= bytes.length) {
      const length = view.getUint32(offset);
      if (length > bytes.length - offset - 12) return false;
      const type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
      if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') return false;
      if (!header && type !== 'IHDR') return false;
      if (type === 'IHDR') {
        if (header || length !== 13) return false;
        const width = view.getUint32(offset + 8), height = view.getUint32(offset + 12);
        if (!width || !height || width > 2048 || height > 2048) return false;
        header = true;
      }
      if (type === 'IDAT') pixels = true;
      if (type === 'IEND') return pixels && length === 0 && offset + 12 === bytes.length;
      offset += length + 12;
    }
  } catch { /* malformed raster */ }
  return false;
}
export function parseAvatar(value: unknown): Avatar | null {
  const a = value as Avatar | null;
  return a && safeAvatarSource(a.animated) && safeAvatarSource(a.still) && staticPng(a.still)
    ? { animated: a.animated, still: a.still } : null;
}
export function readAvatar(pubkey: string): Avatar | null {
  try { return parseAvatar(JSON.parse(getScopedStorageItem(`chama_avatar_${pubkey.toLowerCase()}`) ?? 'null')); }
  catch { return null; }
}
export function saveAvatar(pubkey: string, avatar: Avatar): void {
  const safe = parseAvatar(avatar);
  if (!safe) throw new Error('Invalid avatar');
  setScopedStorageItem(`chama_avatar_${pubkey.toLowerCase()}`, JSON.stringify(safe));
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('chama-avatar'));
}
export async function avatarFromFile(file: File): Promise<Avatar> {
  if (file.size > MAX_AVATAR_BYTES || !['image/gif','image/png','image/webp','image/jpeg'].includes(file.type)) throw new Error('avatar-size-or-format');
  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width > 2048 || bitmap.height > 2048) throw new Error('avatar-dimensions');
    const canvas = document.createElement('canvas'); canvas.width = 96; canvas.height = 96;
    canvas.getContext('2d')!.drawImage(bitmap,0,0,96,96);
    const animated = await new Promise<string>((resolve,reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file);
    });
    const avatar = {animated, still:canvas.toDataURL('image/png')};
    if (!parseAvatar(avatar)) throw new Error('avatar-size-or-format');
    return avatar;
  } finally { bitmap.close(); }
}
