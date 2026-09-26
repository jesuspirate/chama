import { getScopedStorageItem, setScopedStorageItem } from '../storage/user-scope.js';
export const MAX_AVATAR_BYTES = 48 * 1024; // Legacy received profiles.
export const MAX_AVATAR_UPLOAD_BYTES = 40 * 1024;
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
/** A fallback must be a static raster even when supplied by another user. */
function staticRaster(source: string): boolean {
  if (source.startsWith('data:image/png;')) return staticPng(source);
  try {
    const bytes = Uint8Array.from(atob(source.slice(source.indexOf(',') + 1)), c => c.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    const dimensions = (w: number, h: number) => w > 0 && h > 0 && w <= 2048 && h <= 2048;
    if (source.startsWith('data:image/webp;')) {
      const text = (start: number, count: number) => String.fromCharCode(...bytes.slice(start, start + count));
      if (text(0, 4) !== 'RIFF' || text(8, 4) !== 'WEBP' || view.getUint32(4, true) + 8 !== bytes.length) return false;
      let offset = 12, pixels = false;
      while (offset + 8 <= bytes.length) {
        const type = text(offset, 4), size = view.getUint32(offset + 4, true), data = offset + 8;
        if (size > bytes.length - data || type === 'ANIM' || type === 'ANMF') return false;
        if (type === 'VP8X') {
          if (size !== 10 || (bytes[data] & 2)) return false;
          const u24 = (i: number) => bytes[i] + (bytes[i+1] << 8) + (bytes[i+2] << 16);
          if (!dimensions(u24(data+4)+1, u24(data+7)+1)) return false;
        }
        if (type === 'VP8 ') {
          if (pixels || size < 10 || text(data+3, 3) !== '\x9d\x01\x2a'
            || !dimensions(view.getUint16(data+6,true) & 0x3fff, view.getUint16(data+8,true) & 0x3fff)) return false;
          pixels = true;
        }
        if (type === 'VP8L') {
          if (pixels || size < 5 || bytes[data] !== 0x2f) return false;
          const bits = view.getUint32(data+1,true);
          if (!dimensions((bits & 0x3fff)+1, ((bits >>> 14) & 0x3fff)+1)) return false;
          pixels = true;
        }
        offset = data + size + (size & 1);
      }
      return pixels && offset === bytes.length;
    }
    if (source.startsWith('data:image/jpeg;')) {
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) return false;
      let offset = 2, header = false;
      while (offset + 4 <= bytes.length) {
        if (bytes[offset++] !== 0xff) return false;
        while (bytes[offset] === 0xff) offset++;
        const marker = bytes[offset++], size = view.getUint16(offset);
        if (size < 2 || size > bytes.length - offset) return false;
        if ([0xc0, 0xc1, 0xc2].includes(marker)) {
          if (size < 8 || !dimensions(view.getUint16(offset+5), view.getUint16(offset+3))) return false;
          header = true;
        }
        if (marker === 0xda) return header;
        offset += size;
      }
    }
  } catch { /* malformed raster */ }
  return false;
}
export function parseAvatar(value: unknown): Avatar | null {
  const a = value as Avatar | null;
  return a && safeAvatarSource(a.animated) && safeAvatarSource(a.still) && staticRaster(a.still)
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
/** Crop and compress before any profile storage or relay publication. */
export async function avatarFromFile(file: File): Promise<Avatar> {
  if (!['image/gif','image/png','image/webp','image/jpeg'].includes(file.type)) throw new Error('avatar-format');
  const bitmap = await createImageBitmap(file);
  try {
    if (!bitmap.width || !bitmap.height) throw new Error('avatar-dimensions');
    const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 256;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('avatar-canvas');
    const side = Math.min(bitmap.width, bitmap.height);
    context.drawImage(bitmap, (bitmap.width-side)/2, (bitmap.height-side)/2, side, side, 0, 0, 256, 256);
    for (const format of ['image/webp', 'image/jpeg']) {
      if (format === 'image/jpeg') {
        // JPEG cannot preserve alpha. Composite over white rather than black.
        context.globalCompositeOperation = 'destination-over';
        context.fillStyle = '#fff'; context.fillRect(0, 0, 256, 256);
        context.globalCompositeOperation = 'source-over';
      }
      for (let quality = 82; quality >= 12; quality -= 10) {
        const source = canvas.toDataURL(format, quality / 100);
        if (!source.startsWith(`data:${format};base64,`)) break; // WebP unsupported.
        const encoded = source.slice(source.indexOf(',') + 1);
        const bytes = encoded.length * 3 / 4 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
        if (bytes > MAX_AVATAR_UPLOAD_BYTES) continue;
        const avatar = { animated: source, still: source };
        if (parseAvatar(avatar)) return avatar;
      }
    }
    throw new Error('avatar-compression');
  } finally { bitmap.close(); }
}
