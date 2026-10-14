// Lock invoice, Step 2b (Jet, 6.4.25-rc.7 timing): the federation takes ~5.4 s
// to make the funding invoice, and the Lock hold is 1.2 s. So the app asks for
// the invoice when the hold BEGINS, and the funding sheet adopts it if the
// hold completes.
//
// Why this is safe: an invoice can only be paid by someone who has it. A
// prepared invoice never leaves the device until the funding flow adopts it,
// and the flow adopts it at exactly the point where it would otherwise have
// created its own (after the #37 settle, the intent stash and a fresh
// preflight), then runs the same seat and receive-watch checks before it is
// shown or handed to NWC. Until then nobody can pay it, so no sats can move.
// It is journalled like any funding invoice (recorded before the request,
// marked abandoned when not adopted), so even an impossible payment to an
// abandoned one stays attributable to the trade.
//
// Adoption is exact: the same trade, federation, amount, description, payment
// details, order and seat deadline, still young, and expiring no later than a
// fresh invoice would. Anything else, or a failed preparation, falls back to
// creating a fresh invoice exactly as before.

import type { FundingInvoiceJournal } from "./abandoned-invoices.js";

/** How long an unadopted prepared invoice is kept before it is abandoned. */
export const PREPARED_INVOICE_MAX_AGE_MS = 60_000;
/** Adopted only if it expires no more than this much earlier than a fresh one. */
export const PREPARED_EXPIRY_SLACK_SECONDS = 90;

export interface PreparedInvoiceTerms {
  escrowId: string;
  federationId: string;
  amountMsats: number;
  description: string;
  savedHandleId?: string;
  paymentDetailsInChat?: boolean;
  /** JSON of the selected order items ("" for none). */
  itemsKey: string;
  seatDeadline?: number;
}

type ReceiveListener<S> = (state: S) => void;
type GatewayListener<G> = (gateway: G) => void;

/** Buffers receive-watch and gateway events until the flow attaches, then
 *  replays them in order and forwards the rest. */
export class EventRelay<S, G> {
  private buffered: Array<{ kind: "state"; value: S } | { kind: "gateway"; value: G }> = [];
  private onState?: ReceiveListener<S>;
  private onGateway?: GatewayListener<G>;
  private attached = false;
  private closed = false;
  state = (value: S): void => {
    if (this.closed) return;
    if (this.attached) this.onState?.(value); else this.buffered.push({ kind: "state", value });
  };
  gateway = (value: G): void => {
    if (this.closed) return;
    if (this.attached) this.onGateway?.(value); else this.buffered.push({ kind: "gateway", value });
  };
  attach(onState?: ReceiveListener<S>, onGateway?: GatewayListener<G>): void {
    if (this.attached || this.closed) return;
    this.onState = onState; this.onGateway = onGateway; this.attached = true;
    const pending = this.buffered; this.buffered = [];
    // Gateway first: the flow notes the operation id before receive states.
    for (const e of pending) if (e.kind === "gateway") onGateway?.(e.value);
    for (const e of pending) if (e.kind === "state") onState?.(e.value);
  }
  /** Not adopted: stop forwarding (events are dropped). */
  close(): void { if (!this.attached) { this.closed = true; this.buffered = []; } }
}

interface Prepared<S, G> {
  terms: PreparedInvoiceTerms;
  startedAt: number;
  /** Absolute unix seconds the invoice was asked to expire at. */
  expiresAtSec: number;
  invoice: Promise<string>;
  relay: EventRelay<S, G>;
  journal: FundingInvoiceJournal;
  timer: ReturnType<typeof setTimeout> | null;
}

let current: Prepared<any, any> | null = null;
let clock = () => Date.now();

export function sameTerms(a: PreparedInvoiceTerms, b: PreparedInvoiceTerms): boolean {
  return a.escrowId === b.escrowId && a.federationId === b.federationId
    && a.amountMsats === b.amountMsats && a.description === b.description
    && (a.savedHandleId ?? "") === (b.savedHandleId ?? "")
    && !!a.paymentDetailsInChat === !!b.paymentDetailsInChat
    && a.itemsKey === b.itemsKey && a.seatDeadline === b.seatDeadline;
}

export function isPreparing(escrowId?: string): boolean {
  return !!current && (escrowId === undefined || current.terms.escrowId === escrowId);
}

/** Start one prepared invoice (press-down). Replaces nothing: a second call
 *  while one is held for the same terms is ignored, for other terms it
 *  abandons the old one first. `create` must journal-record before showing
 *  anything; it receives the relay's listeners. */
export function prepareInvoice<S, G>(input: {
  terms: PreparedInvoiceTerms;
  expirySeconds: number;
  journal: FundingInvoiceJournal;
  create: (onState: (s: S) => void, onGateway: (g: G) => void) => Promise<string>;
}): void {
  if (current && sameTerms(current.terms, input.terms) && clock() - current.startedAt < PREPARED_INVOICE_MAX_AGE_MS) return;
  abandonPreparedInvoice();
  const relay = new EventRelay<S, G>();
  const startedAt = clock();
  const invoice = input.create(relay.state, relay.gateway).then(bolt11 => { input.journal.record(bolt11); return bolt11; });
  const entry: Prepared<S, G> = {
    terms: input.terms, startedAt, expiresAtSec: Math.floor(startedAt / 1000) + input.expirySeconds,
    invoice, relay, journal: input.journal, timer: null,
  };
  // A failed preparation simply leaves nothing to adopt.
  invoice.catch(() => { if (current === entry) abandonPreparedInvoice(); });
  entry.timer = setTimeout(() => { if (current === entry) abandonPreparedInvoice(); }, PREPARED_INVOICE_MAX_AGE_MS);
  current = entry;
}

/** The hold was lifted, the sheet took another path, or it aged out: the
 *  invoice was never shown, so it is marked abandoned and forgotten. */
export function abandonPreparedInvoice(): void {
  const entry = current;
  if (!entry) return;
  current = null;
  if (entry.timer) clearTimeout(entry.timer);
  entry.relay.close();
  try { entry.journal.stop(false); }
  catch (error) { console.error("Prepared invoice could not be marked abandoned; its watching record stays", error); }
}

/** The funding flow is about to create its invoice. Returns the prepared one
 *  when every term matches and it would expire no later than (and not much
 *  earlier than) a fresh one asked now for `expirySeconds`; attaches the
 *  flow's listeners. Otherwise abandons any prepared invoice and returns
 *  null, and the flow creates a fresh one. */
export async function adoptPreparedInvoice<S, G>(
  terms: PreparedInvoiceTerms,
  expirySeconds: number,
  onState?: (s: S) => void,
  onGateway?: (g: G) => void,
): Promise<string | null> {
  const entry = current as Prepared<S, G> | null;
  if (!entry) return null;
  const now = clock();
  const freshExpiresAtSec = Math.floor(now / 1000) + expirySeconds;
  const fits = sameTerms(entry.terms, terms)
    && now - entry.startedAt < PREPARED_INVOICE_MAX_AGE_MS
    && entry.expiresAtSec <= freshExpiresAtSec + 5
    && entry.expiresAtSec >= freshExpiresAtSec - PREPARED_EXPIRY_SLACK_SECONDS;
  if (!fits) { abandonPreparedInvoice(); return null; }
  current = null;
  if (entry.timer) clearTimeout(entry.timer);
  let bolt11: string;
  try { bolt11 = await entry.invoice; }
  catch { entry.relay.close(); try { entry.journal.stop(false); } catch { /* nothing was recorded */ } return null; }
  // Adopted: the flow's own journal records the same invoice (deduplicated)
  // and decides its final state; this one is left as recorded.
  entry.relay.attach(onState, onGateway);
  return bolt11;
}

/** Tests only. */
export function resetPreparedInvoice(now?: () => number): void {
  if (current?.timer) clearTimeout(current.timer);
  current = null;
  clock = now ?? (() => Date.now());
}
