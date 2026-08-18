// Fedimint native sidecar adapter.
//
// This keeps Chama's existing IFedimintWallet boundary intact while routing
// wallet operations through the local Rust Fedimint bridge. Browser builds stay
// opt-in; native shells default to the bridge because the APK/Tauri shell starts
// the sidecar itself.

import type {
  IFedimintWallet,
  InvoiceGatewayInfo,
  LnReceiveStateKind,
  OnchainDepositAddress,
  OnchainDepositSettled,
  OnchainInfo,
  OnchainWithdrawFees,
  OnchainWithdrawResult,
  PayOutcomeByEscrowResult,
} from "./fedimint-client.js";
import { hasBolt11Amount } from "../payments/bolt11.js";
import type { ChamaOperationMeta } from "../payments/sats-trace.js";
import {
  LN_PAY_INFLIGHT,
  LN_PAY_REFUNDED,
  codedPayError,
} from "../payments/ln-pay-codes.js";
import { expectedFederationIdForInvite } from "./federation-config.js";

export const NATIVE_BRIDGE_MODE_KEY = "chama_native_fedimint";
export const NATIVE_BRIDGE_URL_KEY = "chama_native_fedimint_url";
// Remote-bridge "friend wallet" auth: sent as `Authorization: Bearer <token>`
// on every bridge request when set. Lives ONLY in localStorage / env — never
// read from URL query params (they land in history and server logs).
export const NATIVE_BRIDGE_TOKEN_KEY = "chama_native_fedimint_token";
export const NATIVE_BRIDGE_INVITE_KEY = "chama_native_fedimint_invite";
export const NATIVE_BRIDGE_COMMUNITY_KEY = "chama_native_fedimint_community";
export const DEFAULT_NATIVE_BRIDGE_URL = "http://127.0.0.1:8787";
export const DEFAULT_NATIVE_BRIDGE_COMMUNITY = "us-blf";

const TRUE_SETTING_VALUES = new Set(["1", "true", "yes", "on"]);
const REQUIRED_NATIVE_BRIDGE_CAPABILITIES = [
  "reset",
  "idempotent_join",
  "effective_iroh_config",
];
const NATIVE_BRIDGE_READY_RETRY_DELAYS_MS = [0, 250, 500, 1000, 1500, 2500];
const NATIVE_BRIDGE_HEALTH_TIMEOUT_MS = 5_000;
const NATIVE_BRIDGE_RESET_TIMEOUT_MS = 10_000;
const NATIVE_BRIDGE_INFO_TIMEOUT_MS = 20_000;
const NATIVE_BRIDGE_JOIN_TIMEOUT_MS = 105_000;
const NATIVE_BRIDGE_JOIN_RETRY_DELAYS_MS = [0, 1500, 4000];

interface NativeBridgeFetchInit extends Omit<RequestInit, "body"> {
  body?: unknown;
  timeoutMs?: number;
}

interface NativeInfoResponse {
  federation_id: string;
  network: string;
  total_amount_msat: number;
  meta: unknown;
}

interface NativeHealthResponse {
  ok: boolean;
  joined?: boolean;
  api_version?: number;
  apiVersion?: number;
  join_timeout_secs?: number;
  joinTimeoutSecs?: number;
  iroh?: unknown;
  discovery?: unknown;
  capabilities?: string[];
}

interface NativeJoinResponse {
  joined: string;
  federation_id: string;
}

interface NativeResetResponse {
  ok: boolean;
}

interface NativeInvoiceResponse {
  operation_id?: string;
  operationId?: string;
  invoice: string;
  /** Which gateway minted this invoice, and whether anything has ever actually
   *  settled through it. Absent on bridges older than `bounded_await_invoice`. */
  gateway_id?: string;
  gateway_alias?: string;
  gateway_api?: string;
  gateway_proven_payable?: boolean;
}

interface NativeSpendNotesResponse {
  operation_id?: string;
  operationId?: string;
  requested_amount_msat?: number;
  total_amount_msat: number;
  notes: string;
}

interface NativeReissueNotesResponse {
  operation_id?: string;
  operationId?: string;
  total_amount_msat: number;
  status: string;
}

interface NativeParseNotesResponse {
  total_amount_msat: number;
  federation_id_prefix: string;
  notes_json: unknown;
}

interface NativeAwaitInvoiceResponse {
  status?: string;
  operation_id?: string;
  operationId?: string;
  info?: NativeInfoResponse;
}

interface NativePayResponse {
  // #9 Part 3: /pay and /pay-outcome return a discriminated outcome. `settled`
  // = sats left successfully; `refunded` = sats came back (safe to re-pay);
  // `inflight` = submitted but unknown (NEVER blindly re-pay — reconcile).
  status?: "settled" | "refunded" | "inflight";
  operation_id?: string;
  operationId?: string;
  fee_msat?: number;
  preimage?: string;
  error?: string;
}

interface NativePayOutcomeByEscrowResponse {
  // V7 /pay-outcome-by-escrow: the /pay-outcome statuses plus `none`
  // (scan complete, no payment ever stamped with this escrow id).
  status?: "settled" | "refunded" | "inflight" | "none";
  operation_id?: string;
  operationId?: string;
  error?: string;
}

interface NativeOnchainInfoResponse {
  network: string;
  finality_delay?: number;
  finalityDelay?: number;
  peg_in_fee_sats?: number;
  pegInFeeSats?: number;
  peg_out_fee_sats?: number;
  pegOutFeeSats?: number;
  minimum_deposit_sats?: number;
  minimumDepositSats?: number;
}

interface NativeOnchainDepositAddressResponse {
  operation_id?: string;
  operationId?: string;
  address: string;
  tweak_idx?: unknown;
  tweakIdx?: unknown;
  finality_delay?: number;
  finalityDelay?: number;
}

interface NativeOnchainDepositSettledResponse {
  status: string;
  operation_id?: string;
  operationId?: string;
  amount_sats?: number;
  amountSats?: number;
  outpoint?: string;
  info?: NativeInfoResponse;
}

interface NativeOnchainWithdrawFeesResponse {
  amount_sats?: number;
  amountSats?: number;
  fees_sats?: number;
  feesSats?: number;
  total_sats?: number;
  totalSats?: number;
}

interface NativeOnchainWithdrawResponse {
  operation_id?: string;
  operationId?: string;
  status: string;
  txid?: string | null;
  fees_sats?: number;
  feesSats?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Marks a failure as "the request never reached a verdict" — the socket died,
 *  a proxy answered instead of the bridge, or the body wasn't the bridge's JSON
 *  at all. Distinct from a bridge that answered and said no. Callers on a money
 *  path must never read one as the other: a reverse proxy hanging up on a long
 *  poll is not the federation rejecting a payment. */
const BRIDGE_TRANSPORT_FAILURE = "chamaBridgeTransportFailure";
const BRIDGE_AUTH_FAILURE = "chamaBridgeAuthFailure";

function markBridgeTransportFailure<E extends Error>(error: E): E {
  (error as E & { [BRIDGE_TRANSPORT_FAILURE]?: boolean })[BRIDGE_TRANSPORT_FAILURE] = true;
  return error;
}

export function isBridgeTransportFailure(error: unknown): boolean {
  return error instanceof Error &&
    (error as Error & { [BRIDGE_TRANSPORT_FAILURE]?: boolean })[BRIDGE_TRANSPORT_FAILURE] === true;
}

function markBridgeAuthFailure<E extends Error>(error: E): E {
  (error as E & { [BRIDGE_AUTH_FAILURE]?: boolean })[BRIDGE_AUTH_FAILURE] = true;
  return error;
}

export function isNativeBridgeAuthFailure(error: unknown): boolean {
  return error instanceof Error &&
    (error as Error & { [BRIDGE_AUTH_FAILURE]?: boolean })[BRIDGE_AUTH_FAILURE] === true;
}

/** Gateway-class HTTP statuses: something between us and the bridge answered.
 *  The bridge's own refusals come back as 4xx/500 carrying its JSON error. */
function isProxyGatewayStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

/** Re-arm pacing for the `/await-invoice` long poll when the connection to the
 *  bridge keeps dropping. The window comfortably outlives a BOLT11 invoice, so
 *  the watch survives a whole realistic payment attempt. */
const AWAIT_INVOICE_REARM_BASE_MS = 2_000;
const AWAIT_INVOICE_REARM_MAX_MS = 15_000;
const AWAIT_INVOICE_REARM_WINDOW_MS = 60 * 60_000;

/** How long the bridge holds each watch before answering `pending`. Kept well
 *  under any sane proxy read timeout so the bridge — not the proxy — is what
 *  ends the request. Bridges that predate `bounded_await_invoice` ignore this
 *  and hold the request open; the transport re-arm still covers them. */
const AWAIT_INVOICE_WAIT_SECS = 45;

function getImportEnv(key: string): string | null {
  const env = (import.meta as unknown as { env?: Record<string, unknown> }).env;
  const value = env?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getBrowserSearchParams(): URLSearchParams | null {
  try {
    if (typeof window === "undefined") return null;
    return new URL(window.location.href).searchParams;
  } catch {
    return null;
  }
}

function getLocalStorageValue(key: string): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const value = localStorage.getItem(key);
    return value !== null && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

function isCapacitorNativePlatform(): boolean {
  const maybeCapacitor = (globalThis as {
    Capacitor?: {
      isNativePlatform?: () => boolean;
      getPlatform?: () => string;
    };
  }).Capacitor;
  try {
    if (typeof maybeCapacitor?.isNativePlatform === "function") {
      return maybeCapacitor.isNativePlatform();
    }
    if (typeof maybeCapacitor?.getPlatform === "function") {
      const platform = maybeCapacitor.getPlatform();
      return platform === "android" || platform === "ios";
    }
  } catch {
    return false;
  }
  return false;
}

function isTauriNativePlatform(): boolean {
  const global = globalThis as {
    __TAURI__?: unknown;
    __TAURI_INTERNALS__?: unknown;
  };
  return Boolean(global.__TAURI__ || global.__TAURI_INTERNALS__);
}

function isShellManagedNativeBridge(): boolean {
  return isCapacitorNativePlatform() || isTauriNativePlatform();
}

function getInjectedNativeBridgeUrl(): string | null {
  const global = globalThis as {
    __CHAMA_NATIVE_FEDIMINT__?: {
      bridgeUrl?: unknown;
    };
  };
  const value = global.__CHAMA_NATIVE_FEDIMINT__?.bridgeUrl;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function setLocalStorageValue(key: string, value: string): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(key, value);
  } catch {
    // Storage is a convenience cache only; wallet operations do not rely on it.
  }
}

function isEnabledSetting(value: string | null): boolean {
  if (value === null) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "" || TRUE_SETTING_VALUES.has(normalized);
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function readOperationId(
  value:
    | NativeInvoiceResponse
    | NativeReissueNotesResponse
    | NativePayResponse
    | NativeOnchainDepositAddressResponse
    | NativeOnchainDepositSettledResponse
    | NativeOnchainWithdrawResponse,
): string {
  const operationId = value.operation_id ?? value.operationId;
  return operationId ? String(operationId) : `native-${Date.now()}`;
}

function readRequiredNumber(
  value: number | undefined,
  field: string,
  path: string,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Native Fedimint bridge ${path} omitted numeric ${field}`);
  }
  return value;
}

function inviteStorageKey(baseUrl: string, federationId: string): string {
  return `${NATIVE_BRIDGE_INVITE_KEY}:${baseUrl}:${federationId}`;
}

function nativeBridgeUnavailableError(
  baseUrl: string,
  path: string,
  cause: unknown,
): Error {
  const causeMessage = cause instanceof Error ? cause.message : String(cause || "unknown error");
  const diagnostic = {
    issue: "native_fedimint_bridge_unavailable",
    adapter: "native-rust-sidecar",
    bridgeUrl: baseUrl,
    path,
    cause: causeMessage,
    interpretation:
      "Native Fedimint mode is enabled, but Chama cannot reach the local Rust bridge. " +
      "Start the bridge process and reconnect. This is not the browser SDK gateway-vetting failure.",
  };
  const error = new Error(
    `Native Fedimint bridge is enabled but unreachable at ${baseUrl}${path}. ` +
      `Start the local Rust bridge and tap Reconnect, or disable nativeFedimint to use the browser SDK. ` +
      `This is a Rust bridge availability issue, not a Lightning gateway-vetting failure.\n\n` +
      `Chama diagnostics:\n${JSON.stringify(diagnostic, null, 2)}`,
  );
  (error as Error & { chamaDiagnostics?: Record<string, unknown> }).chamaDiagnostics =
    diagnostic;
  return error;
}

function nativeBridgeTimeoutError(
  baseUrl: string,
  path: string,
  timeoutMs: number,
): Error {
  const diagnostic = {
    issue: "native_fedimint_bridge_timeout",
    adapter: "native-rust-sidecar",
    bridgeUrl: baseUrl,
    path,
    timeoutMs,
    interpretation:
      "The local Rust bridge answered slowly enough that Chama stopped waiting. " +
      "No sats move during federation switching. Try again or reconnect the app if the target Chama route is slow.",
  };
  const error = new Error(
    `Native Fedimint bridge ${path} did not answer within ${Math.ceil(timeoutMs / 1000)}s. ` +
      `No sats moved. Try again or tap Reconnect if the route stays slow.\n\n` +
      `Chama diagnostics:\n${JSON.stringify(diagnostic, null, 2)}`,
  );
  (error as Error & { chamaDiagnostics?: Record<string, unknown> }).chamaDiagnostics =
    diagnostic;
  return error;
}

function isNativeJoinDiscoveryError(error: unknown): boolean {
  if (
    hasChamaDiagnostics(error) &&
    error.chamaDiagnostics.issue === "native_fedimint_bridge_timeout" &&
    error.chamaDiagnostics.path === "/join"
  ) {
    return true;
  }

  const message = asErrorMessage(error);
  return (
    /timed out joining federation|deadline has elapsed|failed to preview federation invite|iroh|pkarr|discovery/i.test(message)
  );
}

function nativeBridgeJoinDiscoveryError(
  baseUrl: string,
  cause: unknown,
  attempts: number,
): Error {
  const diagnostic = {
    issue: "native_fedimint_join_discovery_failed",
    adapter: "native-rust-sidecar",
    bridgeUrl: baseUrl,
    path: "/join",
    attempts,
    cause: asErrorMessage(cause),
    interpretation:
      "The native Rust bridge could not resolve or reach a guardian while joining. " +
      "Existing wallets may still open; this is the fresh-join discovery path.",
  };
  const error = new Error(
    "Couldn't reach this federation yet. Chama retried the native Fedimint join; tap Reconnect to try again.",
  );
  (error as Error & { chamaDiagnostics?: Record<string, unknown> }).chamaDiagnostics =
    diagnostic;
  return error;
}

function hasChamaDiagnostics(
  error: unknown,
): error is Error & { chamaDiagnostics: Record<string, unknown> } {
  return error instanceof Error && isRecord((error as any).chamaDiagnostics);
}

function isNativeBridgeUnavailable(error: unknown): boolean {
  return (
    hasChamaDiagnostics(error) &&
    error.chamaDiagnostics.issue === "native_fedimint_bridge_unavailable"
  );
}

function nativeBridgeCompatibilityError(
  baseUrl: string,
  cause: string,
): Error {
  const diagnostic = {
    issue: "native_fedimint_bridge_incompatible",
    adapter: "native-rust-sidecar",
    bridgeUrl: baseUrl,
    requiredCapabilities: REQUIRED_NATIVE_BRIDGE_CAPABILITIES,
    cause,
    interpretation:
      "A local process answered at the native Fedimint bridge URL, but it is not the current " +
      "Chama Rust bridge API. Stop the stale bridge process and start the bridge built from " +
      "this Chama release.",
  };
  const error = new Error(
    `Native Fedimint bridge at ${baseUrl} looks stale or incompatible: ${cause}. ` +
      `Stop the old bridge process, start the current Chama Rust bridge, then tap Reconnect.\n\n` +
      `Chama diagnostics:\n${JSON.stringify(diagnostic, null, 2)}`,
  );
  (error as Error & { chamaDiagnostics?: Record<string, unknown> }).chamaDiagnostics =
    diagnostic;
  return error;
}

export function isNativeBridgeModeOn(): boolean {
  // Managed deployments such as StartOS ship the bridge as part of the service.
  // This hard requirement intentionally outranks stale per-origin browser settings.
  if (isEnabledSetting(getImportEnv("VITE_CHAMA_NATIVE_BRIDGE_REQUIRED"))) return true;

  const params = getBrowserSearchParams();
  const urlFlag =
    params?.get("nativeFedimint") ??
    params?.get("native-fedimint") ??
    null;
  if (urlFlag !== null) return isEnabledSetting(urlFlag);

  const storedFlag = getLocalStorageValue(NATIVE_BRIDGE_MODE_KEY);
  if (storedFlag !== null) return isEnabledSetting(storedFlag);

  // Remote-bridge "friend wallet": a bridge URL configured in localStorage
  // opts this browser into native mode by itself — configure once (via the
  // invite link or Settings), forget. Clearing the URL restores the browser
  // SDK; an explicit stored mode flag above still wins either way.
  if (getLocalStorageValue(NATIVE_BRIDGE_URL_KEY) !== null) return true;

  const envFlag = getImportEnv("VITE_CHAMA_NATIVE_FEDIMINT");
  if (envFlag !== null) return isEnabledSetting(envFlag);

  return isCapacitorNativePlatform() || isTauriNativePlatform();
}

/** True only for the optional browser-to-remote-bridge route. Native shells
 * and managed deployments must never silently fall back to the browser SDK. */
export function isBrowserRemoteBridgeMode(): boolean {
  if (isShellManagedNativeBridge()) return false;
  if (isEnabledSetting(getImportEnv("VITE_CHAMA_NATIVE_BRIDGE_REQUIRED"))) return false;
  return getLocalStorageValue(NATIVE_BRIDGE_URL_KEY) !== null;
}

export function getNativeBridgeUrl(): string {
  const managedBridgeUrl = isEnabledSetting(getImportEnv("VITE_CHAMA_NATIVE_BRIDGE_REQUIRED"))
    ? getImportEnv("VITE_CHAMA_NATIVE_BRIDGE_URL")
    : null;
  if (managedBridgeUrl) return normalizeBaseUrl(managedBridgeUrl);

  const params = getBrowserSearchParams();
  const url =
    params?.get("nativeFedimintUrl") ??
    params?.get("native-fedimint-url") ??
    getInjectedNativeBridgeUrl() ??
    getLocalStorageValue(NATIVE_BRIDGE_URL_KEY) ??
    getImportEnv("VITE_CHAMA_NATIVE_BRIDGE_URL") ??
    DEFAULT_NATIVE_BRIDGE_URL;
  return normalizeBaseUrl(url);
}

export function getNativeBridgeToken(): string | null {
  return (
    getLocalStorageValue(NATIVE_BRIDGE_TOKEN_KEY) ??
    getImportEnv("VITE_CHAMA_NATIVE_BRIDGE_TOKEN")
  );
}

export function setNativeBridgeConfig(url: string, token: string | null): void {
  const normalized = normalizeBaseUrl(url);
  if (!normalized) return;
  setLocalStorageValue(NATIVE_BRIDGE_URL_KEY, normalized);
  try {
    if (typeof localStorage !== "undefined") {
      if (token && token.trim()) {
        localStorage.setItem(NATIVE_BRIDGE_TOKEN_KEY, token.trim());
      } else {
        localStorage.removeItem(NATIVE_BRIDGE_TOKEN_KEY);
      }
    }
  } catch {
    // Best-effort; the URL write above is the load-bearing one.
  }
}

export function clearNativeBridgeConfig(): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem(NATIVE_BRIDGE_URL_KEY);
    localStorage.removeItem(NATIVE_BRIDGE_TOKEN_KEY);
    localStorage.removeItem(NATIVE_BRIDGE_MODE_KEY);
  } catch {
    // Ignore; worst case the browser stays in remote-bridge mode.
  }
}

/**
 * Remote-bridge invite link: `https://app/#bridge=<url>&token=<t>`.
 * The config rides the URL FRAGMENT (never sent to any server, never in
 * query logs); this claims it into localStorage and strips the fragment so
 * the token doesn't linger in the address bar or get re-shared by accident.
 * Call once at boot, BEFORE anything reads the bridge config.
 * Returns true when an invite was claimed.
 */
export function claimRemoteBridgeInviteFromFragment(): boolean {
  try {
    if (typeof window === "undefined") return false;
    const rawHash = window.location.hash.replace(/^#/, "");
    if (!rawHash || !rawHash.includes("bridge=")) return false;
    const fragmentParams = new URLSearchParams(rawHash);
    const bridgeUrl = fragmentParams.get("bridge")?.trim() ?? "";
    if (!/^https?:\/\//i.test(bridgeUrl)) return false;
    const token = fragmentParams.get("token");
    setNativeBridgeConfig(bridgeUrl, token);
    try {
      window.history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search,
      );
    } catch {
      // If the strip fails the config is still claimed; the fragment is
      // client-side only, so nothing was transmitted.
    }
    return true;
  } catch {
    return false;
  }
}

export function getNativeBridgeCommunitySlug(): string {
  return getConfiguredNativeBridgeCommunitySlug() ?? DEFAULT_NATIVE_BRIDGE_COMMUNITY;
}

export function getConfiguredNativeBridgeCommunitySlug(): string | null {
  const params = getBrowserSearchParams();
  const explicitSlug =
    params?.get("nativeFedimintCommunity") ??
    params?.get("native-fedimint-community") ??
    getImportEnv("VITE_CHAMA_NATIVE_COMMUNITY");
  if (explicitSlug?.trim()) return explicitSlug.trim();

  const slug = getLocalStorageValue(NATIVE_BRIDGE_COMMUNITY_KEY);
  const trimmed = slug?.trim() ?? "";
  return trimmed ? trimmed : null;
}

export async function resetNativeBridgeWallet(baseUrl = getNativeBridgeUrl()): Promise<void> {
  const normalized = normalizeBaseUrl(baseUrl);
  await assertNativeBridgeCompatible(normalized);
  await nativeBridgeFetch<NativeResetResponse>(normalized, "/reset", {
    method: "POST",
    timeoutMs: NATIVE_BRIDGE_RESET_TIMEOUT_MS,
  });
}

async function assertNativeBridgeCompatible(baseUrl: string): Promise<NativeHealthResponse> {
  let health: NativeHealthResponse;
  try {
    health = await nativeBridgeFetch<NativeHealthResponse>(baseUrl, "/health", {
      timeoutMs: NATIVE_BRIDGE_HEALTH_TIMEOUT_MS,
    });
  } catch (error) {
    if (hasChamaDiagnostics(error) || isNativeBridgeAuthFailure(error)) throw error;
    throw nativeBridgeCompatibilityError(baseUrl, asErrorMessage(error));
  }

  if (!health.ok) {
    throw nativeBridgeCompatibilityError(baseUrl, "health check returned ok=false");
  }

  const capabilities = new Set((health.capabilities ?? []).map((value) => String(value)));
  const missing = REQUIRED_NATIVE_BRIDGE_CAPABILITIES.filter((capability) =>
    !capabilities.has(capability)
  );
  if (missing.length > 0) {
    throw nativeBridgeCompatibilityError(
      baseUrl,
      `missing bridge capability: ${missing.join(", ")}`,
    );
  }
  return health;
}

async function nativeBridgeFetch<T>(
  baseUrl: string,
  path: string,
  init: NativeBridgeFetchInit = {},
): Promise<T> {
  const {
    body: jsonBody,
    headers: rawHeaders,
    timeoutMs,
    signal: callerSignal,
    ...rest
  } = init;
  const headers = new Headers(rawHeaders);
  // Remote-bridge auth: every bridge request funnels through here, so this
  // one line covers the whole wallet surface. Token-less local bridges
  // (Tauri/Android sidecars) send no header — unchanged.
  const token = getNativeBridgeToken();
  if (token && !headers.has("authorization")) {
    headers.set("authorization", `Bearer ${token}`);
  }
  const requestInit: RequestInit = { ...rest, headers };
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let controller: AbortController | null = null;
  let removeCallerAbort: (() => void) | null = null;

  if (timeoutMs !== undefined && timeoutMs > 0) {
    controller = new AbortController();
    if (callerSignal?.aborted) {
      controller.abort();
    } else if (callerSignal) {
      const onAbort = () => controller?.abort();
      callerSignal.addEventListener("abort", onAbort, { once: true });
      removeCallerAbort = () => callerSignal.removeEventListener("abort", onAbort);
    }
    timeoutId = setTimeout(() => controller?.abort(), timeoutMs);
    requestInit.signal = controller.signal;
  } else if (callerSignal) {
    requestInit.signal = callerSignal;
  }

  if (jsonBody !== undefined) {
    headers.set("content-type", "application/json");
    requestInit.body = JSON.stringify(jsonBody);
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, requestInit);
  } catch (error) {
    if (controller?.signal.aborted && timeoutMs !== undefined && timeoutMs > 0) {
      throw markBridgeTransportFailure(nativeBridgeTimeoutError(baseUrl, path, timeoutMs));
    }
    throw markBridgeTransportFailure(nativeBridgeUnavailableError(baseUrl, path, error));
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
    removeCallerAbort?.();
  }
  const text = await response.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      // Not the bridge's JSON — almost always a reverse proxy's own HTML error
      // page (StartOS fronts the bridge with nginx). Transport, not a verdict.
      throw markBridgeTransportFailure(new Error(
        `Native Fedimint bridge ${path} returned non-JSON response: ${text.slice(0, 160)}`,
      ));
    }
  }

  if (!response.ok) {
    const bridgeMessage =
      isRecord(json) && typeof json.error === "string"
        ? json.error
        : text || response.statusText;
    const failure = new Error(
      `Native Fedimint bridge ${path} failed (${response.status}): ${bridgeMessage}`,
    );
    if (response.status === 401) throw markBridgeAuthFailure(failure);
    throw isProxyGatewayStatus(response.status)
      ? markBridgeTransportFailure(failure)
      : failure;
  }

  return json as T;
}

export class NativeBridgeWallet implements IFedimintWallet {
  private readonly baseUrl: string;
  private openState = false;
  private federationId: string | null = null;
  private inviteCode: string | null = null;
  private lastBalanceMsats = 0;
  private balanceSubscribers = new Set<(balance: number) => void>();
  private balancePoll: ReturnType<typeof setInterval> | null = null;

  constructor(baseUrl = getNativeBridgeUrl()) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  async open(): Promise<void> {
    const health = await assertNativeBridgeCompatible(this.baseUrl);
    // A fresh native client has no database to open yet. Avoid asking `/info`
    // to construct/open a Fedimint client solely to rediscover that fact;
    // Start9 field logs show that cold path can terminate the bridge worker.
    // FedimintClient.init() will proceed to the normal `/join` path.
    if (health.joined === false) {
      this.openState = false;
      this.federationId = null;
      return;
    }
    const info = await this.request<NativeInfoResponse>("/info", {
      timeoutMs: NATIVE_BRIDGE_INFO_TIMEOUT_MS,
    });
    this.applyInfo(info);
    this.loadCachedInvite();
  }

  isOpen(): boolean {
    return this.openState;
  }

  async joinFederation(inviteCode: string): Promise<void> {
    await assertNativeBridgeCompatible(this.baseUrl);
    let joined: NativeJoinResponse | null = null;
    let lastJoinError: unknown = null;

    for (let attempt = 0; attempt < NATIVE_BRIDGE_JOIN_RETRY_DELAYS_MS.length; attempt++) {
      const delayMs = NATIVE_BRIDGE_JOIN_RETRY_DELAYS_MS[attempt] ?? 0;
      if (delayMs > 0) await sleepMs(delayMs);

      try {
        joined = await this.request<NativeJoinResponse>("/join", {
          method: "POST",
          body: { inviteCode },
          timeoutMs: NATIVE_BRIDGE_JOIN_TIMEOUT_MS,
        });
        break;
      } catch (error) {
        lastJoinError = error;
        if (!isNativeJoinDiscoveryError(error)) {
          throw error;
        }
        if (attempt < NATIVE_BRIDGE_JOIN_RETRY_DELAYS_MS.length - 1) {
          console.warn(
            `[chama] Couldn't reach native federation yet; retrying join (${attempt + 2}/${NATIVE_BRIDGE_JOIN_RETRY_DELAYS_MS.length})`,
            error,
          );
        }
      }
    }

    if (!joined) {
      throw nativeBridgeJoinDiscoveryError(
        this.baseUrl,
        lastJoinError,
        NATIVE_BRIDGE_JOIN_RETRY_DELAYS_MS.length,
      );
    }

    this.openState = true;
    this.federationId = joined.federation_id;
    this.rememberInviteCode(joined.joined || inviteCode);
    await this.refreshBalance();
  }

  async switchFederationPreserving(inviteCode: string): Promise<void> {
    await assertNativeBridgeCompatible(this.baseUrl);
    const joined = await this.request<NativeJoinResponse>("/switch", {
      method: "POST",
      body: { inviteCode },
      timeoutMs: NATIVE_BRIDGE_JOIN_TIMEOUT_MS,
    });
    this.openState = true;
    this.federationId = joined.federation_id;
    this.rememberInviteCode(joined.joined || inviteCode);
    await this.refreshBalance();
  }

  rememberInviteCode(inviteCode: string): void {
    const trimmed = inviteCode.trim();
    if (!trimmed) return;
    this.inviteCode = trimmed;
    if (this.federationId) {
      setLocalStorageValue(inviteStorageKey(this.baseUrl, this.federationId), trimmed);
    }
  }

  recovery = {
    hasPendingRecoveries: async (): Promise<boolean> => false,
    waitForAllRecoveries: async (): Promise<void> => {},
  };

  balance = {
    getBalance: async (): Promise<number> => this.refreshBalance(),
    subscribeBalance: (callback: (balance: number) => void): (() => void) =>
      this.subscribeBalance(callback),
  };

  mint = {
    spendNotes: async (
      amountMsats: number,
      _meta?: ChamaOperationMeta,
      includeInvite = false,
    ): Promise<string> => {
      await this.ensureBridgeReady();
      const result = await this.request<NativeSpendNotesResponse>("/spend-notes", {
        method: "POST",
        body: {
          amountMsats,
          allowOverpay: false,
          includeInvite,
        },
      });
      await this.refreshBalance().catch((error) => {
        console.warn("[chama] native bridge balance refresh after spend failed:", error);
      });
      return result.notes;
    },

    // #37 lock crash-safety: lock spends pass an explicit long
    // try_cancel horizon (the bridge default is 7 days — shorter than a
    // disputed trade's life) and surface the spend operation id for the
    // pending-native-locks stash.
    spendNotesDetailed: async (
      amountMsats: number,
      opts: { tryCancelAfterSecs?: number; includeInvite?: boolean },
      _meta?: ChamaOperationMeta,
    ): Promise<{ notes: string; operationId?: string }> => {
      await this.ensureBridgeReady();
      const result = await this.request<NativeSpendNotesResponse>("/spend-notes", {
        method: "POST",
        body: {
          amountMsats,
          allowOverpay: false,
          ...(typeof opts.tryCancelAfterSecs === "number"
            ? { timeoutSecs: Math.floor(opts.tryCancelAfterSecs) }
            : {}),
          includeInvite: opts.includeInvite ?? false,
        },
      });
      // Fire-and-forget: the notes must reach the caller's crash guard with
      // ZERO additional awaits after the spend resolves (#37, F12). The 3s
      // /info poll keeps subscribers fresh anyway.
      void this.refreshBalance().catch((error) => {
        console.warn("[chama] native bridge balance refresh after spend failed:", error);
      });
      // Diagnostics-only field — read directly (readOperationId synthesizes
      // a fake `native-<ts>` fallback we must not persist in the stash).
      const rawOperationId = result.operation_id ?? result.operationId;
      return {
        notes: result.notes,
        operationId: rawOperationId ? String(rawOperationId) : undefined,
      };
    },

    redeemEcash: async (
      oobNotes: string,
      _meta?: ChamaOperationMeta,
    ): Promise<string> => {
      await this.ensureBridgeReady();
      const result = await this.request<NativeReissueNotesResponse>("/reissue-notes", {
        method: "POST",
        body: {
          notes: oobNotes,
          wait: true,
        },
      });
      const operationId = readOperationId(result);
      if (result.status.toLowerCase() !== "done") {
        const pending: Error & { code?: string; operationId?: string } = new Error(
          "The federation accepted the ecash reissue operation, but it is still pending. " +
            "The bearer note remains safely stashed and Chama will resume this same operation.",
        );
        pending.code = "MINT_REISSUE_PENDING";
        pending.operationId = operationId;
        throw pending;
      }
      await this.refreshBalance().catch((error) => {
        console.warn("[chama] native bridge balance refresh after reissue failed:", error);
      });
      return operationId;
    },

    parseNotes: async (oobNotes: string): Promise<{
      total_amount: number;
      federation_id?: string;
      federation_invite?: string;
    }> => {
      const result = await this.request<NativeParseNotesResponse>("/parse-notes", {
        method: "POST",
        body: { notes: oobNotes },
      });
      const invite = isRecord(result.notes_json)
        && typeof result.notes_json.invite === "string"
        ? result.notes_json.invite
        : undefined;
      return {
        total_amount: result.total_amount_msat,
        federation_id: expectedFederationIdForInvite(invite) ?? undefined,
        federation_invite: invite,
      };
    },
  };

  lightning = {
    createInvoice: async (
      amountMsats: number,
      description: string,
      onReceiveState?: (kind: LnReceiveStateKind) => void,
      _meta?: ChamaOperationMeta,
    ): Promise<{ invoice: string; operationId: string; gateway?: InvoiceGatewayInfo }> => {
      onReceiveState?.("created");
      await this.ensureBridgeReady();
      const result = await this.request<NativeInvoiceResponse>("/invoice", {
        method: "POST",
        body: {
          amountMsats,
          description,
        },
      });
      const operationId = readOperationId(result);
      if (result.gateway_id) {
        // Which Lightning route the payer is being asked to use. Before this,
        // the only way to find out was to decode the BOLT11 and match its route
        // hint against the gateway list by hand. `provenPayable=false` means the
        // gateway answers its API but nothing has ever settled through it —
        // exactly the state that produces "no route" for the payer.
        console.info(
          `[chama] funding invoice minted via gateway ${result.gateway_alias ?? "(unnamed)"} ` +
            `(${result.gateway_id.slice(0, 16)}… ${result.gateway_api ?? "no api"}) ` +
            `provenPayable=${result.gateway_proven_payable === true}`,
        );
      }
      onReceiveState?.("waiting_for_payment");
      void this.awaitInvoice(operationId, onReceiveState);
      return {
        invoice: result.invoice,
        operationId,
        gateway: result.gateway_id
          ? {
              id: result.gateway_id,
              alias: result.gateway_alias,
              api: result.gateway_api,
              provenPayable: result.gateway_proven_payable === true,
            }
          : undefined,
      };
    },

    payInvoice: async (
      bolt11: string,
      meta?: ChamaOperationMeta,
    ): Promise<{ operationId: string }> => {
      await this.ensureBridgeReady();
      const amountMsats = typeof meta?.chama_amount_msats === "number"
        ? Math.floor(meta.chama_amount_msats)
        : undefined;
      const shouldSendAmount = !!amountMsats && amountMsats > 0 && !hasBolt11Amount(bolt11);
      let result: NativePayResponse;
      try {
        result = await this.request<NativePayResponse>("/pay", {
          method: "POST",
          body: {
            paymentInfo: bolt11,
            ...(shouldSendAmount ? { amountMsats } : {}),
            noWait: false,
            // V7: the bridge stamps this into the payment's fedimint
            // operation-log entry (extra_meta) — the durable op↔escrow map
            // /pay-outcome-by-escrow reconciles against after a crash that
            // lost the operationId. Old bridge binaries ignore unknown
            // fields, so this is back-compatible.
            ...(meta ? { extraMeta: meta } : {}),
          },
        });
      } catch (error) {
        // #9 Part 3: the bridge commits the outgoing contract BEFORE it returns,
        // so a LOST /pay response is ambiguous — the payment may already be in
        // flight. A transport failure (bridge killed/restarted mid-send, socket
        // dropped) carries chamaDiagnostics and MUST map to INFLIGHT so the claim
        // guard journals it and refuses to re-pay (no double-send). A bridge that
        // RESPONDED with an error (non-2xx, no chamaDiagnostics) is always a
        // pre-send failure here — nothing was committed — so it stays a re-payable
        // throw. ("kill the await after send" must not double-pay.)
        if (hasChamaDiagnostics(error)) {
          throw codedPayError(
            "Lightning payout was sent to the bridge but the response was lost — it may be in flight. Not retrying to avoid a double payment; it will reconcile.",
            LN_PAY_INFLIGHT,
          );
        }
        throw error;
      }
      await this.refreshBalance().catch((error) => {
        console.warn("[chama] native bridge balance refresh after LN pay failed:", error);
      });
      const operationId = readOperationId(result);
      // #9 Part 3: discriminate the bridge's outcome so the claim guard can tell
      // a successful payout from a refund (sats back, safe to re-pay) from an
      // ambiguous submitted-but-unknown one (NEVER blindly re-pay). A pre-send
      // failure never reaches here — it throws in `request()` on a non-2xx and is
      // treated as safe-to-retry. Only a confirmed `settled` resolves.
      if (result.status === "settled") {
        return { operationId };
      }
      if (result.status === "refunded") {
        // The outgoing contract was refunded — the sats are back in the wallet,
        // so a fresh pay is correct (not a double-send).
        throw codedPayError(
          result.error || "Lightning payment was refunded — your sats are back in your wallet.",
          LN_PAY_REFUNDED,
          operationId,
        );
      }
      // `inflight` (or any unrecognized/legacy status): the payment was submitted
      // but its outcome is unknown. unknown ⇒ INFLIGHT so the claim guard journals
      // it `submitted` and re-attaches via `awaitPayOutcome` instead of re-paying.
      throw codedPayError(
        "Lightning payment was submitted but hasn't confirmed yet. Your sats are still in your Chama wallet if it refunds.",
        LN_PAY_INFLIGHT,
        operationId,
      );
    },

    // #9 Part 3 double-pay guard: re-attach to a previously-submitted payout via
    // the bridge's /pay-outcome reconcile endpoint and report its TRUE terminal
    // outcome, without ever paying again. "settled" (preimage), "refunded"
    // (confirmed ⇒ retry-safe), or "unknown" (still in flight / unresolved ⇒ keep
    // the submitted record, do not re-pay).
    awaitPayOutcome: async (
      operationId: string,
    ): Promise<"settled" | "refunded" | "unknown"> => {
      await this.ensureBridgeReady();
      let result: NativePayResponse;
      try {
        result = await this.request<NativePayResponse>("/pay-outcome", {
          method: "POST",
          body: { operationId },
        });
      } catch (error) {
        // Reconcile failed/unreachable ⇒ unknown (refuse re-pay).
        console.warn("[chama] native bridge /pay-outcome reconcile failed:", error);
        return "unknown";
      }
      if (result.status === "settled") return "settled";
      if (result.status === "refunded") return "refunded";
      return "unknown";
    },

    // V7 reconcile-by-escrow: resolve the payment(s) the bridge ever
    // dispatched for this escrow via the op log's chama_escrow_id stamp.
    // Any transport error, non-2xx, OR an old bridge binary without the
    // route ⇒ "unknown" (refuse re-pay now; the boot sweep retries later).
    payOutcomeByEscrow: async (
      escrowId: string,
      sinceMs?: number,
    ): Promise<PayOutcomeByEscrowResult> => {
      await this.ensureBridgeReady();
      let result: NativePayOutcomeByEscrowResponse;
      try {
        result = await this.request<NativePayOutcomeByEscrowResponse>(
          "/pay-outcome-by-escrow",
          {
            method: "POST",
            body: { escrowId, ...(sinceMs !== undefined ? { sinceMs } : {}) },
          },
        );
      } catch (error) {
        console.warn("[chama] native bridge /pay-outcome-by-escrow reconcile failed:", error);
        return { outcome: "unknown" };
      }
      const operationId = typeof result.operation_id === "string"
        ? result.operation_id
        : typeof result.operationId === "string" ? result.operationId : undefined;
      if (result.status === "settled") return { outcome: "settled", operationId };
      if (result.status === "refunded") return { outcome: "refunded", operationId };
      if (result.status === "inflight") return { outcome: "inflight", operationId };
      if (result.status === "none") return { outcome: "none" };
      return { outcome: "unknown" };
    },
  };

  onchain = {
    getInfo: async (): Promise<OnchainInfo> => {
      const result = await this.request<NativeOnchainInfoResponse>("/onchain/info");
      return {
        network: result.network,
        finalityDelay: readRequiredNumber(
          result.finality_delay ?? result.finalityDelay,
          "finalityDelay",
          "/onchain/info",
        ),
        pegInFeeSats: readRequiredNumber(
          result.peg_in_fee_sats ?? result.pegInFeeSats,
          "pegInFeeSats",
          "/onchain/info",
        ),
        pegOutFeeSats: readRequiredNumber(
          result.peg_out_fee_sats ?? result.pegOutFeeSats,
          "pegOutFeeSats",
          "/onchain/info",
        ),
        minimumDepositSats: readRequiredNumber(
          result.minimum_deposit_sats ?? result.minimumDepositSats,
          "minimumDepositSats",
          "/onchain/info",
        ),
      };
    },

    createDepositAddress: async (
      _meta?: ChamaOperationMeta,
    ): Promise<OnchainDepositAddress> => {
      const result = await this.request<NativeOnchainDepositAddressResponse>(
        "/onchain/deposit-address",
        { method: "POST" },
      );
      return {
        operationId: readOperationId(result),
        address: result.address,
        tweakIdx: result.tweak_idx ?? result.tweakIdx,
        finalityDelay: readRequiredNumber(
          result.finality_delay ?? result.finalityDelay,
          "finalityDelay",
          "/onchain/deposit-address",
        ),
      };
    },

    awaitDeposit: async (operationId: string): Promise<OnchainDepositSettled> => {
      const result = await this.request<NativeOnchainDepositSettledResponse>(
        "/onchain/await-deposit",
        {
          method: "POST",
          body: { operationId },
        },
      );
      if (result.info) this.applyInfo(result.info);
      else await this.refreshBalance();
      return {
        status: result.status,
        operationId: readOperationId(result),
        amountSats: result.amount_sats ?? result.amountSats,
        outpoint: result.outpoint,
      };
    },

    getWithdrawFees: async (
      address: string,
      amountSats: number,
    ): Promise<OnchainWithdrawFees> => {
      const result = await this.request<NativeOnchainWithdrawFeesResponse>(
        "/onchain/withdraw-fees",
        {
          method: "POST",
          body: { address, amountSats },
        },
      );
      return {
        amountSats: readRequiredNumber(
          result.amount_sats ?? result.amountSats,
          "amountSats",
          "/onchain/withdraw-fees",
        ),
        feesSats: readRequiredNumber(
          result.fees_sats ?? result.feesSats,
          "feesSats",
          "/onchain/withdraw-fees",
        ),
        totalSats: readRequiredNumber(
          result.total_sats ?? result.totalSats,
          "totalSats",
          "/onchain/withdraw-fees",
        ),
      };
    },

    withdraw: async (
      address: string,
      amountSats: number,
      options?: { wait?: boolean; meta?: ChamaOperationMeta },
    ): Promise<OnchainWithdrawResult> => {
      await this.ensureBridgeReady();
      const result = await this.request<NativeOnchainWithdrawResponse>(
        "/onchain/withdraw",
        {
          method: "POST",
          body: {
            address,
            amountSats,
            noWait: options?.wait === false,
          },
        },
      );
      await this.refreshBalance().catch((error) => {
        console.warn("[chama] native bridge balance refresh after onchain withdraw failed:", error);
      });
      return {
        operationId: readOperationId(result),
        status: result.status,
        txid: result.txid || undefined,
        feesSats: readRequiredNumber(
          result.fees_sats ?? result.feesSats,
          "feesSats",
          "/onchain/withdraw",
        ),
      };
    },
  };

  federation = {
    getFederationId: async (): Promise<string> => {
      if (this.federationId) return this.federationId;
      const info = await this.request<NativeInfoResponse>("/info", {
        timeoutMs: NATIVE_BRIDGE_INFO_TIMEOUT_MS,
      });
      this.applyInfo(info);
      return info.federation_id;
    },

    getInviteCode: async (): Promise<string> => {
      if (this.inviteCode) return this.inviteCode;
      this.loadCachedInvite();
      if (this.inviteCode) return this.inviteCode;
      throw new Error(
        "Native Fedimint bridge has no cached invite code for this federation yet",
      );
    },
  };

  async cleanup(): Promise<void> {
    if (this.balancePoll !== null) {
      clearInterval(this.balancePoll);
      this.balancePoll = null;
    }
    this.balanceSubscribers.clear();
    this.openState = false;
  }

  private request<T>(path: string, init: NativeBridgeFetchInit = {}): Promise<T> {
    return nativeBridgeFetch<T>(this.baseUrl, path, init);
  }

  private async ensureBridgeReady(): Promise<void> {
    if (!isShellManagedNativeBridge()) return;

    let lastError: unknown = null;

    for (const delayMs of NATIVE_BRIDGE_READY_RETRY_DELAYS_MS) {
      if (delayMs > 0) await sleepMs(delayMs);
      try {
        await assertNativeBridgeCompatible(this.baseUrl);
        return;
      } catch (error) {
        lastError = error;
        if (!isNativeBridgeUnavailable(error)) {
          throw error;
        }
      }
    }

    throw lastError;
  }

  private applyInfo(info: NativeInfoResponse): void {
    this.openState = true;
    this.federationId = info.federation_id;
    this.setBalance(info.total_amount_msat);
  }

  private loadCachedInvite(): void {
    if (!this.federationId) return;
    const cached = getLocalStorageValue(inviteStorageKey(this.baseUrl, this.federationId));
    if (cached) this.inviteCode = cached;
  }

  private async refreshBalance(): Promise<number> {
    const info = await this.request<NativeInfoResponse>("/info", {
      timeoutMs: NATIVE_BRIDGE_INFO_TIMEOUT_MS,
    });
    this.applyInfo(info);
    return info.total_amount_msat;
  }

  private subscribeBalance(callback: (balance: number) => void): () => void {
    this.balanceSubscribers.add(callback);
    callback(this.lastBalanceMsats);
    void this.refreshBalance()
      .then((balance) => callback(balance))
      .catch((error) => {
        console.warn("[chama] native bridge initial balance refresh failed:", error);
      });
    this.ensureBalancePolling();

    return () => {
      this.balanceSubscribers.delete(callback);
      if (this.balanceSubscribers.size === 0 && this.balancePoll !== null) {
        clearInterval(this.balancePoll);
        this.balancePoll = null;
      }
    };
  }

  private ensureBalancePolling(): void {
    if (this.balancePoll !== null) return;
    this.balancePoll = setInterval(() => {
      void this.refreshBalance().catch((error) => {
        console.warn("[chama] native bridge balance poll failed:", error);
      });
    }, 3000);
  }

  private setBalance(balance: number): void {
    const changed = balance !== this.lastBalanceMsats;
    this.lastBalanceMsats = balance;
    if (!changed) return;
    for (const callback of [...this.balanceSubscribers]) {
      try {
        callback(balance);
      } catch (error) {
        console.warn("[chama] native bridge balance subscriber failed:", error);
      }
    }
  }

  private async awaitInvoice(
    operationId: string,
    onReceiveState?: (kind: LnReceiveStateKind) => void,
  ): Promise<void> {
    // `/await-invoice` is a long poll: the bridge holds the request open until
    // the invoice is claimed or canceled, however long the payer takes. Anything
    // in front of the bridge that enforces its own read timeout (StartOS runs
    // nginx there) will hang up mid-wait and answer with its own error page.
    //
    // That hangup says NOTHING about the invoice — it is still live and still
    // payable. Reporting it as `canceled` made the funding orchestrator declare
    // "Federation didn't accept the payment" and tell the user not to pay, for a
    // payment the federation had never even been asked about. So a transport
    // failure re-arms the watch instead; only a verdict from the bridge itself
    // can cancel.
    const startedAt = Date.now();
    let backoffMs = AWAIT_INVOICE_REARM_BASE_MS;
    // Watch for the wallet being closed *after* this started, rather than
    // requiring it to look open now: the flag is set by open/join, and a watch
    // must not silently give up just because it can't confirm that here.
    const openedWhenWatchBegan = this.openState;

    for (;;) {
      try {
        const result = await this.request<NativeAwaitInvoiceResponse>("/await-invoice", {
          method: "POST",
          body: { operationId, waitSecs: AWAIT_INVOICE_WAIT_SECS },
        });

        if (result.status === "pending") {
          // The bridge ended its own watch window with no outcome. Not a
          // failure and not a verdict — the invoice is still live, so ask
          // again straight away. Only a bridge advertising
          // `bounded_await_invoice` answers this way.
          if (Date.now() - startedAt >= AWAIT_INVOICE_REARM_WINDOW_MS) {
            console.warn(
              `[chama] native bridge invoice ${operationId}: still unpaid after ` +
                `${Math.round((Date.now() - startedAt) / 60_000)}m — stopping the watch; ` +
                `invoice may still be payable, leaving detection to balance polling`,
            );
            return;
          }
          backoffMs = AWAIT_INVOICE_REARM_BASE_MS;
          continue;
        }

        if (result.info) this.applyInfo(result.info);
        else await this.refreshBalance();
        onReceiveState?.("claimed");
        return;
      } catch (error) {
        if (!isBridgeTransportFailure(error)) {
          // The bridge answered and said no (canceled/expired invoice, unknown
          // operation). That is a real verdict — surface it as before.
          const reason = asErrorMessage(error);
          onReceiveState?.({ canceled: { reason } });
          console.warn(`[chama] native bridge invoice ${operationId} watcher failed:`, error);
          return;
        }

        // Wallet closed underneath us — stop quietly, nothing to report.
        if (openedWhenWatchBegan && !this.openState) return;

        if (Date.now() - startedAt >= AWAIT_INVOICE_REARM_WINDOW_MS) {
          // Give up watching, but still DON'T claim a cancellation we can't
          // prove. Balance polling in the funding orchestrator remains the
          // independent detector, so a payment that lands later is still seen.
          console.warn(
            `[chama] native bridge invoice ${operationId}: stopped re-arming the watch after ` +
              `${Math.round((Date.now() - startedAt) / 60_000)}m of transport failures — ` +
              `invoice may still be payable; leaving detection to balance polling`,
            error,
          );
          return;
        }

        console.debug(
          `[chama] native bridge invoice ${operationId}: watch connection dropped ` +
            `(${asErrorMessage(error)}); re-arming in ${backoffMs}ms`,
        );
        await sleepMs(backoffMs);
        backoffMs = Math.min(backoffMs * 2, AWAIT_INVOICE_REARM_MAX_MS);
      }
    }
  }
}

export function createNativeBridgeWallet(baseUrl = getNativeBridgeUrl()): IFedimintWallet {
  return new NativeBridgeWallet(baseUrl);
}
