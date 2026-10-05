---
name: who-holds-the-money
description: Wherever sats sit still, the screen names who holds them and for how long. Read before touching any wallet, fund, lock, claim, circle, bond or federation surface, any copy containing "safe", "secure", "escrow", "trustless" or "Chama does not hold your funds", and any new rail or custody mode.
---

# Who holds the money

Jet, 2026-10-04: "push trust all the way to the guardians and federations
all throughout the app." Chama's claim is that it never holds your money.
That claim is true, and on its own it is a half-truth: somebody always
holds the money, and the person whose sats they are must be able to name
them without leaving the screen.

## The rule

Every surface where money is at rest answers one question in one line:
**who holds this, and until when.** If the screen cannot answer it, the
screen is not finished.

The test for any money screen: *if this disappeared tomorrow, who would
the user be angry at?* The screen names them. "Chama" is never the
answer, and "nobody" is only the answer for on-chain funds under the
user's own key.

## The four kinds of holding, in the words we use

| Where the sats are | Who holds them | How long | The line |
|---|---|---|---|
| On-chain, user's key | nobody | — | "On Bitcoin, under your key." |
| On-chain escrow (Taproot) | the script; refund to the funder after height N | until settled or height N | "Locked on Bitcoin. Refund leaf opens at block N (~date)." |
| Lightning in flight | the route, for seconds | seconds | no line needed; say it only on failure |
| Ecash (wallet, share, escrow share) | the federation's guardians, as an IOU | as long as notes are held | "Held by <Federation name> · n guardians" |
| Bond | the bond multisig on-chain | the term | "Locked on Bitcoin for <term>." |

Ecash is a bearer IOU issued by guardians. Say so plainly once per
surface, with the federation's name, never "your wallet" alone. The
federation name comes from `federationNameForInvite` for curated presets,
else the federation's own `federation_name` meta, else the short id;
guardian count from the invite config. Duration is the thing people
forget: a trade holds ecash for a day, a circle for a whole cycle. Longer
hold, bigger line.

## Where the line goes

- **Wallet header** (Me › Wallet): "In your Chama wallet · held by
  <Federation> · n guardians." First place a newcomer meets the idea.
- **Fund modal**, ecash rail: "Notes issued by <Federation>." Lightning
  and on-chain rails: the on-chain line when a Taproot escrow is built.
- **Lock confirmation**, every rail: the line, plus the duration
  ("until <deadline>").
- **Circle card and Lock your share**: the line plus the cycle length
  (brief v6.4.22 H). This is the longest hold in the app; it gets the
  earned warnings below.
- **Claim**: where the sats go next and who holds them there.
- **Bond**: term and the refund path.
- **Help & FAQ**: one page, "Who holds my money", the table above in
  plain words, four languages.

A small circled `?` beside the short necessary holder/action fact opens
fuller optional detail in the shared Community-style floating overlay. The
user clarified that the filled active question mark and compact shadowed
panel are the target; do not expand mechanics into main-screen paragraphs.
Its accessible label is “What's this?” in the current language. Reuse
`HelpTip`; `InlineExplanation` keeps the fact beside that same control.
Keep the 44px target, labelled keyboard-focusable panel, viewport clamping,
outside-tap/Escape/Tab/Back dismissal and reduced-motion support. Nested help
closes before a parent funding/settings sheet; the underlying task and draft
remain intact. Holder, duration, necessary consequences and earned warnings
remain visible when help is closed. Reading it never starts a wallet or money
action. Apply where relevant, preserving the existing four-language Wallet,
fund, lock and FAQ simplification. Long FAQ content remains a full page; do
not add these controls to the chooser or key screen.

## Earned warnings (shown only when true)

1. **Not on Chama's list.** The federation is not in `CURATED_PRESETS`
   and not the member's community federation: "You'd be trusting
   guardians Chama hasn't vetted, until <date>." Before the seat or the
   lock, and again on Lock.
2. **Looks like one operator.** Fewer than 4 guardians, or all guardian
   API endpoints on one hostname / one registrable domain / one IP
   literal, or the host's key among the guardians: "This federation looks
   like it runs on one machine. If it goes away, so do the shares."
   Stronger colour. Never a block.
3. **Long hold.** Any ecash hold over a week: name the number of days
   next to the holder.

"Curated" means Jet looked at it, not that anyone audited it. Say
"on Chama's list", never "vetted by Chama", unless the Fedi meta
`vetted_gateways` is the thing being described.

## Words

Use: *held by*, *guardians*, *issued by*, *IOU*, *until*, *under your
key*, *on Bitcoin*. Say "Chama never holds your money" only in the same
breath as who does.

Never: *trustless*, *bank-grade*, *insured*, *100% secure*, *safe* (for
anything but on-chain under the user's key), *your funds are protected*,
*guaranteed*. Never hide a federation behind "your wallet". Never show a
number of guardians the app did not read from the config.

## Proof-of-conduct applies

Same discipline as `.agents/skills/proof-of-conduct`: a fact about a
federation is shown only if every device reading the same invite and
the same chain reaches it. Guardian count and endpoints come from the
config; uptime, reputation and "trusted" do not exist as numbers. Unknown
is "unknown", never 0 and never good (see the liveness note in brief
v6.4.22).

## Checklist for any PR that touches money

- [ ] Every screen where sats rest names the holder and the duration.
- [ ] Federation name and guardian count read from config, not typed.
- [ ] Earned warnings fire only on their condition, with a test each.
- [ ] No banned word on the screen; "Chama never holds" is paired.
- [ ] `?` explainer exists for the rail, four languages, under 3 lines.
- [ ] Help & FAQ "Who holds my money" updated if a rail or mode changed.
