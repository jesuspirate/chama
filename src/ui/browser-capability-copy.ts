/** Presentation only: do not turn browser capability failures into key failures. */
export function missingWebCrypto(error: string | undefined): boolean {
  return /(?:crypto\.subtle|Web Crypto API)/i.test(error ?? "") && /(?:unavailable|not available|undefined|required)/i.test(error ?? "");
}
export function cameraUnavailableReason(secure: boolean | undefined, mediaDevices: Pick<MediaDevices, 'getUserMedia'> | undefined): 'https' | 'unavailable' | null {
  if (secure === false) return 'https';
  return typeof mediaDevices?.getUserMedia === 'function' ? null : 'unavailable';
}
