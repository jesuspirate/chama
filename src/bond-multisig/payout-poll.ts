/** Recovery reads back off; completed rooms never refresh faster than a minute.
 * The read returns true once the output is spendable. Cleanup prevents late
 * reads from scheduling another retry after confirmation or navigation. */
export function pollPayoutRecovery(options: {
  completed: boolean;
  read: () => Promise<boolean>;
  schedule?: (run: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clear?: (timer: ReturnType<typeof setTimeout>) => void;
}): () => void {
  let stopped = false, attempt = 0;
  let timer: ReturnType<typeof setTimeout>;
  const schedule = () => {
    const delay = options.completed ? 60_000 : [3_000, 10_000, 30_000, 60_000][Math.min(attempt++, 3)];
    timer = (options.schedule ?? setTimeout)(() => { void run(); }, delay);
  };
  const run = async () => {
    let spendable = false;
    try { spendable = await options.read(); } catch { /* Retry a failed explorer read. */ }
    if (!stopped && !spendable) schedule();
  };
  schedule();
  return () => { stopped = true; (options.clear ?? clearTimeout)(timer); };
}
