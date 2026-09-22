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
