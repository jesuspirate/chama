import { Capacitor, SystemBars, SystemBarsStyle, SystemBarType } from '@capacitor/core';
import { StatusBar, Style } from '@capacitor/status-bar';

import { nativeDevice } from '../native/device.js';
let theme: 'light' | 'dark' = 'dark';
let background = '#05050a';
export function syncNativeAppearance(next: 'light' | 'dark', color: string): void {
  theme = next; background = color;
  if (Capacitor.getPlatform() !== 'android') return;
  void nativeDevice.setTheme({color: background}).catch(() => {});
  void StatusBar.setStyle({ style: theme === 'light' ? Style.Light : Style.Dark }).catch(() => {});
  void StatusBar.setBackgroundColor({ color: background }).catch(() => {});
  void SystemBars.setStyle({ bar: SystemBarType.NavigationBar,
    style: theme === 'light' ? SystemBarsStyle.Light : SystemBarsStyle.Dark }).catch(() => {});
}
if (typeof window !== 'undefined') {
  const sync = () => syncNativeAppearance(theme, background);
  window.addEventListener('chama:resume', sync);
  window.addEventListener('focus', sync);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
}
