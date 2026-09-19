use std::{collections::HashSet, time::Instant};

use anyhow::{Context, Result, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use sha2::{Digest, Sha256};
use stellar_private_payments::{
    CircuitStore, Client, Error, Handle, LocalProver, Prover, Signer, Storage,
    chain::ContractDataStorage,
    disclosure::{DisclosureInputs, DisclosureInputsRequest},
    gvk::GvkEvent,
    planner::SpendableNote,
    state::StoredUserKeys,
    transact::TransactRequest,
    types::{
        CircuitStem, ContractConfig, ContractsEventData, EncryptionKeyPair, EncryptionPrivateKey,
        EncryptionPublicKey, Field, GvkMode, NoteAmount, NoteKeyPair, NoteOwnerAddress,
        NotePrivateKey, NotePublicKey, OperationalFeedItem, PolicyFlags, PortfolioBalance,
        PortfolioPoolEntry, RecipientLookup, SignedTransaction, SignerAddress, SyncMetadata,
        UserNoteSummary,
    },
    zk::{
        encryption::generate_random_blinding,
        flows::{TransactOutput, TransactParams},
    },
};
use stellar_xdr::{Limits, ReadXdr, TransactionEnvelope, TransactionExt};

const RPC_URL: &str = "https://soroban-testnet.stellar.org";
const POOL: &str = "CC57FDSWPIHALXW2XWVSKEA7FA72Z37Y7AP5ASRY6V3CXAZCWQAOSLB4";
const CIRCUIT_STEM: &str = "policy_tx_2_2_B";
const SIMULATED_AMOUNT: u128 = 100_000;

// Clearly non-production, deterministic probe material. It exists only in
// process memory and can never be used for a submitted transaction.
const NOTE_PRIVATE_KEY_LE: [u8; 32] = [
    1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
];
const NOTE_PUBLIC_KEY_LE: [u8; 32] = [
    0x5e, 0x4f, 0xc4, 0x77, 0x6a, 0x07, 0x88, 0xe3, 0x3a, 0x85, 0xb1, 0xec, 0x36, 0xd4, 0xf0, 0x79,
    0xe3, 0xd6, 0x72, 0x36, 0xe7, 0xef, 0x36, 0xf5, 0xd4, 0x4e, 0x0c, 0x75, 0xaa, 0x52, 0x6a, 0x29,
];
const ENCRYPTION_PRIVATE_KEY: [u8; 32] = [
    0x77, 0x07, 0x6d, 0x0a, 0x73, 0x18, 0xa5, 0x7d, 0x3c, 0x16, 0xc1, 0x72, 0x51, 0xb2, 0x66, 0x45,
    0xdf, 0x4c, 0x2f, 0x87, 0xeb, 0xc0, 0x99, 0x2a, 0xb1, 0x77, 0xfb, 0xa5, 0x1d, 0xb9, 0x2c, 0x2a,
];
const ENCRYPTION_PUBLIC_KEY: [u8; 32] = [
    0x85, 0x20, 0xf0, 0x09, 0x89, 0x30, 0xa7, 0x54, 0x74, 0x8b, 0x7d, 0xdc, 0xb4, 0x3e, 0xf7, 0x5a,
    0x0d, 0xbf, 0x3a, 0x0d, 0x26, 0x38, 0x1a, 0xf4, 0xeb, 0xa4, 0xa9, 0x8e, 0xaa, 0x9b, 0x4e, 0x6a,
];

#[derive(Clone)]
struct EphemeralPrivacyStorage {
    owner: String,
}

impl EphemeralPrivacyStorage {
    fn ensure_owner(&self, owner: &str) -> Result<(), Error> {
        if owner == self.owner {
            Ok(())
        } else {
            Err(Error::other("probe owner mismatch"))
        }
    }

    fn keys(&self) -> StoredUserKeys {
        StoredUserKeys {
            note_keypair: NoteKeyPair {
                private: NotePrivateKey(NOTE_PRIVATE_KEY_LE),
                public: NotePublicKey(NOTE_PUBLIC_KEY_LE),
            },
            encryption_keypair: EncryptionKeyPair {
                private: EncryptionPrivateKey(ENCRYPTION_PRIVATE_KEY),
                public: EncryptionPublicKey(ENCRYPTION_PUBLIC_KEY),
            },
            membership_blinding: Field::ONE,
        }
    }
}

#[async_trait::async_trait(?Send)]
impl ContractDataStorage for EphemeralPrivacyStorage {
    async fn get_sync_state(&self) -> anyhow::Result<Vec<SyncMetadata>> {
        Ok(Vec::new())
    }
    async fn save_events_batch(&self, _batch: ContractsEventData) -> anyhow::Result<()> {
        bail!("probe storage rejects event persistence")
    }
    async fn save_sync_progress(
        &self,
        _metadata: Vec<SyncMetadata>,
        _fully_indexed: bool,
    ) -> anyhow::Result<()> {
        bail!("probe storage rejects sync persistence")
    }
}

#[async_trait::async_trait(?Send)]
impl Storage for EphemeralPrivacyStorage {
    fn fork(&self) -> Result<Self, Error> {
        Ok(self.clone())
    }
    async fn ensure_ready(&self) -> Result<(), Error> {
        Ok(())
    }

    async fn spendable_notes(&self, _pool: &str, owner: &str) -> Result<Vec<SpendableNote>, Error> {
        self.ensure_owner(owner)?;
        Ok(Vec::new())
    }
    async fn notes(&self, _pool: &str, owner: &str) -> Result<Vec<UserNoteSummary>, Error> {
        self.ensure_owner(owner)?;
        Ok(Vec::new())
    }
    async fn list_portfolio_balances(
        &self,
        owner: &str,
        _pools: &[PortfolioPoolEntry],
    ) -> Result<Vec<PortfolioBalance>, Error> {
        self.ensure_owner(owner)?;
        Ok(Vec::new())
    }
    async fn list_user_notes(
        &self,
        owner: &str,
        _limit: u32,
    ) -> Result<Vec<UserNoteSummary>, Error> {
        self.ensure_owner(owner)?;
        Ok(Vec::new())
    }
    async fn operational_feed(
        &self,
        _limit: u32,
        _config: &ContractConfig,
    ) -> Result<Vec<OperationalFeedItem>, Error> {
        Ok(Vec::new())
    }
    async fn recipient_lookup(
        &self,
        _address: &str,
        _config: &ContractConfig,
    ) -> Result<RecipientLookup, Error> {
        Err(Error::other("probe does not resolve recipients"))
    }

    async fn build_transact_params(&self, req: &TransactRequest) -> Result<TransactParams, Error> {
        self.ensure_owner(&req.user_address)?;
        if !req.input_commitments.is_empty() {
            return Err(Error::other("deposit probe refuses private note inputs"));
        }
        if req.policy_flags != PolicyFlags::BLOCKLIST {
            return Err(Error::other("probe requires the pinned blocklist policy"));
        }
        let pool_root = req
            .pool_root
            .ok_or_else(|| Error::other("missing pool root"))?;
        let mut outputs = Vec::with_capacity(2);
        for index in 0..2 {
            let note_key = req.out_recipient_note_pubkeys[index].clone();
            let encryption_key = req.out_recipient_encryption_pubkeys[index].clone();
            if note_key.is_some() != encryption_key.is_some() {
                return Err(Error::other("partial output ownership keys"));
            }
            outputs.push(TransactOutput {
                amount: req.output_amounts[index],
                blinding: generate_random_blinding()
                    .map_err(|error| Error::other(error.to_string()))?,
                recipient_note_pubkey: note_key,
                recipient_encryption_pubkey: encryption_key,
            });
        }
        Ok(TransactParams {
            priv_key: NotePrivateKey(NOTE_PRIVATE_KEY_LE),
            encryption_pubkey: EncryptionPublicKey(ENCRYPTION_PUBLIC_KEY),
            pool_root,
            ext_recipient: req.ext_recipient.clone(),
            ext_amount: req.ext_amount,
            inputs: Vec::new(),
            outputs,
            membership_proof: None,
            non_membership_proof: req.non_membership_proof.clone(),
            tree_depth: req.tree_depth,
            asp_depth: req.asp_depth,
            smt_depth: req.smt_depth,
            policy_flags: req.policy_flags,
            gvk_mode: req.gvk_mode,
            admin_view_key: req.admin_view_key.clone(),
        })
    }

    async fn build_disclosure_inputs(
        &self,
        _req: &DisclosureInputsRequest,
    ) -> Result<Vec<DisclosureInputs>, Error> {
        Err(Error::other("probe does not disclose"))
    }
    async fn user_keys(&self, owner: &str) -> Result<StoredUserKeys, Error> {
        self.ensure_owner(owner)?;
        Ok(self.keys())
    }
    async fn asp_secret(&self, owner: &str) -> Result<Field, Error> {
        self.ensure_owner(owner)?;
        Ok(Field::ONE)
    }
    async fn user_public_keys(
        &self,
        owner: &str,
    ) -> Result<(NotePublicKey, EncryptionPublicKey), Error> {
        self.ensure_owner(owner)?;
        Ok((
            NotePublicKey(NOTE_PUBLIC_KEY_LE),
            EncryptionPublicKey(ENCRYPTION_PUBLIC_KEY),
        ))
    }
    async fn registered_public_keys(
        &self,
        _address: &str,
        _registry: &str,
    ) -> Result<(NotePublicKey, EncryptionPublicKey), Error> {
        Err(Error::other("probe does not read the registry index"))
    }
    async fn process_pending_state(&self) -> Result<(), Error> {
        Ok(())
    }
    async fn clear_indexing_cursors(&self) -> Result<(), Error> {
        Ok(())
    }
    async fn clamp_last_fully_indexed_ledger(&self, _max_ledger: u32) -> Result<(), Error> {
        Ok(())
    }
    async fn list_pool_gvk_events(
        &self,
        _pool: &str,
        _after: Option<(u32, String)>,
        _limit: u32,
    ) -> Result<Vec<GvkEvent>, Error> {
        Ok(Vec::new())
    }
    async fn pool_has_commitments(
        &self,
        _pool: &str,
        _commitments: &[Field],
    ) -> Result<HashSet<Field>, Error> {
        Ok(HashSet::new())
    }
}

struct RefuseSigner;

#[async_trait::async_trait(?Send)]
impl Signer for RefuseSigner {
    async fn sign_transaction(
        &self,
        _prepared: &stellar_private_payments::PreparedTransaction,
    ) -> Result<SignedTransaction, Error> {
        Err(Error::other("simulation probe never signs"))
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let deployment: ContractConfig = serde_json::from_str(include_str!(
        "../../../deployments/spp-usdc-testnet.sdk.json"
    ))?;
    let pool_config = deployment.pool(POOL)?;
    if pool_config.policy_flags != PolicyFlags::BLOCKLIST || pool_config.gvk_mode != GvkMode::Off {
        bail!("deployment is not the pinned blocklist/no-GVK pool");
    }

    let circuits_dir = std::env::current_dir()?.join(".phloem/spp-circuits");
    let circuit_store = CircuitStore::open(circuits_dir);
    circuit_store
        .ensure()
        .await
        .context("prepare pinned SPP circuit artifacts")?;
    let stem = CircuitStem::transact(PolicyFlags::BLOCKLIST, GvkMode::Off);
    let artifacts = circuit_store.artifacts(CIRCUIT_STEM)?;
    let prover = Handle::from_box(
        Box::new(LocalProver::from_artifacts(&[(stem, artifacts)])?) as Box<dyn Prover>
    );

    let owner = deployment.deployer.clone();
    let storage = EphemeralPrivacyStorage {
        owner: owner.clone(),
    };
    let mut client = Client::init(RPC_URL, storage, prover, deployment.clone(), None)?;
    let _background_mode = client.background_sync()?;
    let account = client.account(
        NoteOwnerAddress::new(&owner),
        SignerAddress::new(&owner),
        Handle::from_box(Box::new(RefuseSigner) as Box<dyn Signer>),
    )?;
    let pool = account.pool(POOL)?;
    let mut plan = pool.prepare_deposit(NoteAmount::from(SIMULATED_AMOUNT))?;

    let prove_started = Instant::now();
    let mut prepared = pool.prove_next(&mut plan).await?;
    let prove_ms = prove_started.elapsed().as_millis();
    let simulate_started = Instant::now();
    pool.simulate(&mut prepared).await?;
    let simulate_ms = simulate_started.elapsed().as_millis();

    let envelope_bytes = BASE64_STANDARD.decode(&prepared.soroban_tx.tx_xdr)?;
    let envelope =
        TransactionEnvelope::from_xdr_base64(&prepared.soroban_tx.tx_xdr, Limits::none())?;
    let (total_fee, resources, resource_fee) = match envelope {
        TransactionEnvelope::Tx(envelope) => match envelope.tx.ext {
            TransactionExt::V1(data) => (envelope.tx.fee, data.resources, data.resource_fee),
            TransactionExt::V0 => bail!("simulated transaction has no Soroban resource data"),
        },
        _ => bail!("simulated transaction is not a v1 transaction envelope"),
    };
    let envelope_sha256 = hex::encode(Sha256::digest(&envelope_bytes));

    println!(
        "{}",
        serde_json::json!({
            "assetMovement": false,
            "fixture": "PHLOEM_NON_PRODUCTION_SPP_SIMULATION_V1",
            "network": "testnet",
            "poolContractId": POOL,
            "resource": {
                "authEntries": prepared.soroban_tx.auth_entries.len(),
                "diskReadBytes": resources.disk_read_bytes,
                "envelopeBytes": envelope_bytes.len(),
                "envelopeSha256": envelope_sha256,
                "footprintReadOnlyEntries": resources.footprint.read_only.len(),
                "footprintReadWriteEntries": resources.footprint.read_write.len(),
                "instructions": resources.instructions,
                "latestLedger": prepared.soroban_tx.latest_ledger,
                "resourceFeeStroops": resource_fee.to_string(),
                "totalFeeStroops": total_fee.to_string(),
                "writeBytes": resources.write_bytes
            },
            "simulatedAmountAtomic": SIMULATED_AMOUNT.to_string(),
            "proof": {
                "aspMembershipRoot": prepared.prepared.asp_membership_root.to_string(),
                "aspNonMembershipRoot": prepared.prepared.asp_non_membership_root.to_string(),
                "outputCommitments": prepared.prepared.output_commitments.iter().map(ToString::to_string).collect::<Vec<_>>(),
                "publicAmount": prepared.prepared.public_amount.to_string(),
                "uncompressedBytes": prepared.proof_uncompressed.len()
            },
            "safety": {
                "signed": false,
                "submitted": false,
                "storage": "ephemeral-memory-no-sqlite"
            },
            "timingMs": { "prove": prove_ms, "simulateRpc": simulate_ms }
        })
    );
    Ok(())
}
