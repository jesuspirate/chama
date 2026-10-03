import { recordNativeCrash } from "./native-push.js";

/** Keep the exception type and bundle location; discard messages, URLs and query strings. */
export function crashMetadata(error: unknown, file?: string, line?: number, column?: number) {
  const exceptionClass = error instanceof Error && /^[A-Za-z0-9_.$]{1,100}$/.test(error.name) ? error.name : "Error";
  const stackLocation = error instanceof Error ? error.stack?.split("\n")[1]?.match(/(?:\/|^)([A-Za-z0-9_.-]+\.(?:js|tsx?|mjs)):(\d+):(\d+)\)?$/) : null;
  let topFrame = "unknown";
  if (stackLocation) topFrame = `${stackLocation[1]}:${stackLocation[2]}:${stackLocation[3]}`;
  else if (file) {
    // A runtime filename is a location, never part of the error's message.
    const name = file.split(/[?#]/)[0].split("/").pop();
    if (name && /^[A-Za-z0-9_.-]+\.(?:js|tsx?|mjs)$/.test(name)) topFrame = `${name}:${line ?? 0}:${column ?? 0}`;
  }
  return { exceptionClass, topFrame };
}

export function installCrashBreadcrumbs(target: Window): void {
  const reported = new WeakSet<object>();
  const report = (error: unknown, file?: string, line?: number, column?: number) => {
    if (error && typeof error === "object") {
      if (reported.has(error)) return;
      reported.add(error);
    }
    void recordNativeCrash(crashMetadata(error, file, line, column));
  };
  target.addEventListener("error", event => report(event.error, event.filename, event.lineno, event.colno));
  target.addEventListener("unhandledrejection", event => report(event.reason));
}
