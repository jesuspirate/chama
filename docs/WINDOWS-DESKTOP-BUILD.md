# Windows desktop build — fedimint-bridge probe

**Question (the brief):** does `native/fedimint-bridge` compile on Windows at
all? The unknown is the bridge's native dependency tree (rocksdb, iroh), *not*
Tauri. Deliverables are answers to three questions:

1. **Does the bridge build** on Windows (MSVC)?
2. **Does the sidecar spawn** (the compiled `.exe` runs)?
3. **Does NSIS bundle** (Tauri emits a Windows installer)?

If yes → add a `windows-latest` leg to CI.

## How this is being answered

The probe runs on a real Windows MSVC runner via
`.github/workflows/windows-bridge-probe.yml`. That workflow *is* the
`windows-latest` leg — it builds the bridge, spawns the produced `.exe`, and
runs `tauri build --bundles nsis`, uploading the installer as an artifact.

(The agent that authored this runs in a remote **Linux** cloud container, so it
cannot produce a native Windows binary locally — a genuine Windows MSVC runner,
i.e. CI or your own laptop, is the only way to get a definitive answer. The
Linux build below is a baseline that isolates "code is broken everywhere" from
"Windows-toolchain only".)

## Dependency risk analysis (from the committed `Cargo.lock`)

The bridge's Windows-sensitive native crates, with exact locked versions:

| Crate | Version | Windows build need | Risk |
|---|---|---|---|
| `librocksdb-sys` | 0.17.3+10.4.2 | C++ compiler (MSVC `cl`), `cmake`, `bindgen` → **libclang** | medium — needs libclang discoverable |
| `rocksdb` | 0.24.0 | (above) | medium |
| `aws-lc-sys` | 0.39.1 **and** 0.41.0 | **NASM** + **CMake** + C compiler | medium — the under-appreciated one |
| `aws-lc-rs` / `rustls` | — | pulls `aws-lc-sys` | — |
| `ring` | 0.17.14 | NASM (or shipped prebuilt) | low–medium |
| `iroh` | 0.35.0 **and** 0.90.0 | none (pure-Rust QUIC) | **low** |
| `bindgen` | 0.72.1 | libclang | medium |
| `cc` / `cmake` | 1.2.62 / 0.1.58 | MSVC toolchain | low |

**Refinement of the original intuition:** rocksdb is a real risk, but `iroh`
is *not* (it's pure Rust and builds fine on Windows). The quieter risk is
`aws-lc-sys`, which needs **NASM** and **CMake** on MSVC.

`windows-latest` GitHub runners preinstall VS 2022 C++ Build Tools, CMake, NASM,
LLVM/Clang (libclang), Strawberry Perl, and a current Rust stable — i.e. every
prerequisite above. So the probe has a real shot on the stock image; the
`Toolchain sanity` step records exactly what was present.

## Building on your own Windows laptop

If you want to build locally (outside CI), install:

1. **Rust** — https://rustup.rs (the MSVC default toolchain).
2. **Visual Studio Build Tools** — the "Desktop development with C++" workload
   (gives MSVC `cl`, the Windows SDK, and CMake).
3. **NASM** — https://www.nasm.org (for `aws-lc-sys` / `ring`); put it on `PATH`.
4. **LLVM** — https://releases.llvm.org (for `bindgen`/libclang). If `bindgen`
   can't find it, set `LIBCLANG_PATH` to the LLVM `bin` directory.
5. **WebView2** runtime (present on Windows 11; bundled installer otherwise).

Then, from **Git Bash** (so the `.sh` sidecar script runs):

```bash
npm install
npm run tauri:build          # full bundle (NSIS + MSI)
# or just the installer flavour:
npx tauri build --bundles nsis
```

The sidecar script (`scripts/build-tauri-fedimint-bridge.sh`) already detects
the `.exe` extension and `x86_64-pc-windows-msvc` host triple under Git Bash,
and names the binary `chama-fedimint-bridge-<triple>.exe` to match Tauri's
`externalBin` convention.

> **Note on `npm run` under Tauri on Windows:** Tauri runs `beforeBuildCommand`
> via `cmd.exe`, which cannot execute the `.sh` sidecar script directly. The CI
> workflow works around this with `npm config set script-shell ...bash.exe`.
> For local builds, run from Git Bash and/or set the same npm `script-shell`,
> or invoke `scripts/build-tauri-fedimint-bridge.sh` once by hand first.

## Status

- **Linux baseline** (agent's container): bridge dependency graph resolves and
  compiles cleanly — `aws-lc-rs`, `rustls`, and hundreds of fedimint crates
  build without error, confirming the code itself is sound.
- **Windows answers (Q1/Q2/Q3):** produced by the CI run of
  `windows-bridge-probe.yml`. See the run logs + the `chama-windows-nsis`
  artifact for the definitive result.
