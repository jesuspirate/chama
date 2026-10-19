//! Dev-only CLI proof. No HTTP handler, no source client, no spending methods.
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use fedimint_client::Client;
use fedimint_core::db::{Database, IDatabaseTransactionOpsCore};
use fedimint_core::invite_code::InviteCode;
use fedimint_core::module::AmountUnit;
use fedimint_mint_client::api::MintFederationApi;
use futures::StreamExt;
use serde::Serialize;

use crate::{Bridge, default_module_inits, root_secret_from_mnemonic};
use fedimint_bip39::Mnemonic;
use std::str::FromStr;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecoveryCheckOutput {
    federation_id: String,
    recovered_balance_msat: u64,
    source_balance_msat: u64,
    recovery_completed: bool,
    from_backup: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    recovery_method: Option<&'static str>,
    elapsed_seconds: u64,
}

/// Reject overlap and symlinks before creating or deleting anything. The
/// existing parent must resolve outside the source tree in either direction.
fn validate_paths(source: &Path, scratch: &Path) -> Result<(PathBuf, PathBuf)> {
    let source = source
        .canonicalize()
        .context("source data directory does not exist")?;
    if !source.join("client.db").is_dir() {
        bail!("source client.db is missing; no source wallet was created");
    }
    let scratch = if scratch.is_absolute() {
        scratch.to_path_buf()
    } else {
        std::env::current_dir()?.join(scratch)
    };
    let name = scratch
        .file_name()
        .context("scratch must name a dedicated directory")?;
    let parent = scratch
        .parent()
        .context("scratch parent is missing")?
        .canonicalize()
        .context("scratch parent must already exist")?;
    let scratch = parent.join(name);
    if scratch.starts_with(&source) || source.starts_with(&scratch) {
        bail!("scratch and source directories must not overlap");
    }
    match std::fs::symlink_metadata(&scratch) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                bail!("scratch must be a new or empty directory, not a symlink or file");
            }
            if std::fs::read_dir(&scratch)?.next().is_some() {
                bail!("scratch directory is non-empty; refusing to modify it");
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok((source, scratch))
}

/// Own only a directory created exclusively by this invocation. Clean up on
/// ordinary failure too; interruption/crash can leave it for explicit removal.
struct ScratchDir(PathBuf);
impl ScratchDir {
    fn create(path: PathBuf) -> Result<Self> {
        // remove_dir refuses if another process filled a pre-existing empty
        // directory; create_dir refuses if anyone won the creation race.
        if path.exists() {
            std::fs::remove_dir(&path).context("scratch stopped being empty")?;
        }
        let mut creator = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            creator.mode(0o700);
        }
        creator
            .create(&path)
            .context("could not exclusively create scratch directory")?;
        Ok(Self(path))
    }
    fn cleanup(self) -> Result<()> {
        std::fs::remove_dir_all(&self.0).context("could not delete scratch wallet; do not use it")
    }
}
impl Drop for ScratchDir {
    fn drop(&mut self) {
        if self.0.exists() && std::fs::remove_dir_all(&self.0).is_err() {
            eprintln!(
                "Could not delete scratch recovery wallet. Do not use it; remove the scratch directory manually."
            );
        }
    }
}

pub(crate) async fn run(
    bridge: &Bridge,
    source: &Path,
    invite: &str,
    scratch: &Path,
    timeout: Duration,
    from_backup: bool,
) -> Result<RecoveryCheckOutput> {
    let started = Instant::now();
    let (source, scratch) = validate_paths(source, scratch)?;
    let invite = InviteCode::from_str(invite).context("invalid recovery federation invite")?;
    // Read-only DB: never run Bridge::open, its client builder, migrations or
    // load_or_generate_mnemonic against the source.
    let source_db: Database =
        fedimint_rocksdb::RocksDbReadOnly::open_read_only(source.join("client.db"))
            .await
            .context("could not open source database read-only")?
            .into();
    let mut entropy = Client::load_decodable_client_secret::<Vec<u8>>(&source_db)
        .await
        .context("stored source client secret is missing or unreadable")?;
    let mnemonic = Mnemonic::from_entropy(&entropy);
    entropy.fill(0);
    let mnemonic = mnemonic.context("invalid stored source secret")?;
    let config = Client::get_config_from_db(&source_db)
        .await
        .context("source federation config is missing")?;
    if config.calculate_federation_id() != invite.federation_id() {
        bail!("invite belongs to a different federation than the source wallet");
    }
    let scratch = ScratchDir::create(scratch)?;
    let mut scratch_bridge = bridge.clone();
    scratch_bridge.data_dir = scratch.0.clone();
    let result = recover(
        &scratch_bridge,
        &source_db,
        &mnemonic,
        invite,
        timeout,
        from_backup,
    )
    .await;
    // Close clients before deleting their DB; print success only after cleanup.
    scratch.cleanup()?;
    let (federation_id, recovered_balance_msat, source_balance_msat, recovery_method) = result?;
    Ok(RecoveryCheckOutput {
        federation_id,
        recovered_balance_msat,
        source_balance_msat,
        recovery_completed: true,
        from_backup,
        recovery_method,
        elapsed_seconds: started.elapsed().as_secs(),
    })
}

#[allow(deprecated)] // Explicit comparison of snapshot vs seed-only on pinned 0.11.1.
async fn recover(
    bridge: &Bridge,
    source_db: &Database,
    mnemonic: &Mnemonic,
    invite: InviteCode,
    timeout: Duration,
    from_backup: bool,
) -> Result<(String, u64, u64, Option<&'static str>)> {
    let started = Instant::now();
    let (mut builder, db) = bridge.client_builder().await?;
    builder.stopped(); // module recovery first; recovered outputs run only after reopen
    let client = tokio::time::timeout(timeout, async {
        let preview = builder.preview(bridge.connectors().await?, &invite).await?;
        let backup = if from_backup {
            Some(require_snapshot(
                preview
                    .download_backup_from_federation(root_secret_from_mnemonic(mnemonic))
                    .await?,
            )?)
        } else {
            None
        };
        preview
            .recover(db.clone(), root_secret_from_mnemonic(mnemonic), backup)
            .await
    })
    .await
    .context("recovery timed out before client initialization")??;
    let remaining = timeout.saturating_sub(started.elapsed());
    let finished = tokio::time::timeout(remaining, client.wait_for_all_recoveries()).await;
    client.shutdown().await;
    finished.context("module recovery timed out; scratch wallet discarded")??;

    // Recovering modules are unavailable until reopened. Enable the scratch
    // executor so recovery-created mint outputs can collect signatures. No
    // new operations are submitted to this client.
    let mut builder = Client::builder()
        .await?
        .with_iroh_enable_dht(bridge.iroh_enable_dht)
        .with_iroh_enable_next(bridge.iroh_enable_next);
    builder.with_module_inits(default_module_inits());
    let remaining = timeout.saturating_sub(started.elapsed());
    let client = tokio::time::timeout(remaining, async {
        builder
            .open(
                bridge.connectors().await?,
                db,
                root_secret_from_mnemonic(mnemonic),
            )
            .await
    })
    .await
    .context("timed out reopening recovered modules")??;
    let remaining = timeout.saturating_sub(started.elapsed());
    let result = tokio::time::timeout(remaining, async {
        let (id, module) = client
            .primary_module_for_unit(AmountUnit::BITCOIN)
            .context("recovered client has no Bitcoin balance module")?;
        let config = client.config().await;
        let kind = config
            .modules
            .get(&id)
            .context("balance module config missing")?
            .kind()
            .as_str();
        if kind != "mint" && kind != "mintv2" {
            bail!("unsupported source balance module; refusing an invented balance");
        }
        // Same endpoint-availability probe as MintClientInit::recover in 0.11.1.
        // This is diagnostic only; the SDK still chooses its own recovery path.
        let recovery_method = if kind == "mint" {
            Some(
                if client
                    .api()
                    .with_module(id)
                    .fetch_recovery_count()
                    .await
                    .is_ok()
                {
                    "slices"
                } else {
                    "history"
                },
            )
        } else {
            None // mintv2 has no history-vs-slices fallback to diagnose.
        };
        client.wait_for_all_active_state_machines().await?;
        let recovered = client.get_balance_for_btc().await?;
        let source_config = Client::get_config_from_db(source_db)
            .await
            .context("source federation config is missing")?;
        if source_config
            .modules
            .get(&id)
            .map(|module| module.kind().as_str())
            != Some(kind)
        {
            bail!("source and recovered balance modules differ; refusing an invented balance");
        }
        // Pinned mint v1/v2 get_balance implementations count notes in the
        // supplied transaction. This uses the same primary module and formula
        // as get_balance_for_btc without opening/running a source client.
        let source = module
            .get_balance(
                id,
                &mut source_db.begin_transaction_nc().await,
                AmountUnit::BITCOIN,
            )
            .await;
        Ok((
            client.federation_id().to_string(),
            recovered.msats,
            source.msats,
            recovery_method,
        ))
    })
    .await
    .context("recovered notes still collecting signatures; scratch wallet discarded");
    client.shutdown().await;
    result?
}

fn require_snapshot(
    backup: Option<fedimint_client::backup::ClientBackup>,
) -> Result<fedimint_client::backup::ClientBackup> {
    backup.context("no readable federation snapshot found; refusing seed-only fallback")
}

/// Copy one read transaction, not live RocksDB files; only the private target
/// is writable. Includes the source's last-backup metadata for SDK validation.
async fn copy_source_database(source: &Database, target: &Database) -> Result<()> {
    let mut read = source.begin_transaction_nc().await;
    let mut rows = read.raw_find_by_prefix(&[]).await?;
    let mut write = target.begin_transaction().await;
    while let Some((key, value)) = rows.next().await {
        write.raw_insert_bytes(&key, &value).await?;
    }
    write.commit_tx_result().await?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackupNowOutput {
    federation_id: String,
    backup_uploaded: bool,
}

/// SDK backup writes LastBackupKey and an event locally. Stage the source
/// snapshot instead of allowing those metadata writes into the real wallet.
#[allow(deprecated)]
pub(crate) async fn backup_now(bridge: &Bridge, timeout: Duration) -> Result<BackupNowOutput> {
    let source = bridge
        .data_dir
        .canonicalize()
        .context("source data directory does not exist")?;
    if !source.join("client.db").is_dir() {
        bail!("source client.db is missing; no source wallet was created");
    }
    let source_db: Database =
        fedimint_rocksdb::RocksDbReadOnly::open_read_only(source.join("client.db"))
            .await
            .context("could not open source database read-only")?
            .into();
    let mut entropy = Client::load_decodable_client_secret::<Vec<u8>>(&source_db)
        .await
        .context("stored source client secret is missing or unreadable")?;
    let mnemonic = Mnemonic::from_entropy(&entropy);
    entropy.fill(0);
    let mnemonic = mnemonic.context("invalid stored source secret")?;
    let config = Client::get_config_from_db(&source_db)
        .await
        .context("source federation config is missing")?;
    let path = std::env::temp_dir().join(format!(
        "chama-backup-now-{}-{:016x}",
        std::process::id(),
        rand::random::<u64>()
    ));
    let (_, path) = validate_paths(&source, &path)?;
    let staged = ScratchDir::create(path)?;
    let result = tokio::time::timeout(timeout, async {
        let db = crate::load_database(&staged.0).await?;
        copy_source_database(&source_db, &db).await?;
        let mut builder = Client::builder()
            .await?
            .with_iroh_enable_dht(bridge.iroh_enable_dht)
            .with_iroh_enable_next(bridge.iroh_enable_next);
        builder.with_module_inits(default_module_inits());
        builder.stopped();
        let client = builder
            .open(
                bridge.connectors().await?,
                db,
                root_secret_from_mnemonic(&mnemonic),
            )
            .await?;
        let result = client
            .backup_to_federation(fedimint_client::backup::Metadata::empty())
            .await;
        client.shutdown().await;
        result?;
        Ok::<_, anyhow::Error>(BackupNowOutput {
            federation_id: config.calculate_federation_id().to_string(),
            backup_uploaded: true,
        })
    })
    .await
    .context("backup upload timed out; temporary copy discarded");
    staged.cleanup()?;
    result?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    fn fixture() -> (ScratchDir, PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "chama-recover-check-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&root).unwrap();
        let source = root.join("source");
        std::fs::create_dir_all(source.join("client.db")).unwrap();
        let scratch = root.join("scratch");
        (ScratchDir(root), source, scratch)
    }
    #[test]
    fn missing_source_is_refused_without_creating_scratch() {
        let (_root, source, scratch) = fixture();
        assert!(validate_paths(&source.join("missing"), &scratch).is_err());
        assert!(!scratch.exists());
        std::fs::remove_dir(source.join("client.db")).unwrap();
        assert!(validate_paths(&source, &scratch).is_err());
    }
    #[test]
    fn nonempty_scratch_is_refused_without_modification() {
        let (_root, source, scratch) = fixture();
        std::fs::create_dir(&scratch).unwrap();
        std::fs::write(scratch.join("keep"), b"do not touch").unwrap();
        assert!(validate_paths(&source, &scratch).is_err());
        assert_eq!(
            std::fs::read(scratch.join("keep")).unwrap(),
            b"do not touch"
        );
    }
    #[test]
    fn overlapping_paths_and_files_are_refused() {
        let (_root, source, scratch) = fixture();
        assert!(validate_paths(&source, &source).is_err());
        assert!(validate_paths(&source, &source.join("scratch")).is_err());
        assert!(validate_paths(&source, source.parent().unwrap()).is_err());
        std::fs::write(&scratch, b"keep").unwrap();
        assert!(validate_paths(&source, &scratch).is_err());
    }
    #[test]
    fn empty_or_new_scratch_is_owned_and_deleted() {
        let (_root, source, scratch) = fixture();
        validate_paths(&source, &scratch).unwrap();
        std::fs::create_dir(&scratch).unwrap();
        let (_, scratch) = validate_paths(&source, &scratch).unwrap();
        let guard = ScratchDir::create(scratch.clone()).unwrap();
        std::fs::write(scratch.join("test"), b"disposable").unwrap();
        drop(guard);
        assert!(!scratch.exists());
        assert!(source.join("client.db").exists());
    }
    #[cfg(unix)]
    #[test]
    fn scratch_symlink_is_refused() {
        let (_root, source, scratch) = fixture();
        std::os::unix::fs::symlink(&source, &scratch).unwrap();
        assert!(validate_paths(&source, &scratch).is_err());
    }
    #[tokio::test(flavor = "multi_thread")]
    async fn source_secret_is_read_without_source_writes() {
        let (_root, source, _scratch) = fixture();
        let db = crate::load_database(&source).await.unwrap();
        Client::store_encodable_client_secret(&db, vec![42u8; 16])
            .await
            .unwrap();
        drop(db);
        fn manifest(path: &Path) -> std::collections::BTreeMap<PathBuf, Vec<u8>> {
            let mut result = std::collections::BTreeMap::new();
            for entry in std::fs::read_dir(path).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    result.extend(manifest(&path));
                } else {
                    result.insert(path.clone(), std::fs::read(path).unwrap());
                }
            }
            result
        }
        let before = manifest(&source);
        let read_only: Database =
            fedimint_rocksdb::RocksDbReadOnly::open_read_only(source.join("client.db"))
                .await
                .unwrap()
                .into();
        let secret = Client::load_decodable_client_secret::<Vec<u8>>(&read_only)
            .await
            .unwrap();
        assert!(
            secret == vec![42u8; 16],
            "stored test secret could not be read"
        );
        let staged = ScratchDir::create(source.parent().unwrap().join("backup-copy")).unwrap();
        let target = crate::load_database(&staged.0).await.unwrap();
        copy_source_database(&read_only, &target).await.unwrap();
        let copied = Client::load_decodable_client_secret::<Vec<u8>>(&target)
            .await
            .unwrap();
        assert!(
            copied == secret,
            "private backup copy changed the source secret"
        );
        let mut tx = target.begin_transaction().await;
        tx.raw_insert_bytes(b"test-backup-metadata", b"private copy only")
            .await
            .unwrap();
        tx.commit_tx_result().await.unwrap();
        drop(target);
        staged.cleanup().unwrap();
        drop(read_only);
        assert!(
            before == manifest(&source),
            "opening source read-only modified its files"
        );
    }
    #[test]
    fn missing_snapshot_refuses_seed_only_fallback() {
        assert!(require_snapshot(None).is_err());
    }
    #[test]
    fn downloaded_snapshot_is_preserved_for_recovery() {
        let snapshot = fedimint_client::backup::ClientBackup {
            session_count: 42,
            metadata: fedimint_client::backup::Metadata::empty(),
            modules: Default::default(),
        };
        let actual = require_snapshot(Some(snapshot.clone())).unwrap();
        assert!(actual == snapshot, "downloaded snapshot was altered");
    }
    #[test]
    fn cli_accepts_standalone_recovery_and_rejects_zero_timeout() {
        use clap::Parser;
        let args = [
            "bridge",
            "recover-check",
            "--source-data-dir",
            "source",
            "--invite",
            "fed1",
            "--scratch-data-dir",
            "scratch",
        ];
        let seed_only = crate::Cli::try_parse_from(args).unwrap();
        assert!(matches!(
            seed_only.command,
            crate::Command::RecoverCheck {
                from_backup: false,
                ..
            }
        ));
        let snapshot =
            crate::Cli::try_parse_from(args.into_iter().chain(["--from-backup"])).unwrap();
        assert!(matches!(
            snapshot.command,
            crate::Command::RecoverCheck {
                from_backup: true,
                ..
            }
        ));
        assert!(
            crate::Cli::try_parse_from(["bridge", "--data-dir", "source", "backup-now"]).is_ok()
        );
        assert!(
            crate::Cli::try_parse_from(args.into_iter().chain(["--timeout-seconds", "0"])).is_err()
        );
    }
}
