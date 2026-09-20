import type { UnsignedEvent } from "./escrow-client.js";

export const MAX_SIGNED_EVENT_FRAME_BYTES = 256 * 1024;

const SIGNED_EVENT_PLACEHOLDER = {
  id: "0".repeat(64),
  pubkey: "0".repeat(64),
  sig: "0".repeat(128),
};

export function signedEventFrameBytes(unsigned: UnsignedEvent): number {
  const projected = { ...unsigned, ...SIGNED_EVENT_PLACEHOLDER };
  return new TextEncoder().encode(JSON.stringify(["EVENT", projected])).byteLength;
}

export function assertSignedEventFitsWire(unsigned: UnsignedEvent): void {
  const bytes = signedEventFrameBytes(unsigned);
  if (bytes > MAX_SIGNED_EVENT_FRAME_BYTES) {
    throw new Error(
      `This event is ${bytes.toLocaleString()} bytes, above Chama's ${MAX_SIGNED_EVENT_FRAME_BYTES.toLocaleString()}-byte relay wire limit. Nothing was signed or published.`,
    );
  }
}
