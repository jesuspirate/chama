const NOSTR_BUILD_UPLOAD_ENDPOINT = "https://nostr.build/api/v2/upload/files";
const IMAGE_UPLOAD_TIMEOUT_MS = 30_000;

// Wire-format validation lives in the protocol core; re-exported for existing callers.
export { MAX_LISTING_IMAGE_REFS, areSupportedListingImageRefs, isSupportedListingImageRef } from "../protocol/core/listing-image-ref.js";
import { validateRemoteImageUrl } from "../protocol/core/listing-image-ref.js";
export type ListingImageUploadAuthorizer = (url: string, method: "POST") => Promise<string>;

class ImageUploadHttpError extends Error {
  constructor(readonly status: number) {
    super(`Photo host rejected the upload (${status}).`);
  }
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function extractUploadedImageUrl(value: unknown, depth = 0): string | null {
  if (depth > 6 || value === null || value === undefined) return null;

  if (Array.isArray(value)) {
    if (value[0] === "url" && typeof value[1] === "string") {
      return validateRemoteImageUrl(value[1]);
    }
    for (const child of value) {
      const found = extractUploadedImageUrl(child, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.url === "string") {
      const direct = validateRemoteImageUrl(record.url);
      if (direct) return direct;
    }
    for (const child of Object.values(record)) {
      const found = extractUploadedImageUrl(child, depth + 1);
      if (found) return found;
    }
  }

  return null;
}

function dataUrlToBlob(dataUrl: string): Blob {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(dataUrl);
  if (!match) throw new Error("The saved photo could not be prepared for upload.");

  const bytes = atob(match[2]);
  const data = new Uint8Array(bytes.length);
  for (let index = 0; index < bytes.length; index += 1) data[index] = bytes.charCodeAt(index);
  return new Blob([data], { type: match[1].toLowerCase() });
}

function safeUploadFilename(filename: string, type: string): string {
  const cleaned = filename.trim().replace(/[^a-z0-9._-]+/gi, "-").slice(-96);
  if (cleaned && /\.[a-z0-9]{2,5}$/i.test(cleaned)) return cleaned;
  const extension = type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg";
  return `${cleaned || "chama-listing"}.${extension}`;
}

export async function uploadListingImage(
  blob: Blob,
  filename = "chama-listing.jpg",
  authorize?: ListingImageUploadAuthorizer,
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await uploadListingImageOnce(blob, filename, authorize);
    } catch (error) {
      lastError = error;
      const retryable = error instanceof ImageUploadHttpError && (error.status === 429 || error.status >= 500);
      if (!retryable || attempt === 3) break;
      await wait(500 * attempt);
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error("Photo upload failed. Check your connection and try again.");
}

async function uploadListingImageOnce(
  blob: Blob,
  filename: string,
  authorize?: ListingImageUploadAuthorizer,
): Promise<string> {
  const formData = new FormData();
  formData.append("file", blob, safeUploadFilename(filename, blob.type));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_UPLOAD_TIMEOUT_MS);
  try {
    const authorization = authorize
      ? await authorize(NOSTR_BUILD_UPLOAD_ENDPOINT, "POST")
      : undefined;
    const response = await fetch(NOSTR_BUILD_UPLOAD_ENDPOINT, {
      method: "POST",
      headers: authorization ? { Authorization: authorization } : undefined,
      body: formData,
      signal: controller.signal,
    });
    if (!response.ok) {
      if (response.status === 401) {
        throw new Error("Photo host needs a signed upload. Reconnect your signer and try again.");
      }
      throw new ImageUploadHttpError(response.status);
    }

    const payload: unknown = await response.json();
    const url = extractUploadedImageUrl(payload);
    if (!url) throw new Error("Photo host returned no usable image link.");
    return url;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("Photo upload timed out. Check your connection and try again.");
    }
    if (error instanceof Error) throw error;
    throw new Error("Photo upload failed. Check your connection and try again.");
  } finally {
    clearTimeout(timeout);
  }
}

export async function ensureRemoteListingImage(
  imageRef: string,
  filename?: string,
  authorize?: ListingImageUploadAuthorizer,
): Promise<string> {
  if (!imageRef) return "";
  const remote = validateRemoteImageUrl(imageRef);
  if (remote) return remote;
  if (!imageRef.startsWith("data:image/")) throw new Error("This listing contains an invalid photo link.");
  return uploadListingImage(dataUrlToBlob(imageRef), filename, authorize);
}
