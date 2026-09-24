/** Preserve SDK/worker rejections, including non-Error values. */
export function errorText(error: unknown, fallback = "Something went wrong"): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string") return error || fallback;
  if (error && typeof error === "object") {
    for (const key of ["message", "error", "reason"] as const) {
      const value = (error as Record<string, unknown>)[key];
      if (typeof value === "string" && value) return value;
    }
  }
  try { return JSON.stringify(error) || fallback; } catch { return fallback; }
}
