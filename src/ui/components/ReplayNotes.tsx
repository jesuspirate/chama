import type { ReplayNote } from '../../escrow-engine/types.js';
import { useT } from '../../i18n/index.js';
import { T } from '../theme.js';
export function ReplayNotes({ notes }: { notes?: ReplayNote[] }) {
  const { t } = useT();
  if (!notes?.length) return null;
  return <details style={{color:T.muted, marginTop:10}}>
    <summary>{t('trade.replayNotes',{count:notes.length})}</summary>
    {notes.map(note => <div key={note.eventId} style={{overflowWrap:'anywhere'}}>
      {note.kind} · {note.code} · {note.eventId}
    </div>)}
  </details>;
}
