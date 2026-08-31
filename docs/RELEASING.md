# Releasing Chama

Chama separates creating a version from publishing that existing version to a distribution channel.

## New version

Use `ship` for a new patch, minor, or major release. It bumps the version, commits, pushes `main`, creates the signed tag, deploys the web app, prepares Android assets, uploads GitHub assets, and publishes Zapstore.

```sh
npm run ship -- --patch
npm run ship -- --minor
npm run ship -- --major
```

The convention-named release-note files described in `scripts/release-notes-template.txt` are required for a new version.

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
| Refresh Zapstore images and description | `npm run ship -- --only zapstore-listing` | Web, landing, GitHub |
| Run all distribution channels for the current version | `npm run ship -- --only full` | No version bump or new commit |

`npm run publish -- --only …` is an equivalent direct entry point. Add `--dry-run` to any target to print the exact command without changing local or remote state.

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
