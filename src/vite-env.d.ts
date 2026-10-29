/// <reference types="vite/client" />

declare const __APP_VERSION__: string;
/** Vite define: true only in `VITE_CHAMA_SANDBOX=1` builds (poc.getchama.app). */
declare const __CHAMA_SANDBOX__: boolean | undefined;
/** Vite define: "chama-sandbox-build" in sandbox builds, "" in every other build. */
declare const __CHAMA_SANDBOX_MARKER__: string | undefined;
/** Local-build stamp ("MM-DD HH:mm"); empty string on CHAMA_RELEASE=1 builds. */
declare const __BUILD_STAMP__: string;
/** Vite define: true only in `CHAMA_PROFILING=1` builds (React profiling bundle). */
declare const __CHAMA_PROFILING__: boolean | undefined;
