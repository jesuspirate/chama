import type { ReplayNote } from '../../escrow-engine/types.js';
import { useT } from '../../i18n/index.js';
import { T } from '../theme.js';
export function ReplayNotes({ notes }: { notes?: ReplayNote[] }) {
  const { t } = useT();
  // Both parties auto-publish RESOLVE the moment two votes land, so a healthy
  // settled trade routinely replays with one redundant RESOLVE skipped. Showing
  // "History rebuilt with 1 ignored events · INVALID_STATE" for that made every
  // finished trade look damaged (Jet, 2026-09-21 — it was on every trade in the
  // Live queue). Only an UNEXPECTED skip is worth a disclosure.
  const notable = notes?.filter(note => !note.benign) ?? [];
  if (!notable.length) return null;
  return <details style={{color:T.muted, marginTop:10}}>
    <summary>{t('trade.replayNotes',{count:notable.length})}</summary>
    {notable.map(note => <div key={note.eventId} style={{overflowWrap:'anywhere'}}>
      {note.kind} · {note.code} · {note.eventId}
    </div>)}
  </details>;
}
