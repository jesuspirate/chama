// Android versionCode for a Chama version string. Mirrors android/app/build.gradle,
// and android-release.sh checks the built APK against this before anything ships.
//
//   X.Y.Z-rc.N  →  (X*10000 + Y*100 + Z) * 100 + N     (N = 1..98)
//   X.Y.Z       →  (X*10000 + Y*100 + Z) * 100 + 99
//
// Every rc of a version sorts below its release, so Zapstore (which compares
// versionCodes) offers the real release to a phone that has an rc installed.
// Up to 6.4.25 the code was X*10000 + Y*100 + Z for rcs and releases alike;
// 6.4.25-rc.14 and 6.4.25 were both 60425, and Zapstore offered no update.
// Every code from this scheme is far above 60425, so updates stay forward-only.
// Anything else (another suffix, rc.0, rc.99+) is refused rather than guessed.

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/;
export const MAX_RC = 98;

export function androidVersionCode(version) {
  const match = VERSION.exec(String(version));
  if (!match) throw new Error(`Unsupported Android version "${version}": expected X.Y.Z or X.Y.Z-rc.N`);
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  if (minor > 99 || patch > 99) throw new Error(`Unsupported Android version "${version}": minor and patch must be 0..99`);
  const base = major * 10000 + minor * 100 + patch;
  if (match[4] === undefined) return base * 100 + 99;
  const rc = Number(match[4]);
  if (rc < 1 || rc > MAX_RC) throw new Error(`Unsupported Android version "${version}": rc must be 1..${MAX_RC}`);
  return base * 100 + rc;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { console.log(androidVersionCode(process.argv[2])); }
  catch (error) { console.error(`❌ ${error.message}`); process.exit(1); }
}
