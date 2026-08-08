use std::collections::{BTreeMap, HashMap};
use std::io::ErrorKind;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use axum::extract::{Query, State};
use axum::http::{
    header::{AUTHORIZATION, HOST, ORIGIN},
    HeaderValue, Method, StatusCode,
};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use clap::{Parser, Subcommand};
use fedimint_bip39::{Bip39RootSecretStrategy, Mnemonic};
use fedimint_client::module_init::ClientModuleInitRegistry;
use fedimint_client::secret::RootSecretStrategy;
use fedimint_client::{Client, ClientBuilder, ClientHandleArc, RootSecret};
use fedimint_connectors::ConnectorRegistry;
use fedimint_core::Amount;
use fedimint_core::bitcoin::address::NetworkUnchecked;
use fedimint_core::bitcoin::{Address as BitcoinAddress, Amount as BitcoinAmount};
use fedimint_core::core::OperationId;
use fedimint_core::db::Database;
use fedimint_core::invite_code::InviteCode;
use fedimint_core::secp256k1::PublicKey;
use fedimint_core::util::SafeUrl;
use fedimint_ln_client::common::LightningGateway;
use fedimint_ln_client::{
    InternalPayState, LightningClientInit, LightningClientModule, LightningOperationMeta,
    LightningOperationMetaVariant, LnPayState, LnReceiveState, OutgoingLightningPayment, PayType,
};
use fedimint_meta_client::MetaClientInit;
use fedimint_mint_client::{
    MintClientInit, MintClientModule, OOBNotes, ReissueExternalNotesState,
    SelectNotesWithAtleastAmount, SelectNotesWithExactAmount,
};
use fedimint_wallet_client::client_db::TweakIdx;
use fedimint_wallet_client::{DepositStateV2, WalletClientInit, WalletClientModule, WithdrawState};
use futures::StreamExt;
use lightning_invoice::{Bolt11InvoiceDescription, Description};
use rand::thread_rng;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::Mutex;
use tower_http::cors::{Any, CorsLayer};

const FEDERATION_OPEN_TIMEOUT: Duration = Duration::from_secs(30);
const FEDERATION_JOIN_TIMEOUT: Duration = Duration::from_secs(90);
const GATEWAY_CACHE_REFRESH_TIMEOUT: Duration = Duration::from_secs(8);
const GATEWAY_SELECT_TIMEOUT: Duration = Duration::from_secs(12);
/// Bounded wait for an outgoing payment to reach a terminal state before the
/// `/pay` (and reconcile) handler returns. A timeout here is NOT a failure — the
/// HTLC may still settle — so it maps to an `inflight` outcome (the caller
/// journals the payout `submitted` and reconciles), never to a re-payable error.
/// Matches the browser SDK's 60s pay-watch window so native behaves the same.
const PAY_AWAIT_TIMEOUT: Duration = Duration::from_secs(60);
/// Short per-gateway reachability probe used when auto-selecting a receive
/// gateway. Kept well under `GATEWAY_SELECT_TIMEOUT` so several gateways can be
/// tried in turn within the same budget — a single dead (e.g. `iroh://`)
/// gateway is dropped after this instead of stalling the whole selection. See
/// board #9: Fedimint's blind `select_available_gateway(None)` `join_all`s over
/// every gateway and waits for the slowest, so one unreachable gateway burns
/// the entire `GATEWAY_SELECT_TIMEOUT` before the reachable ones are reached.
const GATEWAY_PROBE_TIMEOUT: Duration = Duration::from_secs(4);

/// n0's public PKARR relay, resolved over HTTPS. Native (non-wasm) Fedimint
/// clients otherwise discover guardians only via DNS queries (:53) and the
/// mainline DHT (UDP) — both of which mobile/CGNAT networks routinely throttle
/// or block, which is why a fresh join hangs on real phones while the browser
/// (whose wasm `PkarrResolver::n0_dns()` resolves these same guardians over this
/// exact HTTPS relay) succeeds. Passing this through `set_iroh_dns` ADDS an
/// HTTPS PkarrResolver on top of the existing DNS + DHT discovery — it does not
/// replace them (verified in fedimint-connectors-0.11.1/src/iroh.rs) — so every
/// federation whose guardians publish to the default n0 relay resolves and
/// federation switching stays intact. Override via --iroh-dns /
/// CHAMA_FEDIMINT_IROH_DNS to point at Chama-owned discovery infra later.
const DEFAULT_IROH_PKARR_RELAY: &str = "https://dns.iroh.link/pkarr";
const ARBITER_FEDERATION_ROUTES_FILE: &str = "arbiter-federations-v1.json";
const ARBITER_FEDERATION_DIR: &str = "arbiter-federations";

/// How long the boot-time discovery readiness probe waits for a TCP connection
/// to the configured PKARR resolver. Short on purpose: it only sanity-checks
/// that the device's network can reach the HTTPS discovery relay at all
/// (DNS + :443), surfacing "degraded" in /health before a fresh join silently
/// times out — it is not a full guardian round-trip.
const DISCOVERY_PROBE_TIMEOUT: Duration = Duration::from_secs(4);

#[derive(Debug, Parser)]
#[command(name = "chama-fedimint-bridge")]
#[command(about = "Native Fedimint harness for Chama federation tests")]
struct Cli {
    /// Directory containing the Fedimint client database.
    #[arg(long, env = "CHAMA_FEDIMINT_DATA_DIR")]
    data_dir: PathBuf,

    /// Enable Iroh DHT/PKARR discovery. This is on by default because public
    /// iroh federations often need it.
    #[arg(long, default_value_t = true)]
    iroh_enable_dht: bool,

    /// Enable Fedimint's parallel next-generation Iroh stack.
    #[arg(long, default_value_t = true)]
    iroh_enable_next: bool,

    /// iROH PKARR resolver URL, resolved over HTTPS. When unset, defaults to
    /// n0's public relay (DEFAULT_IROH_PKARR_RELAY) so native clients get the
    /// same HTTPS guardian discovery the browser uses; pass a URL to point at
    /// Chama-owned discovery infra instead.
    #[arg(long, env = "CHAMA_FEDIMINT_IROH_DNS")]
    iroh_dns: Option<SafeUrl>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Join a federation using a fed1 invite code.
    Join { invite_code: String },

    /// Print federation id, network, metadata, and balance.
    Info,

    /// Fetch and print registered Lightning gateways.
    ListGateways {
        /// Use the cached gateway list without fetching from guardians.
        #[arg(long, default_value_t = false)]
        no_update: bool,
    },

    /// Fetch gateways and verify gateway API reachability.
    ProbeGateways,

    /// Create a BOLT11 invoice through the federation's LN module.
    Invoice {
        #[arg(long)]
        amount_msats: u64,

        #[arg(long, default_value = "Chama Fedimint native test")]
        description: String,

        #[arg(long)]
        expiry_time: Option<u64>,

        #[arg(long)]
        gateway_id: Option<PublicKey>,

        #[arg(long, default_value_t = false)]
        force_internal: bool,
    },

    /// Wait for a previously-created incoming invoice to settle.
    AwaitInvoice { operation_id: OperationId },

    /// Reconcile a previously-submitted outgoing payment by operation id
    /// (settled / refunded / inflight) without re-sending it.
    PayOutcome { operation_id: OperationId },

    /// Pay a BOLT11 invoice or LNURL through a gateway.
    Pay {
        payment_info: String,

        #[arg(long)]
        amount_msats: Option<u64>,

        #[arg(long)]
        lnurl_comment: Option<String>,

        #[arg(long)]
        gateway_id: Option<PublicKey>,

        #[arg(long, default_value_t = false)]
        force_internal: bool,

        #[arg(long, default_value_t = false)]
        no_wait: bool,
    },

    /// Spend local balance into out-of-band Fedimint e-cash notes.
    SpendNotes {
        #[arg(long)]
        amount_msats: u64,

        #[arg(long, default_value_t = false)]
        allow_overpay: bool,

        #[arg(long, default_value_t = 60 * 60 * 24 * 7)]
        timeout_secs: u64,

        #[arg(long, default_value_t = false)]
        include_invite: bool,
    },

    /// Redeem/reissue out-of-band Fedimint e-cash notes into this wallet.
    ReissueNotes {
        notes: String,

        #[arg(long, default_value_t = false)]
        no_wait: bool,
    },

    /// Parse out-of-band Fedimint e-cash notes without redeeming them.
    ParseNotes { notes: String },

    /// Print native Fedimint wallet-module on-chain settings.
    OnchainInfo,

    /// Allocate a native Fedimint on-chain peg-in address.
    OnchainDepositAddress,

    /// Wait for a native Fedimint on-chain peg-in to be claimed by the mint.
    AwaitOnchainDeposit { operation_id: OperationId },

    /// Fetch native Fedimint peg-out fees for an on-chain address.
    OnchainWithdrawFees {
        #[arg(long)]
        address: String,

        #[arg(long)]
        amount_sats: u64,
    },

    /// Withdraw ecash balance to an on-chain bitcoin address.
    OnchainWithdraw {
        #[arg(long)]
        address: String,

        #[arg(long)]
        amount_sats: u64,

        #[arg(long, default_value_t = false)]
        no_wait: bool,
    },

    /// Run a localhost JSON API around the native wallet.
    Serve {
        #[arg(long, default_value = "127.0.0.1:8787")]
        bind: SocketAddr,

        #[arg(long)]
        invite_code: Option<String>,

        /// Require `Authorization: Bearer <token>` on EVERY route, /health
        /// included (it leaks federation/gateway info). Required for every
        /// bind, including loopback: an untrusted local process or webpage
        /// must never inherit wallet authority merely by reaching the port.
        #[arg(long, env = "CHAMA_BRIDGE_AUTH_TOKEN")]
        auth_token: String,

        /// Exact origin allowed by CORS (repeatable, or comma-separated via
        /// the env var). When set, replaces the permissive `Any` origin —
        /// must include the app origin(s) that will call this bridge.
        #[arg(
            long = "allowed-origin",
            env = "CHAMA_BRIDGE_ALLOWED_ORIGINS",
            value_delimiter = ','
        )]
        allowed_origins: Vec<String>,
    },

    /// Join/open, print info, probe gateways, and create a tiny invoice.
    Smoke {
        invite_code: String,

        #[arg(long, default_value_t = 1000)]
        amount_msats: u64,
    },
}

#[derive(Debug, Clone)]
struct Bridge {
    data_dir: PathBuf,
    iroh_enable_dht: bool,
    iroh_enable_next: bool,
    /// Effective PKARR-over-HTTPS resolver (n0 default unless overridden).
    iroh_dns: Option<SafeUrl>,
    /// True when `iroh_dns` is the built-in n0 default rather than an override.
    iroh_dns_is_default: bool,
    /// Last gateway something actually SETTLED through — a paid invoice or a
    /// completed payment — cached so funding doesn't re-probe every gateway on
    /// each `/invoice`. Still re-probed each time it's used, so a gateway that
    /// has since gone offline can't pin funding to a dead endpoint.
    ///
    /// Deliberately NOT set by a successful reachability probe. A gateway can
    /// serve its HTTP API perfectly while its Lightning node has no announced,
    /// funded channels — payers then get "no route" on every invoice it mints.
    /// Caching on probe success promoted exactly such a gateway to first choice
    /// and kept it there. Settlement is the only evidence that sats can move.
    last_good_gateway: Arc<Mutex<Option<LightningGateway>>>,
    /// Per-gateway payability memory (see `GatewayHealth`), persisted under the
    /// data dir so a restart doesn't re-learn which gateways can actually be
    /// paid by minting unpayable invoices at users again.
    ///
    /// Shared across federations on purpose: gateway ids are globally unique
    /// pubkeys, so one memory (and one file, at the base data dir) can serve
    /// every federation this bridge switches between — an entry for a gateway
    /// another federation announced simply never matches here.
    gateway_health: Arc<Mutex<GatewayHealthStore>>,
    /// Which gateway minted each outstanding receive, so a settlement can be
    /// credited back to it. Entries are dropped as they settle.
    receive_gateways: Arc<Mutex<HashMap<OperationId, PublicKey>>>,
}

/// What a gateway has actually done for us.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct GatewayHealth {
    /// Receives/payments that reached a terminal success through this gateway.
    #[serde(default)]
    settled: u64,
    /// Invoices minted through it since the last settlement. A gateway that
    /// keeps minting invoices nobody can pay climbs here and sinks in the
    /// preference order without ever being hard-blocked.
    #[serde(default)]
    mints_since_settle: u32,
}

/// In-memory view of the persisted health file, loaded once on first use.
#[derive(Debug, Default)]
struct GatewayHealthStore {
    loaded: bool,
    entries: HashMap<PublicKey, GatewayHealth>,
}

/// On-disk shape. Keys are gateway ids as hex; BTreeMap keeps the file stable
/// across writes so it diffs cleanly when someone inspects it.
#[derive(Debug, Default, Serialize, Deserialize)]
struct GatewayHealthFile {
    #[serde(default)]
    gateways: BTreeMap<String, GatewayHealth>,
}

const GATEWAY_HEALTH_FILE: &str = "gateway-health.json";

#[derive(Debug, Serialize)]
struct IrohConfigDiagnostics {
    dht: bool,
    next: bool,
    resolver: String,
    resolver_url: Option<String>,
}

/// Result of the boot-time discovery readiness probe, surfaced verbatim in
/// /health so the app (and ops) can see "discovery degraded" before a fresh
/// join silently hangs.
#[derive(Debug, Clone, Serialize)]
struct DiscoveryProbe {
    /// "probing" | "reachable" | "degraded" | "skipped"
    status: String,
    /// host:port that was probed, or "none"
    target: String,
    /// failure detail when degraded, or the skip reason
    detail: Option<String>,
}

impl DiscoveryProbe {
    fn probing(target: &str) -> Self {
        Self {
            status: "probing".to_owned(),
            target: target.to_owned(),
            detail: None,
        }
    }

    fn skipped(reason: &str) -> Self {
        Self {
            status: "skipped".to_owned(),
            target: "none".to_owned(),
            detail: Some(reason.to_owned()),
        }
    }
}

#[derive(Debug, Serialize)]
struct JoinOutput {
    joined: String,
    federation_id: String,
}

#[derive(Debug, Serialize)]
struct InfoOutput {
    federation_id: String,
    network: String,
    total_amount_msat: u64,
    meta: serde_json::Value,
}

#[derive(Debug, Serialize)]
struct InvoiceOutput {
    operation_id: OperationId,
    invoice: String,
    /// Which gateway minted this invoice. Without it, the only way to learn
    /// which Lightning route a payer is being asked to use was to decode the
    /// BOLT11 by hand and match its route hint against the gateway list.
    #[serde(skip_serializing_if = "Option::is_none")]
    gateway_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    gateway_alias: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    gateway_api: Option<String>,
    /// True once something has actually settled through this gateway. False
    /// means "reachable, never yet paid" — worth showing before a user waits.
    gateway_proven_payable: bool,
}

#[derive(Debug, Serialize)]
struct GatewayProbe {
    gateway_id: String,
    vetted: bool,
    api: String,
    available: bool,
    error: Option<String>,
}

/// Discriminated outcome of an outgoing Lightning payment (board #9 Part 3).
/// The native claim guard keys re-pay safety on this `status`: only `settled`
/// resolves the claim, `refunded` means the sats came back (safe to re-pay), and
/// `inflight` means submitted-but-unknown (NEVER blindly re-pay — reconcile via
/// `/pay-outcome`). The pre-send failures (parse / gateway-select / submit
/// rejected) never produce this — they surface as an HTTP error, which the
/// frontend treats as safe-to-retry.
#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum PayOutcomeOutput {
    /// Preimage received — sats left the wallet successfully.
    Settled {
        operation_id: OperationId,
        #[serde(skip_serializing_if = "Option::is_none")]
        fee_msat: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        preimage: Option<String>,
    },
    /// The outgoing contract was CONFIRMED refunded/canceled — sats are back in
    /// the wallet. Safe to re-pay with a fresh invoice.
    Refunded {
        operation_id: OperationId,
        error: String,
    },
    /// Submitted (outgoing contract funded, operation id minted) but the outcome
    /// is not yet known — the watch timed out / errored, hit a non-terminal
    /// ambiguous state, or `no_wait`. MUST NOT be blindly re-paid; reconcile via
    /// `/pay-outcome`.
    Inflight {
        operation_id: OperationId,
        #[serde(skip_serializing_if = "Option::is_none")]
        fee_msat: Option<u64>,
    },
}

/// A terminal, FUND-SAFE classification of an outgoing payment. `None` from the
/// watcher means "no safe terminal reached" ⇒ the caller reports `inflight`.
enum PayTerminal {
    /// Preimage in hand — the recipient was paid.
    Settled { preimage: Option<String> },
    /// A CONFIRMED refund/cancel — the sats demonstrably came back.
    Refunded { error: String },
}

/// Watch an outgoing payment to a fund-safe terminal state, classifying the
/// pay-state stream directly rather than via `await_outgoing_payment` — that
/// upstream call collapses a CONFIRMED `Refunded` AND an ambiguous
/// `UnexpectedError` into the same `Failure`, and crucially fedimint yields
/// `UnexpectedError` when a payment that ALREADY SETTLED (preimage obtained)
/// fails to reclaim its change (`fedimint-ln-client` lib.rs ~1624). Mapping that
/// to "refunded" would tell the claim guard to re-pay an already-settled
/// payout — a double-pay (board #9 Part 3). So: only `Success` ⇒ settled, only a
/// confirmed `Refunded`/`Canceled` ⇒ refunded, and EVERYTHING ambiguous (incl.
/// `UnexpectedError`, stream end, timeout) ⇒ `None` ⇒ inflight (never re-pay).
/// Mirrors the browser SDK's `payStateCodedError`.
async fn watch_outgoing_pay(
    ln: &LightningClientModule,
    is_internal: bool,
    operation_id: OperationId,
) -> Option<PayTerminal> {
    let watch = async {
        if is_internal {
            let mut stream = ln.subscribe_internal_pay(operation_id).await.ok()?.into_stream();
            while let Some(state) = stream.next().await {
                match state {
                    InternalPayState::Preimage(_) => {
                        return Some(PayTerminal::Settled { preimage: None });
                    }
                    InternalPayState::RefundSuccess { error, .. } => {
                        return Some(PayTerminal::Refunded {
                            error: format!("internal payment refunded: {error:?}"),
                        });
                    }
                    // Refund/funding errors are NOT a confirmed sats-back, and an
                    // unexpected error is ambiguous ⇒ inflight (never re-pay).
                    InternalPayState::RefundError { .. }
                    | InternalPayState::FundingFailed { .. }
                    | InternalPayState::UnexpectedError(_) => return None,
                    InternalPayState::Funding => {}
                }
            }
            None
        } else {
            let mut stream = ln.subscribe_ln_pay(operation_id).await.ok()?.into_stream();
            while let Some(state) = stream.next().await {
                match state {
                    LnPayState::Success { preimage } => {
                        return Some(PayTerminal::Settled {
                            preimage: Some(preimage),
                        });
                    }
                    LnPayState::Refunded { gateway_error } => {
                        return Some(PayTerminal::Refunded {
                            error: format!("payment refunded by gateway: {gateway_error:?}"),
                        });
                    }
                    LnPayState::Canceled => {
                        return Some(PayTerminal::Refunded {
                            error: "payment canceled before send".to_string(),
                        });
                    }
                    // `UnexpectedError` is the ambiguous case — it also fires when
                    // a SETTLED payment's change reclaim failed — so never treat
                    // it as refunded. Non-terminal states keep waiting.
                    LnPayState::UnexpectedError { .. } => return None,
                    LnPayState::Created
                    | LnPayState::Funded { .. }
                    | LnPayState::WaitingForRefund { .. }
                    | LnPayState::AwaitingChange => {}
                }
            }
            None
        }
    };
    match tokio::time::timeout(PAY_AWAIT_TIMEOUT, watch).await {
        Ok(terminal) => terminal,
        Err(_) => None,
    }
}

/// Build the wire outcome from a watcher result, defaulting to `inflight`.
fn pay_outcome_output(
    terminal: Option<PayTerminal>,
    operation_id: OperationId,
    fee_msat: Option<u64>,
) -> PayOutcomeOutput {
    match terminal {
        Some(PayTerminal::Settled { preimage }) => PayOutcomeOutput::Settled {
            operation_id,
            fee_msat,
            preimage,
        },
        Some(PayTerminal::Refunded { error }) => PayOutcomeOutput::Refunded {
            operation_id,
            error,
        },
        None => PayOutcomeOutput::Inflight {
            operation_id,
            fee_msat,
        },
    }
}

#[derive(Debug, Serialize)]
struct OnchainInfoOutput {
    network: String,
    finality_delay: u32,
    peg_in_fee_sats: u64,
    peg_out_fee_sats: u64,
    minimum_deposit_sats: u64,
}

#[derive(Debug, Serialize)]
struct OnchainDepositAddressOutput {
    operation_id: OperationId,
    address: String,
    tweak_idx: TweakIdx,
    finality_delay: u32,
}

#[derive(Debug, Serialize)]
struct OnchainDepositSettledOutput {
    status: String,
    operation_id: OperationId,
    amount_sats: Option<u64>,
    outpoint: Option<String>,
    info: InfoOutput,
}

#[derive(Debug, Serialize)]
struct OnchainWithdrawFeesOutput {
    amount_sats: u64,
    fees_sats: u64,
    total_sats: u64,
}

#[derive(Debug, Serialize)]
struct OnchainWithdrawOutput {
    operation_id: OperationId,
    status: String,
    txid: Option<String>,
    fees_sats: u64,
}

#[derive(Debug, Serialize)]
struct SpendNotesOutput {
    operation_id: OperationId,
    requested_amount_msat: u64,
    total_amount_msat: u64,
    notes: String,
}

#[derive(Debug, Serialize)]
struct ReissueNotesOutput {
    operation_id: OperationId,
    total_amount_msat: u64,
    status: String,
}

#[derive(Debug, Serialize)]
struct ParseNotesOutput {
    total_amount_msat: u64,
    federation_id_prefix: String,
    notes_json: serde_json::Value,
}

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();

    let cli = Cli::parse();
    // Default native discovery to n0's HTTPS PKARR relay so a fresh join over
    // mobile/CGNAT resolves guardians the same reliable way the browser does,
    // instead of relying only on DNS(:53) + DHT(UDP). Additive, not a swap.
    let (iroh_dns, iroh_dns_is_default) = match cli.iroh_dns {
        Some(url) => (Some(url), false),
        None => (
            Some(
                SafeUrl::from_str(DEFAULT_IROH_PKARR_RELAY)
                    .expect("DEFAULT_IROH_PKARR_RELAY is a valid URL"),
            ),
            true,
        ),
    };
    let bridge = Bridge {
        data_dir: cli.data_dir,
        iroh_enable_dht: cli.iroh_enable_dht,
        iroh_enable_next: cli.iroh_enable_next,
        iroh_dns,
        iroh_dns_is_default,
        last_good_gateway: Arc::new(Mutex::new(None)),
        gateway_health: Arc::new(Mutex::new(GatewayHealthStore::default())),
        receive_gateways: Arc::new(Mutex::new(HashMap::new())),
    };

    bridge.log_effective_config();

    match cli.command {
        Command::Join { invite_code } => {
            let client = bridge.join(&invite_code).await?;
            print_json(&JoinOutput {
                joined: invite_code,
                federation_id: client.federation_id().to_string(),
            })?;
        }
        Command::Info => {
            let client = bridge.open().await?;
            print_json(&info_output(&client).await?)?;
        }
        Command::ListGateways { no_update } => {
            let client = bridge.open().await?;
            let gateways = bridge.list_gateways(&client, no_update).await?;
            print_json(&json!({
                "gateway_count": gateways.len(),
                "gateways": gateways,
            }))?;
        }
        Command::ProbeGateways => {
            let client = bridge.open().await?;
            let probes = bridge.probe_gateways(&client).await?;
            print_json(&json!({
                "gateway_count": probes.len(),
                "probes": probes,
            }))?;
        }
        Command::Invoice {
            amount_msats,
            description,
            expiry_time,
            gateway_id,
            force_internal,
        } => {
            let client = bridge.open().await?;
            let invoice = bridge
                .invoice(
                    &client,
                    amount_msats,
                    description,
                    expiry_time,
                    gateway_id,
                    force_internal,
                )
                .await?;
            print_json(&invoice)?;
        }
        Command::AwaitInvoice { operation_id } => {
            let client = bridge.open().await?;
            // CLI owns its own socket — keep waiting until there's an outcome.
            let value = bridge.await_invoice(&client, operation_id, 0).await?;
            print_json(&value)?;
        }
        Command::PayOutcome { operation_id } => {
            let client = bridge.open().await?;
            let value = bridge.pay_outcome(&client, operation_id).await?;
            print_json(&value)?;
        }
        Command::Pay {
            payment_info,
            amount_msats,
            lnurl_comment,
            gateway_id,
            force_internal,
            no_wait,
        } => {
            let client = bridge.open().await?;
            let value = bridge
                .pay(
                    &client,
                    payment_info,
                    amount_msats,
                    lnurl_comment,
                    gateway_id,
                    force_internal,
                    no_wait,
                    None,
                )
                .await?;
            print_json(&value)?;
        }
        Command::SpendNotes {
            amount_msats,
            allow_overpay,
            timeout_secs,
            include_invite,
        } => {
            let client = bridge.open().await?;
            let value = bridge
                .spend_notes(
                    &client,
                    amount_msats,
                    allow_overpay,
                    timeout_secs,
                    include_invite,
                )
                .await?;
            print_json(&value)?;
        }
        Command::ReissueNotes { notes, no_wait } => {
            let client = bridge.open().await?;
            let value = bridge.reissue_notes(&client, notes, !no_wait).await?;
            print_json(&value)?;
        }
        Command::ParseNotes { notes } => {
            print_json(&parse_notes(&notes)?)?;
        }
        Command::OnchainInfo => {
            let client = bridge.open().await?;
            print_json(&bridge.onchain_info(&client).await?)?;
        }
        Command::OnchainDepositAddress => {
            let client = bridge.open().await?;
            print_json(&bridge.onchain_deposit_address(&client).await?)?;
        }
        Command::AwaitOnchainDeposit { operation_id } => {
            let client = bridge.open().await?;
            print_json(&bridge.await_onchain_deposit(&client, operation_id).await?)?;
        }
        Command::OnchainWithdrawFees {
            address,
            amount_sats,
        } => {
            let client = bridge.open().await?;
            print_json(
                &bridge
                    .onchain_withdraw_fees(&client, address, amount_sats)
                    .await?,
            )?;
        }
        Command::OnchainWithdraw {
            address,
            amount_sats,
            no_wait,
        } => {
            let client = bridge.open().await?;
            print_json(
                &bridge
                    .onchain_withdraw(&client, address, amount_sats, no_wait)
                    .await?,
            )?;
        }
        Command::Serve {
            bind,
            invite_code,
            auth_token,
            allowed_origins,
        } => {
            serve_bridge(bridge, bind, invite_code, auth_token, allowed_origins).await?;
        }
        Command::Smoke {
            invite_code,
            amount_msats,
        } => {
            let client = bridge.open_or_join(&invite_code).await?;
            let info = info_output(&client).await?;
            let probes = bridge.probe_gateways(&client).await?;
            let invoice = bridge
                .invoice(
                    &client,
                    amount_msats,
                    "Chama Fedimint native smoke".to_owned(),
                    None,
                    None,
                    false,
                )
                .await?;

            print_json(&json!({
                "info": info,
                "gateway_count": probes.len(),
                "gateway_probes": probes,
                "invoice": invoice,
            }))?;
        }
    }

    Ok(())
}

impl Bridge {
    fn with_data_dir(&self, data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            iroh_enable_dht: self.iroh_enable_dht,
            iroh_enable_next: self.iroh_enable_next,
            iroh_dns: self.iroh_dns.clone(),
            iroh_dns_is_default: self.iroh_dns_is_default,
            last_good_gateway: self.last_good_gateway.clone(),
            gateway_health: self.gateway_health.clone(),
            receive_gateways: self.receive_gateways.clone(),
        }
    }

    fn gateway_health_path(&self) -> PathBuf {
        self.data_dir.join(GATEWAY_HEALTH_FILE)
    }

    /// Load the persisted health file once. Best-effort throughout: a missing,
    /// unreadable, or malformed file just means starting from no knowledge —
    /// gateway selection must never fail because of a diagnostics cache.
    async fn ensure_gateway_health_loaded(&self) {
        {
            let store = self.gateway_health.lock().await;
            if store.loaded {
                return;
            }
        }
        let path = self.gateway_health_path();
        let parsed = match tokio::fs::read(&path).await {
            Ok(bytes) => match serde_json::from_slice::<GatewayHealthFile>(&bytes) {
                Ok(file) => Some(file),
                Err(error) => {
                    eprintln!("gateway-health: ignoring malformed {}: {error:#}", path.display());
                    None
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => {
                eprintln!("gateway-health: couldn't read {}: {error:#}", path.display());
                None
            }
        };

        let mut store = self.gateway_health.lock().await;
        if store.loaded {
            return; // another task won the race; theirs is as good as ours
        }
        if let Some(file) = parsed {
            let mut restored = 0usize;
            for (id, health) in file.gateways {
                match id.parse::<PublicKey>() {
                    Ok(gateway_id) => {
                        store.entries.insert(gateway_id, health);
                        restored += 1;
                    }
                    Err(error) => {
                        eprintln!("gateway-health: skipping unparseable gateway id {id}: {error:#}")
                    }
                }
            }
            if restored > 0 {
                eprintln!("gateway-health: restored {restored} gateway record(s) from disk");
            }
        }
        store.loaded = true;
    }

    /// Write the health map out. Best-effort: a failed write only costs the
    /// memory of which gateways pay, never a funding attempt.
    async fn persist_gateway_health(&self) {
        let file = {
            let store = self.gateway_health.lock().await;
            GatewayHealthFile {
                gateways: store
                    .entries
                    .iter()
                    .map(|(id, health)| (id.to_string(), health.clone()))
                    .collect(),
            }
        };
        let path = self.gateway_health_path();
        match serde_json::to_vec_pretty(&file) {
            Ok(bytes) => {
                // Write-then-rename so a crash mid-write can't leave a truncated
                // file that the next start would report as malformed.
                let tmp = path.with_extension("json.tmp");
                if let Err(error) = tokio::fs::write(&tmp, &bytes).await {
                    eprintln!("gateway-health: couldn't write {}: {error:#}", tmp.display());
                    return;
                }
                if let Err(error) = tokio::fs::rename(&tmp, &path).await {
                    eprintln!("gateway-health: couldn't replace {}: {error:#}", path.display());
                }
            }
            Err(error) => eprintln!("gateway-health: couldn't serialize: {error:#}"),
        }
    }

    /// Record that a gateway minted an invoice we haven't been paid through yet.
    async fn note_gateway_mint(&self, gateway_id: PublicKey, operation_id: OperationId) {
        self.ensure_gateway_health_loaded().await;
        self.receive_gateways
            .lock()
            .await
            .insert(operation_id, gateway_id);
        {
            let mut store = self.gateway_health.lock().await;
            store.entries.entry(gateway_id).or_default().mints_since_settle += 1;
        }
        self.persist_gateway_health().await;
    }

    /// Record that sats actually moved through a gateway. This — not a probe —
    /// is what promotes it to first choice.
    async fn note_gateway_settled(&self, gateway_id: PublicKey, selected: Option<&LightningGateway>) {
        self.ensure_gateway_health_loaded().await;
        {
            let mut store = self.gateway_health.lock().await;
            let entry = store.entries.entry(gateway_id).or_default();
            entry.settled += 1;
            entry.mints_since_settle = 0;
        }
        if let Some(selected) = selected {
            *self.last_good_gateway.lock().await = Some(selected.clone());
        }
        self.persist_gateway_health().await;
        eprintln!("gateway: {gateway_id} settled a payment — promoted to preferred");
    }

    /// Settlement arrived for a receive; credit whichever gateway minted it.
    async fn note_receive_settled(&self, operation_id: OperationId) {
        let gateway_id = self.receive_gateways.lock().await.remove(&operation_id);
        if let Some(gateway_id) = gateway_id {
            self.note_gateway_settled(gateway_id, None).await;
        }
    }

    /// Preference rank for a gateway: proven payable first, then gateways that
    /// haven't repeatedly minted unpayable invoices, then the static
    /// scheme/vetted/fee ordering.
    async fn gateway_health_rank(&self, gateway_id: &PublicKey) -> (u8, u32) {
        self.ensure_gateway_health_loaded().await;
        let stats = self
            .gateway_health
            .lock()
            .await
            .entries
            .get(gateway_id)
            .cloned()
            .unwrap_or_default();
        let proven = u8::from(stats.settled == 0);
        (proven, stats.mints_since_settle.min(3))
    }

    fn iroh_config_diagnostics(&self) -> IrohConfigDiagnostics {
        IrohConfigDiagnostics {
            dht: self.iroh_enable_dht,
            next: self.iroh_enable_next,
            resolver: match (&self.iroh_dns, self.iroh_dns_is_default) {
                (Some(_), true) => "n0-pkarr-https+dns".to_owned(),
                (Some(_), false) => "custom-pkarr-https+dns".to_owned(),
                (None, _) => "dns-only".to_owned(),
            },
            resolver_url: self.iroh_dns.as_ref().map(ToString::to_string),
        }
    }

    fn log_effective_config(&self) {
        let diagnostics = self.iroh_config_diagnostics();
        eprintln!(
            "chama-fedimint-bridge effective iroh config: dht={}, next={}, resolver={}, resolver_url={}",
            diagnostics.dht,
            diagnostics.next,
            diagnostics.resolver,
            diagnostics.resolver_url.as_deref().unwrap_or("none"),
        );
    }

    /// host:port of the configured PKARR resolver for the boot readiness probe.
    /// Defaults the port to 443 (HTTPS) when the URL omits it.
    fn discovery_probe_target(&self) -> Option<String> {
        let url = self.iroh_dns.as_ref()?;
        let host = url.host_str()?;
        let port = url.port_or_known_default().unwrap_or(443);
        Some(format!("{host}:{port}"))
    }

    async fn join(&self, invite_code: &str) -> Result<ClientHandleArc> {
        let invite_code =
            InviteCode::from_str(invite_code).context("invalid federation invite code")?;
        self.join_invite(invite_code).await
    }

    async fn join_invite(&self, invite_code: InviteCode) -> Result<ClientHandleArc> {
        let (builder, db) = self.client_builder().await?;
        let mnemonic = load_or_generate_mnemonic(&db).await?;
        let connectors = self.connectors().await?;
        let root_secret = root_secret_from_mnemonic(&mnemonic);

        let client = tokio::time::timeout(FEDERATION_JOIN_TIMEOUT, async move {
            builder
                .preview(connectors, &invite_code)
                .await
                .context("failed to preview federation invite")?
                .join(db, root_secret)
                .await
                .context("failed to join federation")
        })
        .await
        .context("timed out joining federation")??;

        let client = Arc::new(client);
        self.warm_gateway_cache(&client).await;
        Ok(client)
    }

    async fn open(&self) -> Result<ClientHandleArc> {
        let (builder, db) = self.client_builder().await?;
        let entropy = Client::load_decodable_client_secret_opt::<Vec<u8>>(&db)
            .await
            .context("failed to load client secret")?
            .context("client secret is not present; run join first")?;
        let mnemonic =
            Mnemonic::from_entropy(&entropy).context("invalid stored mnemonic entropy")?;
        let connectors = self.connectors().await?;
        let root_secret = root_secret_from_mnemonic(&mnemonic);

        let client = tokio::time::timeout(
            FEDERATION_OPEN_TIMEOUT,
            builder.open(connectors, db, root_secret),
        )
        .await
        .context("timed out opening Fedimint client")?
        .context("failed to open Fedimint client")?;

        let client = Arc::new(client);
        self.warm_gateway_cache(&client).await;
        Ok(client)
    }

    async fn open_or_join(&self, invite_code: &str) -> Result<ClientHandleArc> {
        let invite_code =
            InviteCode::from_str(invite_code).context("invalid federation invite code")?;
        let requested_federation_id = invite_code.federation_id();

        match self.open().await {
            Ok(client) => {
                let existing_federation_id = client.federation_id();
                if existing_federation_id != requested_federation_id {
                    bail!(
                        "existing Fedimint client database is initialized for federation {existing_federation_id}, but requested invite is for federation {requested_federation_id}; reset local state before switching federations"
                    );
                }
                Ok(client)
            }
            Err(open_err) => self
                .join_invite(invite_code)
                .await
                .with_context(|| format!("open failed before join attempt: {open_err:#}")),
        }
    }

    async fn reset_local_state(&self) -> Result<()> {
        let db_path = self.data_dir.join("client.db");
        for attempt in 0..3 {
            match tokio::fs::remove_dir_all(&db_path).await {
                Ok(()) => {
                    tokio::fs::create_dir_all(&self.data_dir)
                        .await
                        .with_context(|| {
                            format!("failed to recreate data dir {}", self.data_dir.display())
                        })?;
                    return Ok(());
                }
                Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
                Err(error) if attempt < 2 => {
                    eprintln!(
                        "failed to remove Fedimint client database {} on attempt {}: {}; retrying",
                        db_path.display(),
                        attempt + 1,
                        error,
                    );
                    tokio::time::sleep(Duration::from_millis(150)).await;
                }
                Err(error) => {
                    return Err(error).with_context(|| {
                        format!(
                            "failed to remove Fedimint client database {}",
                            db_path.display()
                        )
                    });
                }
            }
        }

        Ok(())
    }

    async fn local_client_db_present(&self) -> bool {
        tokio::fs::metadata(self.data_dir.join("client.db"))
            .await
            .is_ok()
    }

    /// Best-effort: refresh the gateway cache right after a successful
    /// open/join, while the guardians are known-reachable, so funding-time
    /// gateway selection can hit a warm cache instead of forcing a live
    /// guardian RPC at the worst possible moment. Never fails the caller -
    /// a transient warm failure is logged and ignored.
    async fn warm_gateway_cache(&self, client: &ClientHandleArc) {
        match client.get_first_module::<LightningClientModule>() {
            Ok(ln) => {
                match tokio::time::timeout(GATEWAY_CACHE_REFRESH_TIMEOUT, ln.update_gateway_cache())
                    .await
                {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => {
                        eprintln!(
                            "warm_gateway_cache: best-effort gateway cache refresh failed (continuing): {error:#}"
                        );
                    }
                    Err(_) => {
                        eprintln!(
                            "warm_gateway_cache: timed out after {:?} (continuing)",
                            GATEWAY_CACHE_REFRESH_TIMEOUT
                        );
                    }
                }
            }
            Err(error) => {
                eprintln!("warm_gateway_cache: no Lightning module to warm: {error:#}");
            }
        }
    }

    async fn list_gateways(
        &self,
        client: &ClientHandleArc,
        no_update: bool,
    ) -> Result<Vec<fedimint_ln_client::common::LightningGatewayAnnouncement>> {
        let ln = client.get_first_module::<LightningClientModule>()?;
        if !no_update {
            tokio::time::timeout(GATEWAY_CACHE_REFRESH_TIMEOUT, ln.update_gateway_cache())
                .await
                .context("timed out updating gateway cache")?
                .context("failed to update gateway cache")?;
        }
        Ok(ln.list_gateways().await)
    }

    async fn probe_gateways(&self, client: &ClientHandleArc) -> Result<Vec<GatewayProbe>> {
        let ln = client.get_first_module::<LightningClientModule>()?;
        tokio::time::timeout(GATEWAY_CACHE_REFRESH_TIMEOUT, ln.update_gateway_cache())
            .await
            .context("timed out updating gateway cache")?
            .context("failed to update gateway cache")?;

        let gateways = ln.list_gateways().await;
        let mut probes = Vec::with_capacity(gateways.len());
        for announcement in gateways {
            let gateway = announcement.info.clone();
            let gateway_id = gateway.gateway_id.to_string();
            let api = gateway.api.to_string();
            let result = tokio::time::timeout(
                GATEWAY_SELECT_TIMEOUT,
                ln.select_available_gateway(Some(gateway), None),
            )
            .await
            .context("timed out selecting gateway");
            probes.push(match result {
                Ok(Ok(_)) => GatewayProbe {
                    gateway_id,
                    vetted: announcement.vetted,
                    api,
                    available: true,
                    error: None,
                },
                Ok(Err(error)) | Err(error) => GatewayProbe {
                    gateway_id,
                    vetted: announcement.vetted,
                    api,
                    available: false,
                    error: Some(format!("{error:#}")),
                },
            });
        }

        Ok(probes)
    }

    async fn invoice(
        &self,
        client: &ClientHandleArc,
        amount_msats: u64,
        description: String,
        expiry_time: Option<u64>,
        gateway_id: Option<PublicKey>,
        force_internal: bool,
    ) -> Result<InvoiceOutput> {
        let ln = client.get_first_module::<LightningClientModule>()?;
        let gateway = self
            .select_receive_gateway(&ln, gateway_id, force_internal)
            .await?;
        let description = Description::new(description).context("invalid invoice description")?;
        let selected = gateway.clone();
        let (operation_id, invoice, _) = ln
            .create_bolt11_invoice(
                Amount::from_msats(amount_msats),
                Bolt11InvoiceDescription::Direct(description),
                expiry_time,
                (),
                gateway,
            )
            .await
            .context("failed to create BOLT11 invoice")?;

        let mut proven_payable = false;
        if let Some(selected) = selected.as_ref() {
            self.note_gateway_mint(selected.gateway_id, operation_id).await;
            proven_payable = self.gateway_health_rank(&selected.gateway_id).await.0 == 0;
            eprintln!(
                "invoice: minted {amount_msats}msat via gateway {} ({}) proven_payable={proven_payable}",
                selected.gateway_id, selected.lightning_alias,
            );
        }

        Ok(InvoiceOutput {
            operation_id,
            invoice: invoice.to_string(),
            gateway_id: selected.as_ref().map(|gw| gw.gateway_id.to_string()),
            gateway_alias: selected.as_ref().map(|gw| gw.lightning_alias.clone()),
            gateway_api: selected.as_ref().map(|gw| gw.api.to_string()),
            gateway_proven_payable: proven_payable,
        })
    }

    async fn select_receive_gateway(
        &self,
        ln: &LightningClientModule,
        gateway_id: Option<PublicKey>,
        force_internal: bool,
    ) -> Result<Option<LightningGateway>> {
        if gateway_id.is_some() || force_internal {
            return self
                .get_gateway_with_retries(ln, gateway_id, force_internal, "invoice")
                .await
                .context(
                    "Couldn't reach the requested federation Lightning gateway to create a receive invoice - \
                     no invoice was created and no sats moved.",
                );
        }

        // Auto-select a reachable gateway one at a time rather than via the
        // blind `ln.select_available_gateway(None, None)`, which `join_all`s
        // over EVERY gateway and waits for the slowest — so a single dead
        // `iroh://` gateway burns the whole `GATEWAY_SELECT_TIMEOUT` before the
        // reachable HTTPS gateways are reached (board #9). `pick_reachable_gateway`
        // refreshes the cache, then probes candidates in preference order under a
        // short per-gateway timeout.
        self.pick_reachable_gateway(ln, "create a receive invoice").await
    }

    /// Pick a reachable Lightning gateway without letting one dead gateway stall
    /// the whole selection (board #9). Refreshes the gateway cache, orders
    /// candidates clearnet-before-iroh (native can't reliably reach `iroh://`
    /// gateways — same transport limit as the fresh-join path), then
    /// vetted-before-unvetted, then cheapest; tries the last-known-good gateway
    /// first; and probes each candidate with a short per-gateway timeout,
    /// returning (and caching) the first that answers. Shared by the receive
    /// (`/invoice`) and send (`/pay`) auto paths — it is pure pre-send gateway
    /// selection (it never starts a payment), so a caller can use it once and
    /// then send exactly once with no double-spend risk. Fails safe — returns no
    /// gateway, so the caller moves no sats — only when every listed gateway is
    /// unreachable. `action` only shapes the human-readable failure text (e.g.
    /// "create a receive invoice" / "send this Lightning payment").
    async fn pick_reachable_gateway(
        &self,
        ln: &LightningClientModule,
        action: &str,
    ) -> Result<Option<LightningGateway>> {
        // Best-effort cache refresh: retry transient guardian hiccups, but don't
        // fail on a cold cache — the per-gateway reachability probe below is the
        // real gate. Keep the last refresh error for diagnostics only.
        let mut refresh_error: Option<String> = None;
        for attempt in 1..=3 {
            match tokio::time::timeout(GATEWAY_CACHE_REFRESH_TIMEOUT, ln.update_gateway_cache())
                .await
            {
                Ok(Ok(())) => {
                    refresh_error = None;
                    break;
                }
                Ok(Err(error)) => {
                    refresh_error = Some(format!("{error:#}"));
                    if attempt < 3 {
                        eprintln!(
                            "gateway: cache refresh retry {attempt} after a transient failure: {error:#}"
                        );
                        tokio::time::sleep(Duration::from_millis(1200)).await;
                    }
                }
                Err(_) => {
                    refresh_error = Some(format!(
                        "timed out after {:?}",
                        GATEWAY_CACHE_REFRESH_TIMEOUT
                    ));
                    if attempt < 3 {
                        eprintln!("gateway: cache refresh retry {attempt} after timeout");
                        tokio::time::sleep(Duration::from_millis(1200)).await;
                    }
                }
            }
        }

        let announcements = ln.list_gateways().await;
        if announcements.is_empty() {
            if let Some(refresh_error) = refresh_error {
                bail!(
                    "Couldn't reach the federation's Lightning gateway to {action} - no sats \
                     moved. Gateway cache refresh failed: {refresh_error}; the gateway list is empty."
                );
            }
            bail!(
                "Couldn't find a reachable federation Lightning gateway to {action} - no sats \
                 moved. This federation has no registered Lightning gateways."
            );
        }

        // Preference order: clearnet before iroh, then vetted, then lowest fee.
        // `vetted` lives on the announcement, not the gateway, so carry it
        // alongside the gateway for the sort key.
        let mut ordered: Vec<(LightningGateway, bool)> = announcements
            .into_iter()
            .map(|ann| (ann.info, ann.vetted))
            .collect();

        // Payability outranks every static signal. A gateway that has settled a
        // payment beats one that merely looks preferable on paper — including a
        // clearnet gateway whose node no payer can route to.
        let mut ranked: Vec<((u8, u32), LightningGateway, bool)> = Vec::with_capacity(ordered.len());
        for (gw, vetted) in ordered.drain(..) {
            let health = self.gateway_health_rank(&gw.gateway_id).await;
            ranked.push((health, gw, vetted));
        }
        ranked.sort_by_key(|(health, gw, vetted)| {
            (
                health.0,
                health.1,
                gateway_scheme_rank(gw),
                u8::from(!*vetted),
                u64::from(gw.fees.base_msat),
                u64::from(gw.fees.proportional_millionths),
            )
        });
        let mut ordered: Vec<(LightningGateway, bool)> = ranked
            .into_iter()
            .map(|(_, gw, vetted)| (gw, vetted))
            .collect();

        // Try the last-known-good gateway first (still freshly probed below, so
        // a since-offline cached gateway can't pin funding to a dead endpoint).
        let cached_id = self
            .last_good_gateway
            .lock()
            .await
            .as_ref()
            .map(|gw| gw.gateway_id);
        if let Some(cached_id) = cached_id {
            if let Some(pos) = ordered.iter().position(|(gw, _)| gw.gateway_id == cached_id) {
                let cached = ordered.remove(pos);
                ordered.insert(0, cached);
            }
        }

        let mut last_error: Option<String> = None;
        for (gateway, _vetted) in ordered {
            let gateway_id = gateway.gateway_id;
            let scheme = gateway.api.scheme().to_owned();
            match tokio::time::timeout(
                GATEWAY_PROBE_TIMEOUT,
                ln.select_available_gateway(Some(gateway.clone()), None),
            )
            .await
            {
                Ok(Ok(selected)) => {
                    // Reachable, NOT proven payable. Promotion to
                    // `last_good_gateway` happens only once something settles
                    // through it (see note_gateway_settled).
                    let (rank, misses) = self.gateway_health_rank(&gateway_id).await;
                    eprintln!(
                        "gateway: selected reachable gateway {gateway_id} ({scheme}) to {action} \
                         [proven_payable={} unpaid_mints={misses}]",
                        rank == 0,
                    );
                    return Ok(Some(selected));
                }
                Ok(Err(error)) => {
                    eprintln!("gateway: {gateway_id} ({scheme}) not reachable: {error:#}");
                    last_error = Some(format!("{error:#}"));
                }
                Err(_) => {
                    eprintln!(
                        "gateway: {gateway_id} ({scheme}) probe timed out after {:?}",
                        GATEWAY_PROBE_TIMEOUT
                    );
                    last_error = Some(format!("probe timed out after {:?}", GATEWAY_PROBE_TIMEOUT));
                }
            }
        }

        // Every listed gateway was unreachable — fail safe (no sats moved).
        // last_good_gateway is left untouched here, so the next attempt still
        // tries whatever last actually worked.
        match (refresh_error, last_error) {
            (Some(refresh_error), Some(last_error)) => bail!(
                "Couldn't reach the federation's Lightning gateway to {action} - no sats moved. \
                 Gateway cache refresh failed: {refresh_error}; no listed gateway was reachable \
                 (last error: {last_error})."
            ),
            (Some(refresh_error), None) => bail!(
                "Couldn't reach the federation's Lightning gateway to {action} - no sats moved. \
                 Gateway cache refresh failed: {refresh_error}."
            ),
            (None, Some(last_error)) => bail!(
                "Couldn't find a reachable federation Lightning gateway to {action} - no sats \
                 moved. No listed gateway was reachable (last error: {last_error})."
            ),
            (None, None) => bail!(
                "Couldn't find a reachable federation Lightning gateway to {action} - no sats moved."
            ),
        }
    }

    async fn get_gateway_with_retries(
        &self,
        ln: &LightningClientModule,
        gateway_id: Option<PublicKey>,
        force_internal: bool,
        operation: &str,
    ) -> Result<Option<LightningGateway>> {
        let mut gateway_result = tokio::time::timeout(
            GATEWAY_SELECT_TIMEOUT,
            ln.get_gateway(gateway_id, force_internal),
        )
        .await
        .context("timed out selecting gateway")?;
        let mut attempt = 1u32;
        while gateway_result.is_err() && attempt < 3 {
            eprintln!("{operation}: gateway selection retry {attempt} after a transient failure");
            tokio::time::sleep(Duration::from_millis(1200)).await;
            gateway_result = tokio::time::timeout(
                GATEWAY_SELECT_TIMEOUT,
                ln.get_gateway(gateway_id, force_internal),
            )
            .await
            .context("timed out selecting gateway")?;
            attempt += 1;
        }
        gateway_result
    }

    /// Watch an incoming invoice until it settles, is canceled, or `wait_secs`
    /// elapses.
    ///
    /// The elapsed case returns `status: "pending"` rather than holding the
    /// request open indefinitely. An unbounded hold only survives a direct
    /// socket to the bridge: anything in front of it (StartOS runs nginx) has
    /// its own read timeout and will hang up mid-wait, answering the caller
    /// with an error page that says nothing about the invoice. Returning a real
    /// answer the caller can act on — "not yet, ask again" — keeps the watch
    /// correct regardless of what sits in the middle.
    ///
    /// `wait_secs == 0` restores the old unbounded behaviour for callers that
    /// genuinely own the socket (the CLI).
    async fn await_invoice(
        &self,
        client: &ClientHandleArc,
        operation_id: OperationId,
        wait_secs: u64,
    ) -> Result<serde_json::Value> {
        let ln = client.get_first_module::<LightningClientModule>()?;
        let mut updates = ln
            .subscribe_ln_receive(operation_id)
            .await
            .context("failed to subscribe to incoming invoice")?
            .into_stream();

        let deadline = tokio::time::sleep(Duration::from_secs(if wait_secs == 0 {
            u64::from(u32::MAX)
        } else {
            wait_secs
        }));
        tokio::pin!(deadline);

        loop {
            tokio::select! {
                // Bias the stream so a settlement that lands in the same tick as
                // the deadline is reported as paid, never as pending.
                biased;

                update = updates.next() => match update {
                    Some(LnReceiveState::Claimed) => {
                        // Sats actually arrived — this is the evidence that
                        // promotes the minting gateway (Leg 1).
                        self.note_receive_settled(operation_id).await;
                        return Ok(json!({
                            "status": "paid",
                            "operation_id": operation_id,
                            "info": info_output(client).await?,
                        }));
                    }
                    Some(LnReceiveState::Canceled { reason }) => {
                        bail!("invoice canceled: {reason}")
                    }
                    Some(_) => {}
                    None => bail!("invoice update stream ended before settlement"),
                },

                _ = &mut deadline, if wait_secs > 0 => {
                    // Not an outcome — an interim answer. The invoice is still
                    // live and the caller is expected to ask again.
                    return Ok(json!({
                        "status": "pending",
                        "operation_id": operation_id,
                    }));
                }
            }
        }
    }

    async fn pay(
        &self,
        client: &ClientHandleArc,
        payment_info: String,
        amount_msats: Option<u64>,
        lnurl_comment: Option<String>,
        gateway_id: Option<PublicKey>,
        force_internal: bool,
        no_wait: bool,
        // V7: caller-supplied JSON stamped into the payment's operation-log
        // entry (fedimint `extra_meta`, persisted in the client DB). Chama
        // sends its ChamaOperationMeta incl. `chama_escrow_id`, which
        // `/pay-outcome-by-escrow` reconciles against after a crash that
        // lost the operation id.
        extra_meta: Option<serde_json::Value>,
    ) -> Result<serde_json::Value> {
        let ln = client.get_first_module::<LightningClientModule>()?;
        let invoice = fedimint_ln_client::get_invoice(
            &payment_info,
            amount_msats.map(Amount::from_msats),
            lnurl_comment,
        )
        .await
        .context("failed to parse BOLT11/LNURL payment info")?;
        let gateway = if gateway_id.is_some() || force_internal {
            // Explicit gateway or internal-swap: honor the caller verbatim.
            ln.get_gateway(gateway_id, force_internal)
                .await
                .context("failed to select gateway")?
        } else {
            // Auto path: same dead-`iroh://` hazard as the receive path (board #9
            // Part 2). Blind `get_gateway(None)` picks a RANDOM gateway with no
            // reachability filter, so it can hand back the dead Banco Bitcoin
            // `iroh://` gateway and `pay_bolt11_invoice` then fails with "Failed
            // to connect to gateway" — blocking CLAIM payouts. Select a reachable
            // gateway instead (clearnet-first, skip dead iroh, last-good cache).
            // This is pure pre-send selection: `pay_bolt11_invoice` is still
            // called exactly once below, so there is no double-pay risk.
            self.pick_reachable_gateway(&ln, "send this Lightning payment")
                .await?
        };

        // SEND. `Ok` ⇒ the outgoing contract was funded and an operation id was
        // minted — the payment is now SUBMITTED. `Err` ⇒ the transaction was not
        // accepted (gateway connect / funding rejected before any sats were
        // committed) ⇒ a pre-send failure that is safe to re-pay, so we let it
        // propagate as an HTTP error.
        // Keep the chosen gateway so a confirmed settlement can credit it as
        // proven payable (Leg 1); `pay_bolt11_invoice` consumes the original.
        let paying_gateway = gateway.clone();
        let OutgoingLightningPayment {
            payment_type,
            contract_id: _,
            fee,
        } = ln
            // `Value::Null` when unset serializes identically to the old `()`.
            .pay_bolt11_invoice(gateway, invoice, extra_meta.unwrap_or(serde_json::Value::Null))
            .await
            .context("failed to start outgoing LN payment")?;
        let operation_id = payment_type.operation_id();
        let is_internal = matches!(payment_type, PayType::Internal(_));
        let fee_msat = Some(fee.msats);

        if no_wait {
            // Submitted; the caller reconciles via /pay-outcome. Report inflight,
            // never settled.
            return Ok(serde_json::to_value(PayOutcomeOutput::Inflight {
                operation_id,
                fee_msat,
            })?);
        }

        // Bounded wait for a FUND-SAFE terminal state. Anything ambiguous (a
        // timeout, a watch error, or fedimint's `UnexpectedError` — which also
        // fires when an ALREADY-SETTLED payment's change reclaim fails) maps to
        // `inflight`, never to a re-payable error: the caller journals the payout
        // `submitted` and reconciles. Only a confirmed preimage ⇒ settled, only a
        // confirmed refund/cancel ⇒ refunded.
        let terminal = watch_outgoing_pay(&ln, is_internal, operation_id).await;
        let settled_gateway = paying_gateway
            .as_ref()
            .filter(|_| matches!(terminal, Some(PayTerminal::Settled { .. })));
        if let Some(gateway) = settled_gateway {
            self.note_gateway_settled(gateway.gateway_id, Some(gateway)).await;
        }
        if terminal.is_none() {
            eprintln!(
                "pay: outgoing payment {operation_id:?} reached no fund-safe terminal state within \
                 {:?}, reporting inflight (reconcile via /pay-outcome)",
                PAY_AWAIT_TIMEOUT
            );
        }
        Ok(serde_json::to_value(pay_outcome_output(
            terminal,
            operation_id,
            fee_msat,
        ))?)
    }

    /// Reconcile a previously-submitted outgoing payment by operation id, without
    /// ever re-sending it (board #9 Part 3). Re-attaches to the payment and waits
    /// (bounded) for its terminal state: `settled` (preimage), `refunded` (sats
    /// returned), or `inflight` when it is still pending / unresolvable — biased
    /// to `inflight` so an unknown outcome never invites a re-pay.
    async fn pay_outcome(
        &self,
        client: &ClientHandleArc,
        operation_id: OperationId,
    ) -> Result<serde_json::Value> {
        let ln = client.get_first_module::<LightningClientModule>()?;
        // Claim payouts are EXTERNAL Lightning sends (the seller pays an external
        // NWC/LNURL invoice), so reconcile via the external pay-state stream. An
        // internal op (or any subscribe error) reaches no terminal here ⇒
        // `inflight` (fail-safe: keep the submitted record, never re-pay).
        let terminal = watch_outgoing_pay(&ln, false, operation_id).await;
        if terminal.is_none() {
            eprintln!("pay-outcome: {operation_id:?} not yet at a fund-safe terminal (inflight)");
        }
        Ok(serde_json::to_value(pay_outcome_output(
            terminal,
            operation_id,
            None,
        ))?)
    }

    /// V7 reconcile-by-escrow: resolve every outgoing payment ever stamped
    /// with this escrow id (`extra_meta.chama_escrow_id`, written by `/pay`)
    /// by scanning the fedimint operation log — the client DB persists it, so
    /// this survives an app crash that lost the JS-side operation id (the V7
    /// double-pay window). Never re-sends anything; observation only.
    ///
    /// Fund-safety contract of the verdicts:
    ///   settled  — SOME matching payment reached `success{preimage}`.
    ///   inflight — a matching payment exists but is not at a fund-safe
    ///              terminal ⇒ the caller must refuse to re-pay.
    ///   refunded — every matching payment was CONFIRMED refunded/canceled.
    ///   none     — the scan PROVABLY covered the window (reached ops older
    ///              than `since_ms`, or walked the whole log) and found no
    ///              match ⇒ no payment was ever dispatched.
    ///   (An incomplete scan — cap hit before `since_ms` — reports `unknown`
    ///   so the caller refuses now and reconciles again later.)
    async fn pay_outcome_by_escrow(
        &self,
        client: &ClientHandleArc,
        escrow_id: String,
        since_ms: Option<u64>,
    ) -> Result<serde_json::Value> {
        const PAGE: usize = 64;
        const SCAN_CAP: usize = 4096;
        let ln = client.get_first_module::<LightningClientModule>()?;
        let since: Option<SystemTime> =
            since_ms.map(|ms| UNIX_EPOCH + Duration::from_millis(ms));

        let mut matches: Vec<OperationId> = Vec::new();
        let mut last_seen = None;
        let mut scanned: usize = 0;
        let mut scan_complete = false;
        'pages: loop {
            let page = client
                .operation_log()
                .paginate_operations_rev(PAGE, last_seen)
                .await;
            if page.is_empty() {
                // Walked past the oldest entry — the whole log was covered.
                scan_complete = true;
                break;
            }
            for (key, entry) in &page {
                if let Some(since) = since {
                    if key.creation_time < since {
                        // Reached ops older than the journal record that
                        // triggered this reconcile — nothing before it can be
                        // the payment we're looking for.
                        scan_complete = true;
                        break 'pages;
                    }
                }
                scanned += 1;
                if entry.operation_module_kind() != "ln" {
                    continue;
                }
                let Ok(meta) = entry.try_meta::<LightningOperationMeta>() else {
                    continue;
                };
                if !matches!(meta.variant, LightningOperationMetaVariant::Pay(_)) {
                    continue;
                }
                if meta
                    .extra_meta
                    .get("chama_escrow_id")
                    .and_then(|v| v.as_str())
                    == Some(escrow_id.as_str())
                {
                    matches.push(key.operation_id);
                }
            }
            if scanned >= SCAN_CAP {
                break; // completeness unproven — "none" must not be claimed
            }
            last_seen = page.last().map(|(key, _)| *key);
        }

        if matches.is_empty() {
            let status = if scan_complete { "none" } else { "unknown" };
            eprintln!(
                "pay-outcome-by-escrow: {escrow_id} scanned={scanned} matches=0 -> {status}"
            );
            return Ok(json!({ "status": status }));
        }

        // Classify every match (bounded watch each; matches are ~1-2 in
        // practice). Fund-safest aggregation: any settled ⇒ settled (this
        // escrow's payout WAS paid — a re-pay would be the double-send);
        // else any non-terminal ⇒ inflight; else all refunded ⇒ refunded.
        let mut refunded_op: Option<OperationId> = None;
        let mut inflight_op: Option<OperationId> = None;
        for operation_id in matches {
            match watch_outgoing_pay(&ln, false, operation_id).await {
                Some(PayTerminal::Settled { .. }) => {
                    eprintln!(
                        "pay-outcome-by-escrow: {escrow_id} -> settled via {operation_id:?}"
                    );
                    return Ok(json!({
                        "status": "settled",
                        "operation_id": operation_id,
                    }));
                }
                Some(PayTerminal::Refunded { .. }) => refunded_op = Some(operation_id),
                None => inflight_op = Some(operation_id),
            }
        }
        if let Some(operation_id) = inflight_op {
            eprintln!("pay-outcome-by-escrow: {escrow_id} -> inflight via {operation_id:?}");
            return Ok(json!({
                "status": "inflight",
                "operation_id": operation_id,
            }));
        }
        eprintln!("pay-outcome-by-escrow: {escrow_id} -> refunded");
        Ok(json!({
            "status": "refunded",
            "operation_id": refunded_op,
        }))
    }

    async fn spend_notes(
        &self,
        client: &ClientHandleArc,
        amount_msats: u64,
        allow_overpay: bool,
        timeout_secs: u64,
        include_invite: bool,
    ) -> Result<SpendNotesOutput> {
        let mint = client.get_first_module::<MintClientModule>()?;
        let requested_amount = Amount::from_msats(amount_msats);
        let timeout = Duration::from_secs(timeout_secs);

        let (operation_id, notes) = if allow_overpay {
            mint.spend_notes_with_selector(
                &SelectNotesWithAtleastAmount,
                requested_amount,
                timeout,
                include_invite,
                (),
            )
            .await
        } else {
            mint.spend_notes_with_selector(
                &SelectNotesWithExactAmount,
                requested_amount,
                timeout,
                include_invite,
                (),
            )
            .await
        }
        .context("failed to spend e-cash notes")?;

        Ok(SpendNotesOutput {
            operation_id,
            requested_amount_msat: amount_msats,
            total_amount_msat: notes.total_amount().msats,
            notes: notes.to_string(),
        })
    }

    async fn reissue_notes(
        &self,
        client: &ClientHandleArc,
        notes: String,
        wait: bool,
    ) -> Result<ReissueNotesOutput> {
        let oob_notes = OOBNotes::from_str(&notes).context("invalid e-cash notes")?;
        let total_amount_msat = oob_notes.total_amount().msats;
        let mint = client.get_first_module::<MintClientModule>()?;
        let operation_id = mint
            .reissue_external_notes(oob_notes, ())
            .await
            .context("failed to start e-cash reissue")?;

        let mut status = "created".to_owned();
        if wait {
            let mut updates = mint
                .subscribe_reissue_external_notes(operation_id)
                .await
                .context("failed to subscribe to e-cash reissue")?
                .into_stream();

            while let Some(update) = updates.next().await {
                match update {
                    ReissueExternalNotesState::Done => {
                        status = "done".to_owned();
                        break;
                    }
                    ReissueExternalNotesState::Failed(error) => {
                        bail!("reissue failed: {error}");
                    }
                    other => {
                        status = format!("{other:?}");
                    }
                }
            }
        }

        Ok(ReissueNotesOutput {
            operation_id,
            total_amount_msat,
            status,
        })
    }

    async fn onchain_info(&self, client: &ClientHandleArc) -> Result<OnchainInfoOutput> {
        let wallet = client.get_first_module::<WalletClientModule>()?;
        let fees = wallet.get_fee_consensus();
        let peg_in_fee_sats = amount_to_floor_sats(fees.peg_in_abs);
        Ok(OnchainInfoOutput {
            network: wallet.get_network().to_string(),
            finality_delay: wallet.get_finality_delay(),
            peg_in_fee_sats,
            peg_out_fee_sats: amount_to_floor_sats(fees.peg_out_abs),
            minimum_deposit_sats: peg_in_fee_sats.saturating_add(1),
        })
    }

    async fn onchain_deposit_address(
        &self,
        client: &ClientHandleArc,
    ) -> Result<OnchainDepositAddressOutput> {
        let wallet = client.get_first_module::<WalletClientModule>()?;
        let finality_delay = wallet.get_finality_delay();
        let (operation_id, address, tweak_idx) = wallet
            .safe_allocate_deposit_address(json!({
                "app": "chama",
                "kind": "onchain-escrow-funding",
            }))
            .await
            .context("failed to allocate safe on-chain deposit address")?;

        Ok(OnchainDepositAddressOutput {
            operation_id,
            address: address.to_string(),
            tweak_idx,
            finality_delay,
        })
    }

    async fn await_onchain_deposit(
        &self,
        client: &ClientHandleArc,
        operation_id: OperationId,
    ) -> Result<OnchainDepositSettledOutput> {
        let wallet = client.get_first_module::<WalletClientModule>()?;
        let mut updates = wallet
            .subscribe_deposit(operation_id)
            .await
            .context("failed to subscribe to on-chain deposit")?
            .into_stream();

        while let Some(update) = updates.next().await {
            match update {
                DepositStateV2::Claimed {
                    btc_deposited,
                    btc_out_point,
                } => {
                    return Ok(OnchainDepositSettledOutput {
                        status: "claimed".to_owned(),
                        operation_id,
                        amount_sats: Some(btc_deposited.to_sat()),
                        outpoint: Some(btc_out_point.to_string()),
                        info: info_output(client).await?,
                    });
                }
                DepositStateV2::Failed(error) => bail!("on-chain deposit failed: {error}"),
                _ => {}
            }
        }

        bail!("on-chain deposit update stream ended before claim")
    }

    async fn onchain_withdraw_fees(
        &self,
        client: &ClientHandleArc,
        address: String,
        amount_sats: u64,
    ) -> Result<OnchainWithdrawFeesOutput> {
        let wallet = client.get_first_module::<WalletClientModule>()?;
        let address = parse_bitcoin_address(&address, wallet.get_network())?;
        let amount = BitcoinAmount::from_sat(amount_sats);
        let fees = wallet
            .get_withdraw_fees(&address, amount)
            .await
            .context("failed to fetch on-chain withdraw fees")?;
        let fees_sats = fees.amount().to_sat();

        Ok(OnchainWithdrawFeesOutput {
            amount_sats,
            fees_sats,
            total_sats: amount_sats.saturating_add(fees_sats),
        })
    }

    async fn onchain_withdraw(
        &self,
        client: &ClientHandleArc,
        address: String,
        amount_sats: u64,
        no_wait: bool,
    ) -> Result<OnchainWithdrawOutput> {
        let wallet = client.get_first_module::<WalletClientModule>()?;
        let address = parse_bitcoin_address(&address, wallet.get_network())?;
        let amount = BitcoinAmount::from_sat(amount_sats);
        let fees = wallet
            .get_withdraw_fees(&address, amount)
            .await
            .context("failed to fetch on-chain withdraw fees")?;
        let fees_sats = fees.amount().to_sat();
        let operation_id = wallet
            .withdraw(
                &address,
                amount,
                fees,
                json!({
                    "app": "chama",
                    "kind": "onchain-escrow-payout",
                }),
            )
            .await
            .context("failed to start on-chain withdraw")?;

        if no_wait {
            return Ok(OnchainWithdrawOutput {
                operation_id,
                status: "created".to_owned(),
                txid: None,
                fees_sats,
            });
        }

        let mut updates = wallet
            .subscribe_withdraw_updates(operation_id)
            .await
            .context("failed to subscribe to on-chain withdraw")?
            .into_stream();

        while let Some(update) = updates.next().await {
            match update {
                WithdrawState::Succeeded(txid) => {
                    return Ok(OnchainWithdrawOutput {
                        operation_id,
                        status: "succeeded".to_owned(),
                        txid: Some(txid.to_string()),
                        fees_sats,
                    });
                }
                WithdrawState::Failed(error) => bail!("on-chain withdraw failed: {error}"),
                WithdrawState::Created => {}
            }
        }

        bail!("on-chain withdraw update stream ended before success")
    }

    async fn client_builder(&self) -> Result<(ClientBuilder, Database)> {
        let mut builder = Client::builder()
            .await
            .context("failed to create Fedimint client builder")?
            .with_iroh_enable_dht(self.iroh_enable_dht)
            .with_iroh_enable_next(self.iroh_enable_next);
        builder.with_module_inits(default_module_inits());

        let db = load_database(&self.data_dir).await?;
        Ok((builder, db))
    }

    async fn connectors(&self) -> Result<ConnectorRegistry> {
        let mut builder = ConnectorRegistry::build_from_client_defaults()
            .iroh_pkarr_dht(self.iroh_enable_dht)
            .iroh_next(self.iroh_enable_next);

        if let Some(iroh_dns) = &self.iroh_dns {
            builder = builder.set_iroh_dns(iroh_dns.clone());
        }

        builder
            .bind()
            .await
            .context("failed to bind Fedimint connectors")
    }
}

#[derive(Clone)]
struct AppState {
    bridge: Bridge,
    client: Arc<Mutex<Option<ClientHandleArc>>>,
    /// Database directory selected by the active client. The base directory is
    /// retained as the legacy/first federation; bonded arbiters get one sibling
    /// directory per additional federation.
    active_data_dir: Arc<Mutex<PathBuf>>,
    discovery: Arc<Mutex<DiscoveryProbe>>,
    /// Every route requires `Authorization: Bearer <token>`.
    auth_token: Arc<str>,
    /// Exact HTTP authority accepted by this listener.
    allowed_host: Arc<str>,
    /// Exact browser origins accepted by this listener. An empty list means
    /// originless native/proxy calls only, never a permissive browser policy.
    allowed_origins: Arc<Vec<HeaderValue>>,
}

/// Byte-wise constant-time equality: examines every byte regardless of where
/// the first mismatch sits, so response timing can't binary-search the token.
/// The length check short-circuits, which leaks only the token's length —
/// harmless for the high-entropy random tokens this protects.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b.iter()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

async fn require_bearer_auth(
    State(state): State<AppState>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let presented = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim);

    match presented {
        Some(token) if constant_time_eq(token.as_bytes(), state.auth_token.as_bytes()) => {
            next.run(request).await
        }
        _ => (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "missing or invalid bridge auth token" })),
        )
            .into_response(),
    }
}

async fn require_exact_host(
    State(state): State<AppState>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let presented = request
        .headers()
        .get(HOST)
        .and_then(|value| value.to_str().ok());
    if presented == Some(state.allowed_host.as_ref()) {
        return next.run(request).await;
    }
    (
        StatusCode::MISDIRECTED_REQUEST,
        Json(json!({ "error": "invalid bridge host" })),
    )
        .into_response()
}

async fn require_allowed_origin(
    State(state): State<AppState>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let Some(presented) = request.headers().get(ORIGIN) else {
        return next.run(request).await;
    };
    if state.allowed_origins.iter().any(|allowed| allowed == presented) {
        return next.run(request).await;
    }
    (
        StatusCode::FORBIDDEN,
        Json(json!({ "error": "invalid bridge origin" })),
    )
        .into_response()
}

fn amount_to_floor_sats(amount: Amount) -> u64 {
    amount.msats / 1000
}

/// Rank a gateway's API transport for native receive-gateway preference.
/// Clearnet (`http`/`https`) is reachable everywhere; `iroh://` gateways often
/// aren't on mobile/CGNAT (the same transport limit that makes a fresh join
/// finicky on phones), so they sort last. Unknown schemes sit in between.
fn gateway_scheme_rank(gateway: &LightningGateway) -> u8 {
    match gateway.api.scheme() {
        "https" | "http" => 0,
        "iroh" => 2,
        _ => 1,
    }
}

#[derive(Debug)]
struct ApiError(anyhow::Error);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = Json(json!({
            "error": format!("{:#}", self.0),
        }));
        (StatusCode::INTERNAL_SERVER_ERROR, body).into_response()
    }
}

impl<E> From<E> for ApiError
where
    E: Into<anyhow::Error>,
{
    fn from(error: E) -> Self {
        Self(error.into())
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JoinRequest {
    invite_code: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InvoiceRequest {
    amount_msats: u64,
    description: Option<String>,
    expiry_time: Option<u64>,
    gateway_id: Option<String>,
    force_internal: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AwaitInvoiceRequest {
    operation_id: OperationId,
    /// How long to hold the watch before answering `pending`. Omitted by older
    /// clients, which expect the request to stay open — they keep the previous
    /// unbounded behaviour.
    wait_secs: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PayOutcomeRequest {
    operation_id: OperationId,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PayRequest {
    payment_info: String,
    amount_msats: Option<u64>,
    lnurl_comment: Option<String>,
    gateway_id: Option<String>,
    force_internal: Option<bool>,
    no_wait: Option<bool>,
    /// V7: stamped into the payment's operation-log entry (fedimint
    /// `extra_meta`) — the durable op↔escrow map `/pay-outcome-by-escrow`
    /// reconciles against.
    extra_meta: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PayOutcomeByEscrowRequest {
    escrow_id: String,
    /// Scan bound (Unix ms): ops older than this can't be the payment being
    /// reconciled, so reaching them proves a `none` verdict complete.
    since_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpendNotesRequest {
    amount_msats: u64,
    allow_overpay: Option<bool>,
    timeout_secs: Option<u64>,
    include_invite: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReissueNotesRequest {
    notes: String,
    wait: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ParseNotesRequest {
    notes: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AwaitOnchainDepositRequest {
    operation_id: OperationId,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OnchainWithdrawFeesRequest {
    address: String,
    amount_sats: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OnchainWithdrawRequest {
    address: String,
    amount_sats: u64,
    no_wait: Option<bool>,
}

async fn serve_bridge(
    bridge: Bridge,
    bind: SocketAddr,
    invite_code: Option<String>,
    auth_token: String,
    allowed_origins: Vec<String>,
) -> Result<()> {
    let auth_token = auth_token.trim();
    if auth_token.len() < 32 {
        anyhow::bail!("--auth-token must contain at least 32 characters");
    }
    let auth_token: Arc<str> = Arc::from(auth_token.to_owned());
    let allowed_host: Arc<str> = Arc::from(bind.to_string());
    let allowed_origins = allowed_origins
        .iter()
        .map(|origin| {
            origin
                .trim()
                .trim_end_matches('/')
                .parse::<HeaderValue>()
                .with_context(|| format!("invalid --allowed-origin {origin:?}"))
        })
        .collect::<Result<Vec<_>>>()?;

    let probe_target = bridge.discovery_probe_target();
    let initial_probe = match &probe_target {
        Some(addr) => DiscoveryProbe::probing(addr),
        None => DiscoveryProbe::skipped("no PKARR resolver configured"),
    };
    let state = AppState {
        active_data_dir: Arc::new(Mutex::new(bridge.data_dir.clone())),
        bridge,
        client: Arc::new(Mutex::new(None)),
        discovery: Arc::new(Mutex::new(initial_probe)),
        auth_token,
        allowed_host,
        allowed_origins: Arc::new(allowed_origins.clone()),
    };

    // Boot-time readiness probe: confirm the device can actually reach the
    // configured HTTPS PKARR relay (DNS + :443). Runs off the hot path so it
    // never delays serving; /health reports the cached outcome so the app can
    // show "discovery degraded" instead of letting a fresh join silently
    // time out.
    {
        let discovery = state.discovery.clone();
        tokio::spawn(async move {
            let outcome = run_discovery_probe(probe_target).await;
            *discovery.lock().await = outcome;
        });
    }

    if let Some(invite_code) = invite_code {
        let client = state.bridge.open_or_join(&invite_code).await?;
        *state.client.lock().await = Some(client);
    }

    // CORS: exact-origin allowlist when configured (the remote "friend
    // wallet" shape — must name the app origin), else the historical
    // permissive localhost behavior. `allow_headers(Any)` covers the
    // Authorization header the auth layer requires.
    let cors = if allowed_origins.is_empty() {
        CorsLayer::new()
            .allow_origin(Any)
            .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
            .allow_headers(Any)
    } else {
        CorsLayer::new()
            .allow_origin(allowed_origins)
            .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
            .allow_headers(Any)
    };
    let app = Router::new()
        .route("/health", get(api_health))
        .route("/join", post(api_join))
        .route("/switch", post(api_switch))
        .route("/reset", post(api_reset))
        .route("/info", get(api_info))
        .route("/gateways", get(api_gateways))
        .route("/probe-gateways", get(api_probe_gateways))
        .route("/invoice", post(api_invoice))
        .route("/await-invoice", post(api_await_invoice))
        .route("/pay", post(api_pay))
        .route("/pay-outcome", post(api_pay_outcome))
        .route("/pay-outcome-by-escrow", post(api_pay_outcome_by_escrow))
        .route("/spend-notes", post(api_spend_notes))
        .route("/reissue-notes", post(api_reissue_notes))
        .route("/parse-notes", post(api_parse_notes))
        .route("/onchain/info", get(api_onchain_info))
        .route(
            "/onchain/deposit-address",
            post(api_onchain_deposit_address),
        )
        .route("/onchain/await-deposit", post(api_await_onchain_deposit))
        .route("/onchain/withdraw-fees", post(api_onchain_withdraw_fees))
        .route("/onchain/withdraw", post(api_onchain_withdraw))
        // Auth wraps every route (including /health — it leaks federation
        // and gateway info). CORS is layered LAST so it sits OUTSIDE auth:
        // browser preflight OPTIONS requests carry no Authorization header
        // and must be answered by the CORS layer, never 401'd.
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            require_bearer_auth,
        ))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            require_exact_host,
        ))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            require_allowed_origin,
        ))
        .layer(cors)
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .with_context(|| format!("failed to bind {bind}"))?;
    eprintln!(
        "chama-fedimint-bridge listening on http://{bind} (bearer auth and exact Host required)",
    );
    axum::serve(listener, app).await?;
    Ok(())
}

impl AppState {
    async fn client(&self) -> Result<ClientHandleArc> {
        let mut guard = self.client.lock().await;
        if let Some(client) = guard.as_ref() {
            return Ok(client.clone());
        }

        let client = self.bridge.open().await?;
        *guard = Some(client.clone());
        Ok(client)
    }

    async fn join(&self, invite_code: &str) -> Result<ClientHandleArc> {
        let client = self.bridge.open_or_join(invite_code).await?;
        *self.client.lock().await = Some(client.clone());
        *self.active_data_dir.lock().await = self.bridge.data_dir.clone();
        Ok(client)
    }

    async fn switch_preserving(&self, invite_code: &str) -> Result<ClientHandleArc> {
        let invite = InviteCode::from_str(invite_code)
            .context("invalid federation invite code")?;
        let target_id = invite.federation_id().to_string();
        if !target_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            bail!("federation id contains characters unsafe for a local storage path");
        }

        let current = self.client().await?;
        let current_id = current.federation_id().to_string();
        if current_id == target_id {
            return Ok(current);
        }

        let mut routes = self.load_arbiter_routes().await;
        let active_dir = self.active_data_dir.lock().await.clone();
        routes.insert(current_id, self.route_for_path(&active_dir));
        let target_route = routes
            .get(&target_id)
            .cloned()
            .unwrap_or_else(|| format!("{ARBITER_FEDERATION_DIR}/{target_id}"));
        let target_dir = self.path_for_route(&target_route)?;
        let target_bridge = self.bridge.with_data_dir(target_dir.clone());
        let client = target_bridge.open_or_join(invite_code).await?;

        routes.insert(target_id, target_route);
        self.save_arbiter_routes(&routes).await?;
        *self.client.lock().await = Some(client.clone());
        *self.active_data_dir.lock().await = target_dir;
        Ok(client)
    }

    fn route_for_path(&self, path: &Path) -> String {
        match path.strip_prefix(&self.bridge.data_dir) {
            Ok(relative) if relative.as_os_str().is_empty() => ".".to_owned(),
            Ok(relative) => relative.to_string_lossy().to_string(),
            Err(_) => ".".to_owned(),
        }
    }

    fn path_for_route(&self, route: &str) -> Result<PathBuf> {
        if route == "." {
            return Ok(self.bridge.data_dir.clone());
        }
        let relative = Path::new(route);
        if relative.is_absolute()
            || relative.components().any(|part| matches!(part, std::path::Component::ParentDir))
        {
            bail!("invalid arbiter federation storage route");
        }
        Ok(self.bridge.data_dir.join(relative))
    }

    async fn load_arbiter_routes(&self) -> BTreeMap<String, String> {
        let path = self.bridge.data_dir.join(ARBITER_FEDERATION_ROUTES_FILE);
        let Ok(raw) = tokio::fs::read_to_string(path).await else {
            return BTreeMap::new();
        };
        serde_json::from_str(&raw).unwrap_or_default()
    }

    async fn save_arbiter_routes(&self, routes: &BTreeMap<String, String>) -> Result<()> {
        tokio::fs::create_dir_all(&self.bridge.data_dir).await?;
        let path = self.bridge.data_dir.join(ARBITER_FEDERATION_ROUTES_FILE);
        let temp = self.bridge.data_dir.join(format!("{ARBITER_FEDERATION_ROUTES_FILE}.tmp"));
        tokio::fs::write(&temp, serde_json::to_vec(routes)?).await?;
        tokio::fs::rename(&temp, &path).await?;
        Ok(())
    }

    async fn reset(&self) -> Result<()> {
        let stale_client = self.client.lock().await.take();
        drop(stale_client);
        let active_dir = self.active_data_dir.lock().await.clone();
        self.bridge.with_data_dir(active_dir).reset_local_state().await
    }
}

/// Boot-time discovery readiness probe. A successful TCP connect to the PKARR
/// resolver's host:443 confirms the device can both resolve DNS and reach the
/// HTTPS discovery relay — the exact dependency a fresh native join leans on.
/// It is deliberately lightweight (no TLS, no guardian round-trip): it catches
/// the common launch failures (no network, captive portal, blocked :443) cheaply
/// so /health can flag "degraded" up front.
async fn run_discovery_probe(target: Option<String>) -> DiscoveryProbe {
    let Some(addr) = target else {
        return DiscoveryProbe::skipped("no PKARR resolver configured");
    };
    match tokio::time::timeout(
        DISCOVERY_PROBE_TIMEOUT,
        tokio::net::TcpStream::connect(&addr),
    )
    .await
    {
        Ok(Ok(_stream)) => DiscoveryProbe {
            status: "reachable".to_owned(),
            target: addr,
            detail: None,
        },
        Ok(Err(err)) => DiscoveryProbe {
            status: "degraded".to_owned(),
            target: addr,
            detail: Some(truncate_detail(&err.to_string())),
        },
        Err(_) => DiscoveryProbe {
            status: "degraded".to_owned(),
            target: addr,
            detail: Some(format!(
                "no TCP connect within {}s",
                DISCOVERY_PROBE_TIMEOUT.as_secs()
            )),
        },
    }
}

fn truncate_detail(message: &str) -> String {
    const MAX_CHARS: usize = 160;
    if message.chars().count() <= MAX_CHARS {
        message.to_owned()
    } else {
        let mut out: String = message.chars().take(MAX_CHARS).collect();
        out.push('…');
        out
    }
}

async fn api_health(State(state): State<AppState>) -> Json<serde_json::Value> {
    let joined =
        state.client.lock().await.is_some() || state.bridge.local_client_db_present().await;
    let discovery = state.discovery.lock().await.clone();
    Json(json!({
        "ok": true,
        "joined": joined,
        // V7 (pay reconcile-by-escrow) shipped in api_version 3 — the
        // `/health` probe is how a rebuilt sidecar is confirmed live.
        "api_version": 3,
        "join_timeout_secs": FEDERATION_JOIN_TIMEOUT.as_secs(),
        "iroh": state.bridge.iroh_config_diagnostics(),
        "discovery": discovery,
        "capabilities": [
            "reset",
            "idempotent_join",
            "effective_iroh_config",
            "discovery_probe",
            // `/await-invoice` honours `waitSecs` and can answer `pending`.
            // Advertised, never required: older sidecars simply hold the
            // request open and the client's transport re-arm covers them.
            "bounded_await_invoice",
            "pay_outcome_by_escrow",
            "auth_token",
            "multi_federation_switch",
        ],
    }))
}

async fn api_join(
    State(state): State<AppState>,
    Json(req): Json<JoinRequest>,
) -> Result<Json<JoinOutput>, ApiError> {
    let client = state.join(&req.invite_code).await?;
    Ok(Json(JoinOutput {
        joined: req.invite_code,
        federation_id: client.federation_id().to_string(),
    }))
}

async fn api_switch(
    State(state): State<AppState>,
    Json(req): Json<JoinRequest>,
) -> Result<Json<JoinOutput>, ApiError> {
    let client = state.switch_preserving(&req.invite_code).await?;
    Ok(Json(JoinOutput {
        joined: req.invite_code,
        federation_id: client.federation_id().to_string(),
    }))
}

async fn api_reset(State(state): State<AppState>) -> Result<Json<serde_json::Value>, ApiError> {
    state.reset().await?;
    Ok(Json(json!({ "ok": true })))
}

async fn api_info(State(state): State<AppState>) -> Result<Json<InfoOutput>, ApiError> {
    let client = state.client().await?;
    Ok(Json(info_output(&client).await?))
}

async fn api_gateways(
    State(state): State<AppState>,
    Query(query): Query<BTreeMap<String, String>>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let no_update = query
        .get("noUpdate")
        .or_else(|| query.get("no_update"))
        .is_some_and(|value| value == "1" || value.eq_ignore_ascii_case("true"));
    let client = state.client().await?;
    let gateways = state.bridge.list_gateways(&client, no_update).await?;
    Ok(Json(json!({
        "gateway_count": gateways.len(),
        "gateways": gateways,
    })))
}

async fn api_probe_gateways(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let client = state.client().await?;
    let probes = state.bridge.probe_gateways(&client).await?;
    Ok(Json(json!({
        "gateway_count": probes.len(),
        "probes": probes,
    })))
}

async fn api_invoice(
    State(state): State<AppState>,
    Json(req): Json<InvoiceRequest>,
) -> Result<Json<InvoiceOutput>, ApiError> {
    let gateway_id = parse_optional_public_key(req.gateway_id.as_deref())?;
    let client = state.client().await?;
    Ok(Json(
        state
            .bridge
            .invoice(
                &client,
                req.amount_msats,
                req.description
                    .unwrap_or_else(|| "Chama Fedimint native test".to_owned()),
                req.expiry_time,
                gateway_id,
                req.force_internal.unwrap_or(false),
            )
            .await?,
    ))
}

async fn api_await_invoice(
    State(state): State<AppState>,
    Json(req): Json<AwaitInvoiceRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let client = state.client().await?;
    Ok(Json(
        state
            .bridge
            .await_invoice(&client, req.operation_id, req.wait_secs.unwrap_or(0))
            .await?,
    ))
}

async fn api_pay(
    State(state): State<AppState>,
    Json(req): Json<PayRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let gateway_id = parse_optional_public_key(req.gateway_id.as_deref())?;
    let client = state.client().await?;
    Ok(Json(
        state
            .bridge
            .pay(
                &client,
                req.payment_info,
                req.amount_msats,
                req.lnurl_comment,
                gateway_id,
                req.force_internal.unwrap_or(false),
                req.no_wait.unwrap_or(false),
                req.extra_meta,
            )
            .await?,
    ))
}

async fn api_pay_outcome(
    State(state): State<AppState>,
    Json(req): Json<PayOutcomeRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let client = state.client().await?;
    Ok(Json(
        state
            .bridge
            .pay_outcome(&client, req.operation_id)
            .await?,
    ))
}

async fn api_pay_outcome_by_escrow(
    State(state): State<AppState>,
    Json(req): Json<PayOutcomeByEscrowRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let client = state.client().await?;
    Ok(Json(
        state
            .bridge
            .pay_outcome_by_escrow(&client, req.escrow_id, req.since_ms)
            .await?,
    ))
}

async fn api_spend_notes(
    State(state): State<AppState>,
    Json(req): Json<SpendNotesRequest>,
) -> Result<Json<SpendNotesOutput>, ApiError> {
    let client = state.client().await?;
    Ok(Json(
        state
            .bridge
            .spend_notes(
                &client,
                req.amount_msats,
                req.allow_overpay.unwrap_or(false),
                req.timeout_secs.unwrap_or(60 * 60 * 24 * 7),
                req.include_invite.unwrap_or(false),
            )
            .await?,
    ))
}

async fn api_reissue_notes(
    State(state): State<AppState>,
    Json(req): Json<ReissueNotesRequest>,
) -> Result<Json<ReissueNotesOutput>, ApiError> {
    let client = state.client().await?;
    Ok(Json(
        state
            .bridge
            .reissue_notes(&client, req.notes, req.wait.unwrap_or(true))
            .await?,
    ))
}

async fn api_parse_notes(
    Json(req): Json<ParseNotesRequest>,
) -> Result<Json<ParseNotesOutput>, ApiError> {
    Ok(Json(parse_notes(&req.notes)?))
}

async fn api_onchain_info(
    State(state): State<AppState>,
) -> Result<Json<OnchainInfoOutput>, ApiError> {
    let client = state.client().await?;
    Ok(Json(state.bridge.onchain_info(&client).await?))
}

async fn api_onchain_deposit_address(
    State(state): State<AppState>,
) -> Result<Json<OnchainDepositAddressOutput>, ApiError> {
    let client = state.client().await?;
    Ok(Json(state.bridge.onchain_deposit_address(&client).await?))
}

async fn api_await_onchain_deposit(
    State(state): State<AppState>,
    Json(req): Json<AwaitOnchainDepositRequest>,
) -> Result<Json<OnchainDepositSettledOutput>, ApiError> {
    let client = state.client().await?;
    Ok(Json(
        state
            .bridge
            .await_onchain_deposit(&client, req.operation_id)
            .await?,
    ))
}

async fn api_onchain_withdraw_fees(
    State(state): State<AppState>,
    Json(req): Json<OnchainWithdrawFeesRequest>,
) -> Result<Json<OnchainWithdrawFeesOutput>, ApiError> {
    let client = state.client().await?;
    Ok(Json(
        state
            .bridge
            .onchain_withdraw_fees(&client, req.address, req.amount_sats)
            .await?,
    ))
}

async fn api_onchain_withdraw(
    State(state): State<AppState>,
    Json(req): Json<OnchainWithdrawRequest>,
) -> Result<Json<OnchainWithdrawOutput>, ApiError> {
    let client = state.client().await?;
    Ok(Json(
        state
            .bridge
            .onchain_withdraw(
                &client,
                req.address,
                req.amount_sats,
                req.no_wait.unwrap_or(false),
            )
            .await?,
    ))
}

fn parse_notes(notes: &str) -> Result<ParseNotesOutput> {
    let notes = OOBNotes::from_str(notes).context("invalid e-cash notes")?;
    Ok(ParseNotesOutput {
        total_amount_msat: notes.total_amount().msats,
        federation_id_prefix: notes.federation_id_prefix().to_string(),
        notes_json: notes.notes_json()?,
    })
}

fn parse_optional_public_key(value: Option<&str>) -> Result<Option<PublicKey>> {
    value
        .filter(|value| !value.trim().is_empty())
        .map(PublicKey::from_str)
        .transpose()
        .context("invalid gateway id")
}

fn parse_bitcoin_address(
    value: &str,
    network: fedimint_core::bitcoin::Network,
) -> Result<BitcoinAddress> {
    BitcoinAddress::<NetworkUnchecked>::from_str(value)
        .context("invalid bitcoin address")?
        .require_network(network)
        .with_context(|| format!("bitcoin address is not valid for {network}"))
}

async fn load_database(data_dir: &Path) -> Result<Database> {
    tokio::fs::create_dir_all(data_dir)
        .await
        .with_context(|| format!("failed to create data dir {}", data_dir.display()))?;
    let db_path = data_dir.join("client.db");
    Ok(fedimint_rocksdb::RocksDb::build(db_path)
        .open()
        .await
        .context("could not open rocksdb database")?
        .into())
}

async fn load_or_generate_mnemonic(db: &Database) -> Result<Mnemonic> {
    if let Ok(entropy) = Client::load_decodable_client_secret::<Vec<u8>>(db).await {
        Mnemonic::from_entropy(&entropy).context("invalid stored mnemonic entropy")
    } else {
        let mnemonic = Bip39RootSecretStrategy::<12>::random(&mut thread_rng());
        Client::store_encodable_client_secret(db, mnemonic.to_entropy())
            .await
            .context("failed to store client secret")?;
        Ok(mnemonic)
    }
}

fn root_secret_from_mnemonic(mnemonic: &Mnemonic) -> RootSecret {
    RootSecret::StandardDoubleDerive(Bip39RootSecretStrategy::<12>::to_root_secret(mnemonic))
}

fn default_module_inits() -> ClientModuleInitRegistry {
    let mut registry = ClientModuleInitRegistry::new();
    registry.attach(LightningClientInit::default());
    registry.attach(MintClientInit);
    registry.attach(fedimint_mintv2_client::MintClientInit);
    registry.attach(WalletClientInit::default());
    registry.attach(MetaClientInit);
    registry.attach(fedimint_lnv2_client::LightningClientInit::default());
    registry.attach(fedimint_walletv2_client::WalletClientInit);
    registry
}

async fn info_output(client: &ClientHandleArc) -> Result<InfoOutput> {
    let config = client.config().await;
    let balance = client
        .get_balance_for_btc()
        .await
        .context("failed to load BTC balance")?;
    let network = if let Ok(wallet) = client.get_first_module::<WalletClientModule>() {
        wallet.get_network().to_string()
    } else if let Ok(wallet) =
        client.get_first_module::<fedimint_walletv2_client::WalletClientModule>()
    {
        wallet.get_network().to_string()
    } else {
        "unknown".to_owned()
    };

    Ok(InfoOutput {
        federation_id: client.federation_id().to_string(),
        network,
        total_amount_msat: balance.msats,
        meta: serde_json::to_value(&config.global.meta)?,
    })
}

fn init_tracing() {
    let filter = std::env::var("RUST_LOG").unwrap_or_else(|_| "warn".to_owned());
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .try_init();
}

fn print_json<T: Serialize>(value: &T) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}
