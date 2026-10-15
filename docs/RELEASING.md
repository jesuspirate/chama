# Releasing Chama

Chama separates creating a version from publishing that existing version to a distribution channel.

## New version

Use `ship` for a new patch, minor, or major release. It bumps the version, commits, pushes `main`, creates the signed tag, deploys the web app, prepares Android assets, uploads GitHub assets, and publishes Zapstore.

```sh
npm run ship -- --patch
npm run ship -- --minor
npm run ship -- --major
```

The convention-named release-note files described in `scripts/release-notes-template.txt` are required for a new version. They live in the gitignored repo-local `release-notes/` directory (falling back to `/tmp`); when the notes for a version newer than `package.json` are present, plain `npm run ship` infers the target version from them — so the whole release is: drop the notes, run `npm run ship`, confirm the plan.

## Start9

When `release-notes/chama-vX.Y.Z_startos_current.ts` exists (a full five-locale replacement for the packaging repo's `startos/versions/current.ts`), `ship` finishes by running `scripts/start9-release.sh`: it pins the `chama/` submodule in a fork checkout of [`Start9-Community/chama-startos`](https://github.com/Start9-Community/chama-startos) to the signed release tag, installs the version file, pushes branch `chama-vX.Y.Z` to the fork, and opens the community PR with `gh`. Merging that PR triggers the packaging repo's CI to build, sign, and publish the `.s9pk` — nothing is built locally. Skip with `--no-start9`; run alone with `npm run ship -- --only start9 --tag vX.Y.Z` (add `--dry-run` to preview). The checkout lives at `~/start9-workspace/chama-startos` (override `CHAMA_STARTOS_DIR`).

## One destination only

Use the same entry point with `--only` when the version already exists and only one surface needs refreshing:

| Intent | Command | What it does not touch |
| --- | --- | --- |
| Push committed code | `npm run ship -- --only github` | Tags, deployments, releases |
| Push/verify the signed version tag | `npm run ship -- --only tag` | Web, Android, Zapstore |
| Deploy getchama.app | `npm run ship -- --only web` | Landing, GitHub, Zapstore |
| Deploy the sandbox (poc.getchama.app) | `npm run ship -- --only sandbox [--rc N]` | Live web, tags, Android, Zapstore |
| Host a prerelease APK for a test phone | `npm run ship -- --only prerelease [--rc N] [--next patch\|minor\|major]` | Tags, commits, GitHub, Zapstore, Start9, web |
| Deploy chama.community | `npm run ship -- --only landing` | App, GitHub, Zapstore |
| Prepare Android assets | `npm run ship -- --only android` | Every remote channel |
| Upload Android assets to GitHub | `npm run ship -- --only github-assets --clobber` | Web, landing, Zapstore |
| Edit the GitHub Release page | `npm run ship -- --only release-page --notes-file /tmp/notes` | Assets and other channels |
| Publish the GitHub Release page | `npm run ship -- --only release-page --publish` | Assets and other channels |
| Publish current Android release to Zapstore | `npm run ship -- --only zapstore` | Web, landing, GitHub |
| Update Start9 packaging + open the community PR | `npm run ship -- --only start9 --tag vX.Y.Z` | Every other channel |
| Refresh Zapstore images and description | `npm run ship -- --only zapstore-listing` | Web, landing, GitHub |
| Run all distribution channels for the current version | `npm run ship -- --only full` | No version bump or new commit |

`npm run publish -- --only …` is an equivalent direct entry point. Add `--dry-run` to any target to print the exact command without changing local or remote state.

If `main` has advanced beyond the requested release tag, the GitHub-assets, Zapstore, Zapstore-listing, and full targets automatically reuse that tag's prepared APK. They never rebuild a tagged release from newer source. Use `--release-dir` when restoring those assets from a different directory.

## Sandbox

`https://poc.getchama.app` serves the current worktree built with `VITE_CHAMA_SANDBOX=1`: production code with sim mode forced on. The URL flag, the entry modal's exit button and localStorage are all ignored there, so that origin can never reach a real federation or move real sats, while trades still run through the real Nostr relays (sim-tagged, so the live app never sees them). Use it to walk a release candidate through a full trade from any browser or phone before `ship`, with nobody at risk.

`npm run ship -- --only sandbox` runs the gates, builds into `dist-sandbox/` (never `dist/`), refuses a bundle without the sandbox marker, keeps a dated copy of the previous sandbox on the VPS, and verifies the served origin after upload. With `--rc N` (and optional `--next minor|major`) it carries the same transient `X.Y.Z-rc.N` version as the matching prerelease APK, so the version on screen says which candidate the sandbox runs; the version is restored on exit and never committed. Deploy the sandbox with the same `--rc N` every time a prerelease is built. The live lane refuses a sandbox bundle, and a sandbox build is never mirrored from a live deploy.

## Prerelease APK

The sandbox cannot exercise the native bridge or Android push. When a candidate needs a phone, `npm run ship -- --only prerelease` builds the current worktree exactly as a release would (same signing key, native bridge included) under a transient `X.Y.Z-rc.N` version — `X.Y.Z` is the next patch (or `--next minor|major`), `N` from `--rc`, default 1 — and hosts it at `https://poc.getchama.app/prerelease/chama-X.Y.Z-rc.N-PRERELEASE.apk` with its `.sha256` and `.sha256.asc`. The version change is restored on exit and never committed; nothing is tagged or published.

Because it carries the release signature, it installs **over** the production app and keeps the device wallet. The lane is forward-only: Android refuses a lower `versionCode` and uninstalling deletes the wallet, so there is no rollback — only another rc (same `versionCode`) or shipping `X.Y.Z`, which installs over the rc. A sandbox deploy keeps the hosted file; the next prerelease replaces it.

## Zapstore metadata limitation

Zapstore's publisher does not expose an app-metadata-only operation. `zapstore-listing` therefore verifies the existing signed APK and re-publishes the current release event with `--overwrite-release`, which refreshes the app event containing `zapstore.yaml`'s icon, screenshots, summary, and description. Existing Zapstore release notes are preserved unless `--zapstore-notes-file` is supplied. It does not deploy or upload anywhere else.

## Release page and assets are separate

The desktop GitHub Action creates a draft release and uploads Windows and Linux bundles. The Android lane uploads the signed APK and verification files. `release-page --publish` is intentionally separate so the release is not made public before both workflows have finished.

Run this final sequence for an already-tagged version:

```sh
npm run ship -- --only github-assets --clobber
npm run ship -- --only zapstore
npm run ship -- --only release-page --publish
```

## Common overrides

```sh
--tag vX.Y.Z
--repo owner/repo
--notes-file /path/to/github-notes
--zapstore-notes-file /path/to/short-zapstore-notes
--release-dir /path/to/prepared-assets
--gpg-key KEY_ID
--overwrite-zapstore
--reuse-apk                 # alias: --no-build
--skip-gates                # only after predeploy/build passed in this shell
```

Secrets and host-specific paths remain in the gitignored `.env.release` file.

### Prepared branch ancestry

A `release/*` candidate must include the current local `main`:

```sh
npm run check:release-ancestry
```

The same check runs in `predeploy` and at the start of `ship.sh` and
`release.sh` for main/release branches, before release side effects. It fails
if main is missing or is not an ancestor. This protects committed ancestry;
conflict resolution still needs the application regressions. When .21 lands,
merge the newly advanced main into a prepared .22 candidate and rerun checks.
Preparation branches are reviewed and fast-forwarded to main before using the
canonical ship command. No version bump or release occurs during preparation.

## Amber phone signing (default on Jet's Mac)

The verified NIP-46 connection is stored outside Git at
`~/Library/Application Support/chama-release/zapstore-bunker.txt`. Its directory
is owner-only (0700), and the file is owner-only (0600). This is a pairing
credential, not the publisher's private key; treat it as a secret. This storage
protects it from other local accounts, not programs running as your account.
Do not paste it into chat, commits, logs or shell command arguments.

`ship` and the Android Zapstore lane load this file into `SIGN_WITH` without
printing it. On Jet's Mac, the gitignored `.env.release` already loads the same
connection through a private copy of the validator in that directory, so Amber
is the default even before this script change merges. An explicitly set `SIGN_WITH` wins. `CHAMA_ZAPSTORE_SIGNER_FILE`
selects another private file. A missing default uses the existing browser signer;
a malformed, insecure, or explicitly configured missing file stops signing.

For a normal release use `npm run ship -- --patch`. For an already prepared
version use `npm run ship -- --only zapstore --tag vX.Y.Z`. The normal release
checks and publishing confirmations still apply. Keep Amber running and
connected, review the requests, and approve them on the phone. Keep **Never auto
approve**: the Mac prepares the events, and the publisher key stays in Amber.
This does not approve a new release in advance or bypass Zapstore's final
publishing/terms confirmation.

The tested connection uses `wss://nrs.primal.net` and `wss://relay.nip46.com`.
These are signing transport relays, separate from social inbox/outbox relays.
Both ends must have the same connection relays. If no prompt arrives, inspect
Amber's connection and logs and the relay's publish acknowledgement; a working
WebSocket alone does not prove writes are accepted. Do not repeatedly retry a
rate-limited relay. Updating Amber's defaults does not repair an existing
connection's saved permissions or response relays.

zsp also stores a local NIP-46 client key under
`~/Library/Application Support/zsp/bunker-keys/`. Retain it: Amber's permissions
are tied to that client identity. Never commit or print these files. If pairing
is broken, create a fresh connection in Amber and replace the private connection
file deliberately; do not silently rotate keys or enable automatic approval.

The signing-only acceptance test used `zsp publish zapstore.yaml --offline
--quiet`, capturing output privately. It signed three events (32267, 30063,
3063) for 6.4.21; all signatures and the APK fingerprint were verified. Offline
mode uploads and publishes nothing. Use `--offline` explicitly for future tests;
`--quiet` alone is not a dry run. Signed test output can be published, so keep it
private and never feed it into a publishing command by accident.

Signer regression checks: `node --test scripts/zapstore-signer.tests.mjs`.

### Quiet Zapstore publish (default with Amber)

When the signer is an Amber (`bunker://`) connection, the Zapstore lane runs
`zsp publish zapstore.yaml --quiet --skip-preview`: no Enter, no "Publish now"
selector. Every signature still waits for a manual approval in Amber on the
phone. A quiet zsp prints nothing on success and also exits 0 when there is
nothing to publish, so the lane then runs
`node scripts/verify-zapstore-release.mjs --since <start>`. It requires a
signed kind 30063 event for `<applicationId>@<version>` from the publisher in
`zapstore.yaml` on `wss://relay.zapstore.dev`. It retries a few times for relay
lag, fails the release when the event never lands, and reports "already
published" when this run added nothing new. A deliberate re-publish (`--overwrite-zapstore`)
adds `--require-new`: if only the earlier release event is on the relay, the
re-publish landed nothing and the release fails. Before a quiet run the lane
prints `zsp --version` and the binary path, because quiet zsp prints nothing. Run it by hand at any time:
`node scripts/verify-zapstore-release.mjs --version X.Y.Z`.

The browser signer needs a person at the Mac, so it stays interactive. To force
the interactive run, pass `--zapstore-interactive` to `ship`, `ship --only …`
or `android-release.sh`, or set `CHAMA_ZAPSTORE_INTERACTIVE=1`. The publish-mode
choice and the relay check are covered by `npm test`.
