/** Small, non-HTML grammar. Text always renders as text; no remote embeds. */
export const MAX_LISTING_BODY = 8000;
export type ListingInline = { type: 'text' | 'strong' | 'em'; text: string }
  | { type: 'link'; text: string; href: string };
export type ListingBlock = { type: 'paragraph' | 'item'; children: ListingInline[] };
export function safeListingHref(value: string): string | null {
  if (/[\s\u0000-\u001f\u007f<>]/.test(value)) return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
export function parseListingBody(body: string): ListingBlock[] {
  return body.slice(0, MAX_LISTING_BODY).replace(/\r\n?/g, '\n').split('\n').map(line => {
    const item = /^\s*(?:[-*]|\d+\.) /.test(line);
    if (item) line = line.replace(/^\s*(?:[-*]|\d+\.) /, '');
    const children: ListingInline[] = [];
    // No recursion: nested markup stays literal. Image syntax stays literal too.
    const tokens = /(?<!!)\[([^\[\]\n]+)\]\(([^()\n]+)\)|\*\*([^*\n]+)\*\*|(?<!\*)\*([^*\n]+)\*(?!\*)/g;
    let cursor = 0;
    for (const m of line.matchAll(tokens)) {
      if (m.index! > cursor) children.push({ type: 'text', text: line.slice(cursor, m.index) });
      const href = m[2] && safeListingHref(m[2]);
      children.push(m[1] && href ? { type: 'link', text: m[1], href }
        : m[3] ? { type: 'strong', text: m[3] }
        : m[4] ? { type: 'em', text: m[4] } : { type: 'text', text: m[0] });
      cursor = m.index! + m[0].length;
    }
    if (cursor < line.length) children.push({ type: 'text', text: line.slice(cursor) });
    return { type: item ? 'item' : 'paragraph', children };
  });
}
