import { fetchWakeEvents, replayWake, wakeNotification, type WakeSnapshot } from './wake-replay.js';
declare const ChamaWake: { input(): string; finish(result: string): void };
(async () => {
  try {
    const input = JSON.parse(ChamaWake.input()) as { snapshot: WakeSnapshot; nsec: string; lastWake: number; fired: string[] };
    const old = replayWake(input.snapshot.events, input.snapshot.pubkey, input.nsec);
    const fresh = await fetchWakeEvents(input.snapshot);
    const next = replayWake([...input.snapshot.events, ...fresh], input.snapshot.pubkey, input.nsec);
    const notifications = [...next.values()].flatMap(state => {
      if (!state.eventChain.some(e => e.timestamp * 1000 > input.lastWake)) return [];
      const note = wakeNotification(state, old.get(state.id) ?? null, input.snapshot.pubkey, input.snapshot.names);
      return note && !input.fired.includes(note.tag) ? [note] : [];
    });
    ChamaWake.finish(JSON.stringify({ notifications }));
  } catch { ChamaWake.finish('{"failed":true}'); }
})();
