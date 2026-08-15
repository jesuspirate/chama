import { Buffer } from "buffer";
import {
  areFramesComplete,
  framesToData,
  parseFramesReducer,
  type State as QrFrameState,
} from "qrloop";
import { ecashToQrFrameData, ecashToQrFrames } from "./ecash-qr.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function reassemble(frames: string[]): Buffer {
  let state: QrFrameState | null = null;
  for (const frame of frames) state = parseFramesReducer(state, frame);
  assert(state && areFramesComplete(state), "qrloop frames did not complete");
  return framesToData(state);
}

const legacyBytes = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256));
const legacyNote = legacyBytes.toString("base64");
const legacyFrames = ecashToQrFrames(legacyNote);
assert(legacyFrames.length > 1, "large legacy note should use multiple frames");
assert(
  reassemble(legacyFrames).equals(legacyBytes),
  "legacy base64 note did not round-trip through Fedi-compatible frames",
);

const v2Note = `fedimint${"a1b2c3d4e5f6g7h8i9j0klmnopqrstuv0".repeat(80)}`;
const v2Frames = ecashToQrFrames(v2Note);
assert(v2Frames.length > 1, "large v2 note should use multiple frames");
assert(
  reassemble(v2Frames).equals(ecashToQrFrameData(v2Note)),
  "v2 text note did not round-trip through Fedi-compatible frames",
);
assert(
  reassemble(v2Frames).toString("utf8") === v2Note,
  "v2 note text changed during QR framing",
);

assert(ecashToQrFrames("").length === 0, "empty ecash should not create frames");

console.log("ecash QR frame tests passed");
