// ══════════════════════════════════════════════════════════════════════════
// Protocol core — which listing photo references are valid on the wire
// ══════════════════════════════════════════════════════════════════════════
//
// Validation only. Uploading a photo is an app concern and lives in
// src/media/listing-image-upload.ts.

export const MAX_LISTING_IMAGE_REFS = 9;

/** An https URL, normalised, or null. */
export function validateRemoteImageUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function areSupportedListingImageRefs(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_LISTING_IMAGE_REFS && value.every(isSupportedListingImageRef);
}

export function isSupportedListingImageRef(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.startsWith("data:image/")) return value.length <= 500_000;
  return value.length <= 2_048 && validateRemoteImageUrl(value) !== null;
}
