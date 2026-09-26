import { EsploraUnavailableError } from './fund-watcher.js';

export const EXPLORER_RETRY_MESSAGE = "Couldn't check the payout yet — the block explorer didn't answer. Retrying…";
export const explorerRetryDelay = (attempt: number) => Math.min(30_000, 5_000 * 2 ** attempt);

/** Retry availability failures only. Cleanup suppresses stale results and
 * scheduled retries; callers must never put signing or destination choice here. */
export function retryExplorerRead<T>(opts: {
  read: () => Promise<T>;
  success: (result: T) => void;
  failure: (error: unknown) => void;
  schedule?: (run: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clear?: (timer: ReturnType<typeof setTimeout>) => void;
}): () => void {
  let cancelled = false, attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async () => {
    try {
      const result = await opts.read();
      if (!cancelled) opts.success(result);
    } catch (error) {
      if (cancelled) return;
      opts.failure(error);
      if (error instanceof EsploraUnavailableError) timer = (opts.schedule ?? setTimeout)(() => void run(), explorerRetryDelay(attempt++));
    }
  };
  void run();
  return () => { cancelled = true; if (timer !== undefined) (opts.clear ?? clearTimeout)(timer); };
}
