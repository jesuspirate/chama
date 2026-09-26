import { TAGS } from "./types.js";

/** Outer Nostr metadata only. Vite replaces the version in shipped builds. */
export function chamaClientTag(version: string = typeof __APP_VERSION__ === "undefined" ? "dev" : __APP_VERSION__): string[] {
  return [TAGS.CLIENT, "chama", version];
}

export function isChamaClientTagKind(kind: number): boolean {
  return (kind >= 38100 && kind <= 38116) || kind === 38135;
}
