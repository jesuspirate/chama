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

## Verification

Use the application commands in this repository:

```sh
npm run typecheck
npm test
npm run build
```

`npm run predeploy` also runs the repository-hygiene gate. Do not use StartOS package commands here.

## Releases

`scripts/release.sh` owns signed application tags in the form `vX.Y.Z`. It requires a clean `main` exactly synchronized with `origin/main`, runs the release gates, bumps `package.json`, commits, tags, pushes, and deploys.

StartOS package tags (`vX.Y.Z_<revision>`) are created only in `chama-startos`. After an application release, update that repository by checking its `chama/` submodule out at the new signed tag and changing its StartOS version metadata. Never merge application commits into a packaging fork.
