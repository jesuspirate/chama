import { registerPlugin } from '@capacitor/core';
/** One registration shared by appearance and payment-link callers. */
export const nativeDevice = registerPlugin<{
  setTheme(options: {color: string}): Promise<void>;
  payment(options: {uri: string; share: boolean}): Promise<void>;
}>('ChamaDevice');
