# AGENTS.md

This is the authoritative Chama application repository. It contains the web/PWA client, desktop and Android shells, the Nostr escrow protocol, and the native Fedimint bridge.

## Repository boundary

- Application changes land here: <https://github.com/jesuspirate/chama>.
- StartOS packaging lives only at <https://github.com/Start9-Community/chama-startos>. It consumes this repository through the `chama/` git submodule pinned to a signed `vX.Y.Z` application tag.
- **Never update or synchronize <https://github.com/Start9-Community/chama>.** That repository is a retired fork. Its ahead/behind count does not describe the version packaged by StartOS.
- Do not add `startos/`, `.s9pk` build workflows, StartOS version metadata, or package-repository release tags back to this tree. Package issues and PRs belong in `chama-startos`.

## Working rules

- Preserve unrelated user changes in a dirty worktree.
- Use `rg` / `rg --files` for repository search.
- Keep money-path changes fail-closed. Never replace, rotate, or delete a possibly funded wallet merely to make startup succeed.
- A Nostr identity is not a bearer-ecash backup. Keep device-local browser wallets and the native bridge's wallet state conceptually separate.
- Buyer, seller, and arbiter decisions must come from committed escrow state. Historical community-pool membership alone is not a current obligation.
- Update regression coverage for wallet storage, federation routing, encryption, escrow voting, claims, and recovery behavior.

## Brief delivery lessons

Apply these rules to every brief, even when the brief omits them. The agent
owns the safety and verification of the change it delivers, including copied
code; authorship and a missing instruction do not excuse a missed defect.

### Before and after sats move

- Before changing a money path, trace every caller through preflight, spend or
  invoice payment, publish, retry and recovery. Mark the point at which sats
  move; a function receiving already-funded notes is already past that point.
- Checks for payment handles, optional metadata and UI confirmation must run
  **before any sats move**. Keep the user's confirmation before funding, and
  check all entry points rather than assuming one preflight covers every caller.
- **After sats move, never abort the lock solely because a handle or other
  optional detail disappeared or changed.** Use the supported fallback (for
  payment details, agreed methods plus chat), and preserve the funded state and
  its publish or recovery path. This does not permit bypassing consensus,
  authorization or custody checks: those remain fail-closed, with funds retained
  for settlement or recovery rather than lost behind a new exception.
- Rechecks after a spend and retries with saved funds require special review.
  If a safety check refuses a funded attempt, use the existing lawful recovery
  path and report what happened accurately; never claim no sats moved without
  evidence.
- Add regression tests that remove or change optional details between
  confirmation and publish, refuse invalid details before funding with no spend,
  and exercise retries with funds already present. Assert the funds' disposition
  and published events, not just the error text.

### Scope and verification

- For repeated work, inspect the earlier commits and their fixes before coding;
  carry their lessons forward instead of recreating the same failure.
- Before merging, inspect branch ancestry, the commits being introduced and the
  complete diff. A presentation branch must not carry old money-path commits.
  Honour exact fenced-off paths and explicitly approved exceptions.
- Verify test wiring mechanically, including direct calls, aliases and dynamic
  imports. Check every named suite is exercised by the intended command; an
  imported wrapper alone does not prove all calls use it. Use tools available
  to the CI runner in executable tests.
- Test failed actions and repeated taps as well as success. A rejected vote must
  restore retry controls promptly; replacing a pending confirmation must settle
  the previous promise so no caller hangs.
- Before delivery, review the full diff against the brief and report exactly
  which checks passed, what they prove and what remains unverified. Distinguish
  local checks, CI and device evidence; do not claim an unrun check passed.

## Release notes

Two audiences, two documents. Do not write one and trim it into the other.

`chama-vX.Y.Z_release_notes` is the long form: the commit message and the
GitHub release body. It is read by people who want to know how Chama works.
Mechanism, measurement, incidents and limits belong there, stated plainly.

`chama-vX.Y.Z_zapstore_notes` is a card on a phone, read by someone deciding
whether to tap Update. It gets **only what changes their experience**, and
nothing else. Not what we built — what is different for them.

Apply this test to every line before it ships:

- Can a reader tell what is different FOR THEM, without knowing how Chama
  is built? If not, cut the line.
- Does the line need a word the user has never seen in the app — journal,
  replay, provenance, summary, relay, addressable, refactor, migration? If
  yes, it is a long-form line wearing an emoji. Cut it or say the effect
  instead.
- Is it a bug they never met, an incident they never saw, or an internal
  cleanup? Cut it. They do not need our history to decide about an update.
- Would they notice if we said nothing? If no, say nothing.

Fewer, stronger lines. Four that land beat nine that fill. The card is not
a changelog and it is not a receipt for our effort.


## Verification

Use the application commands in this repository:

```sh
npm run typecheck
npm test
npm run build
```

`npm run predeploy` also runs the repository-hygiene gate. Do not use StartOS package commands here.

## Releases

`npm run ship -- --patch|--minor|--major` is the canonical new-version entry point. It requires a clean `main`, consumes the convention-named release-note files, commits and pushes the bump, then delegates the signed tag, deployment, Android, GitHub, and Zapstore work to the existing release scripts. `scripts/release.sh` remains the low-level owner of signed application tags in the form `vX.Y.Z`.

For an existing version, `npm run ship -- --only <target>` must be used for channel-specific work. The available targets and their isolation guarantees are documented in `docs/RELEASING.md`; do not hand-compose partial release commands when a target exists.

StartOS package tags (`vX.Y.Z_<revision>`) are created only in `chama-startos`. After an application release, update that repository by checking its `chama/` submodule out at the new signed tag and changing its StartOS version metadata. Never merge application commits into a packaging fork.

## Skills (read before UI work)

- `.agents/skills/chama-bar/SKILL.md` — the top status bar is the one always-
  visible signal; loading, "needs you" and warnings go through it.
- `.agents/skills/proof-of-conduct/SKILL.md` — reputation is verifiable
  conduct only; read before any number shown next to a person.
