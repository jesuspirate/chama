import { Buffer } from "buffer";
import { dataToFrames } from "qrloop";

/**
 * Match Fedi's ecash QR framing exactly.
 *
 * Fedimint v2 notes are `fedimint`-prefixed base32 text and must be framed as
 * UTF-8. Legacy v1 notes are base64 and Fedi frames their decoded bytes. If a
 * v2 note is accidentally base64-decoded it is silently corrupted because its
 * alphabet is also valid base64.
 */
export function ecashToQrFrameData(ecash: string): Buffer {
  return ecash.startsWith("fedimint")
    ? Buffer.from(ecash, "utf8")
    : Buffer.from(ecash, "base64");
}

/** Frames consumed by Fedi's qrloop-aware scanner. */
export function ecashToQrFrames(ecash: string): string[] {
  if (!ecash) return [];
  return dataToFrames(ecashToQrFrameData(ecash));
}
