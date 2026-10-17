// Where this person's Fedimint wallet actually lives, for copy only.
//
// "browser": the WASM wallet in this browser's own storage (plain web, Fedi
//   webview, and the sandbox's practice wallet). Clearing site data erases it.
// "app": the Rust bridge inside the Android or desktop app, on this device.
//   Browser storage and OPFS mean nothing here; the app's own storage does.
// "node": the Rust bridge on a Chama node this browser talks to (StartOS or a
//   friend's node). The wallet is on that node, not in this browser.
//
// This only picks words. It never decides where money goes.
import {
  isNativeBridgeModeOn,
  isShellManagedNativeBridge,
} from "../fedimint/native-bridge-adapter.js";

export type WalletHome = "browser" | "app" | "node";

export function walletHome(): WalletHome {
  if (!isNativeBridgeModeOn()) return "browser";
  return isShellManagedNativeBridge() ? "app" : "node";
}

/** The Android or desktop app shell, whatever its wallet route. */
export function isNativeAppShell(): boolean {
  return isShellManagedNativeBridge();
}
