# Updating the upstream version

Chama is packaged from **this repository's own source** — the `Dockerfile` builds the web
client and the Rust Fedimint bridge from the tree it is checked out in. There is no
external image tag or submodule to move, so "upstream" here means the application version
this repo is at.

## Determining the upstream version

The application version is `version` in the root `package.json`, bumped by
`scripts/release.sh` and mirrored into the Tauri bundle via `src-tauri/tauri.conf.json`.

```sh
node -p "require('./package.json').version"
```

The packaged version lives in `startos/versions/current.ts` as `<app version>:<revision>`.
The two are in sync when the upstream half of that string equals the value above.

## Applying the bump

1. Set `version` in `startos/versions/current.ts` to `<app version>:0`.
2. Rewrite `releaseNotes` in that file for all five locales (`en_US`, `es_ES`, `de_DE`,
   `pl_PL`, `fr_FR`), describing what the release changes **for someone running it on
   StartOS** — not the full app changelog.
3. If only the packaging changed and the application version did not, leave the upstream
   half alone and increment the revision instead (`5.7.0:0` → `5.7.0:1`).

A migration is only needed when the on-disk layout under `/data` changes — the bridge's
per-client wallet directories (`/data/client-1` … `/data/client-3`). A plain application
or packaging bump keeps `migrations.up` empty and stays in `current.ts`; do not spin off a
version file for it.
