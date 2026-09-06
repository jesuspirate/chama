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
