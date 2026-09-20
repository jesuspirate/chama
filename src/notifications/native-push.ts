import { Capacitor, registerPlugin } from "@capacitor/core";

export type NativePushStatus = { lane: "fcm" | "unifiedpush" | "unavailable"; ready: boolean; registered: boolean };
interface NativePushPlugin {
  status(): Promise<NativePushStatus>;
  enable(options: { vapid: string }): Promise<void>;
  register(options: { tags: readonly string[] }): Promise<void>;
  unregister(options: { tags: readonly string[] }): Promise<void>;
  disable(): Promise<void>;
}
const native = registerPlugin<NativePushPlugin>("ChamaPush");
export function isNativePushSupported(): boolean {
  return Capacitor.getPlatform() === "android" && Capacitor.isPluginAvailable("ChamaPush");
}
export async function nativePushStatus(): Promise<NativePushStatus | null> {
  try { return isNativePushSupported() ? await native.status() : null; } catch { return null; }
}
let pending: Promise<boolean> | null = null;
export function ensureNativePush(vapid: string): Promise<boolean> {
  if (pending) return pending;
  pending = (async () => {
    try {
      await native.enable({ vapid });
      // UnifiedPush endpoint registration completes in a service callback.
      for (let i = 0; i < 40; i++) {
        if ((await native.status()).ready) return true;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      await native.disable();
      return false;
    } catch { await native.disable().catch(() => {}); return false; }
    finally { pending = null; }
  })();
  return pending;
}
export async function nativeWatchTags(tags: readonly string[], remove = false): Promise<boolean> {
  try { await (remove ? native.unregister({ tags }) : native.register({ tags })); return true; }
  catch { return false; }
}
export async function disableNativePush(): Promise<void> { await native.disable().catch(() => {}); }
