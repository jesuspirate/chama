import { fetchWakeEvents, replayWake, selectWakeNotifications, type WakeSnapshot } from './wake-replay.js';
declare const ChamaWake: { input(): string; finish(result: string): void };
(async () => {
  try {
    const input = JSON.parse(ChamaWake.input()) as { snapshot: WakeSnapshot; nsec: string; lastWake: number; fired: string[] };
    const old = replayWake(input.snapshot.events, input.snapshot.pubkey, input.nsec);
    const fresh = await fetchWakeEvents(input.snapshot);
    const next = replayWake([...input.snapshot.events, ...fresh], input.snapshot.pubkey, input.nsec);
    const notifications = selectWakeNotifications(next.values(), old, input.snapshot, input.lastWake, input.fired);
    ChamaWake.finish(JSON.stringify({ notifications }));
  } catch { ChamaWake.finish('{"failed":true}'); }
})();
