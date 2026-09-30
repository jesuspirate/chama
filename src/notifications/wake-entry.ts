import { runWakeJob, type WakeInput } from './wake-replay.js';
declare const ChamaWake: { input(): string; finish(result: string): void };
(async () => {
  const started = Date.now();
  try {
    const input = JSON.parse(ChamaWake.input()) as WakeInput;
    const result = await runWakeJob(input);
    ChamaWake.finish(JSON.stringify({ ...result, elapsedMs: Date.now() - started }));
  } catch (error) {
    // The replay helpers use content-free messages; never log plaintext or keys.
    const reason = error instanceof Error && /^(Identity changed|No local decryption key|No relay replied|Incomplete trade: [A-Z_]+)$/.test(error.message)
      ? error.message : 'Replay or decryption error';
    ChamaWake.finish(JSON.stringify({ failed: true, result: reason, elapsedMs: Date.now() - started }));
  }
})();
