use std::{
    collections::HashSet,
    io::{self, Read},
    sync::{Arc, Mutex},
};

use anyhow::{Context, Result, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use serde::Deserialize;
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
        crypto::derive_public_key,
        encryption::generate_random_blinding,
        flows::{TransactOutput, TransactParams},
    },
};
use stellar_xdr::{Limits, ReadXdr, TransactionEnvelope, TransactionExt};
use zeroize::Zeroize;

const RPC_URL: &str = "https://soroban-testnet.stellar.org";
const PINNED_POOL: &str = "CC57FDSWPIHALXW2XWVSKEA7FA72Z37Y7AP5ASRY6V3CXAZCWQAOSLB4";
const PINNED_REVISION: &str = "5f3a5d41f452069caf8d0e1654675bca55cb94d3";
const CIRCUIT_STEM: &str = "policy_tx_2_2_B";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DepositRequest {
    schema_version: u32,
    command: String,
    session_id_hex: String,
    funding_source: String,
    amount_atomic: String,
    pool_contract_id: String,
    note_private_key_le_hex: String,
    note_public_key_le_hex: String,
    encryption_private_key_hex: String,
    encryption_public_key_hex: String,
    membership_blinding_le_hex: String,
}

impl Drop for DepositRequest {
    fn drop(&mut self) {
        self.note_private_key_le_hex.zeroize();
        self.encryption_private_key_hex.zeroize();
        self.membership_blinding_le_hex.zeroize();
    }
}

fn hex32(value: &str, label: &str) -> Result<[u8; 32]> {
    let bytes = hex::decode(value).with_context(|| format!("decode {label}"))?;
    bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("{label} must be exactly 32 bytes"))
}

#[derive(Clone)]
struct EphemeralDepositStorage {
    owner: String,
    keys: StoredUserKeys,
    output_blindings: Arc<Mutex<Vec<Field>>>,
}

impl EphemeralDepositStorage {
    fn ensure_owner(&self, owner: &str) -> Result<(), Error> {
        if owner == self.owner {
            Ok(())
        } else {
            Err(Error::other("deposit bridge owner mismatch"))
        }
    }
}

#[async_trait::async_trait(?Send)]
impl ContractDataStorage for EphemeralDepositStorage {
    async fn get_sync_state(&self) -> anyhow::Result<Vec<SyncMetadata>> {
        Ok(Vec::new())
    }

    async fn save_events_batch(&self, _batch: ContractsEventData) -> anyhow::Result<()> {
        bail!("deposit bridge rejects event persistence")
    }

    async fn save_sync_progress(
        &self,
        _metadata: Vec<SyncMetadata>,
        _fully_indexed: bool,
    ) -> anyhow::Result<()> {
        bail!("deposit bridge rejects sync persistence")
    }
}

#[async_trait::async_trait(?Send)]
impl Storage for EphemeralDepositStorage {
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
        Err(Error::other("deposit bridge does not resolve recipients"))
    }

    async fn build_transact_params(
        &self,
        request: &TransactRequest,
    ) -> Result<TransactParams, Error> {
        self.ensure_owner(&request.user_address)?;
        if !request.input_commitments.is_empty() {
            return Err(Error::other("deposit bridge refuses private note inputs"));
        }
        if request.policy_flags != PolicyFlags::BLOCKLIST {
            return Err(Error::other(
                "deposit bridge requires the pinned blocklist policy",
            ));
        }
        if request.pool_address != PINNED_POOL || request.ext_recipient != PINNED_POOL {
            return Err(Error::other(
                "deposit bridge pool differs from the pinned deployment",
            ));
        }
        let pool_root = request
            .pool_root
            .ok_or_else(|| Error::other("deposit bridge is missing the pool root"))?;
        let mut outputs = Vec::with_capacity(2);
        let mut blindings = Vec::with_capacity(2);
        for index in 0..2 {
            let note_key = request.out_recipient_note_pubkeys[index].clone();
            let encryption_key = request.out_recipient_encryption_pubkeys[index].clone();
            if note_key.is_some() != encryption_key.is_some() {
                return Err(Error::other(
                    "deposit bridge received partial output ownership",
                ));
            }
            let blinding =
                generate_random_blinding().map_err(|error| Error::other(error.to_string()))?;
            blindings.push(blinding);
            outputs.push(TransactOutput {
                amount: request.output_amounts[index],
                blinding,
                recipient_note_pubkey: note_key,
                recipient_encryption_pubkey: encryption_key,
            });
        }
        *self
            .output_blindings
            .lock()
            .map_err(|_| Error::other("deposit bridge blinding lock poisoned"))? = blindings;
        Ok(TransactParams {
            priv_key: self.keys.note_keypair.private.clone(),
            encryption_pubkey: self.keys.encryption_keypair.public.clone(),
            pool_root,
            ext_recipient: request.ext_recipient.clone(),
            ext_amount: request.ext_amount,
            inputs: Vec::new(),
            outputs,
            membership_proof: None,
            non_membership_proof: request.non_membership_proof.clone(),
            tree_depth: request.tree_depth,
            asp_depth: request.asp_depth,
            smt_depth: request.smt_depth,
            policy_flags: request.policy_flags,
            gvk_mode: request.gvk_mode,
            admin_view_key: request.admin_view_key.clone(),
        })
    }

    async fn build_disclosure_inputs(
        &self,
        _request: &DisclosureInputsRequest,
    ) -> Result<Vec<DisclosureInputs>, Error> {
        Err(Error::other("deposit bridge does not disclose"))
    }

    async fn user_keys(&self, owner: &str) -> Result<StoredUserKeys, Error> {
        self.ensure_owner(owner)?;
        Ok(self.keys.clone())
    }

    async fn asp_secret(&self, owner: &str) -> Result<Field, Error> {
        self.ensure_owner(owner)?;
        Ok(self.keys.membership_blinding)
    }

    async fn user_public_keys(
        &self,
        owner: &str,
    ) -> Result<(NotePublicKey, EncryptionPublicKey), Error> {
        self.ensure_owner(owner)?;
        Ok((
            self.keys.note_keypair.public.clone(),
            self.keys.encryption_keypair.public.clone(),
        ))
    }

    async fn registered_public_keys(
        &self,
        _address: &str,
        _registry: &str,
    ) -> Result<(NotePublicKey, EncryptionPublicKey), Error> {
        Err(Error::other(
            "deposit bridge does not read the registry index",
        ))
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
        Err(Error::other("deposit bridge never signs or submits"))
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let mut serialized = String::new();
    io::stdin().read_to_string(&mut serialized)?;
    let request: DepositRequest =
        serde_json::from_str(&serialized).context("decode deposit bridge request")?;
    serialized.zeroize();
    if request.schema_version != 1 || request.command != "prepare_deposit" {
        bail!("unsupported deposit bridge request");
    }
    if request.pool_contract_id != PINNED_POOL {
        bail!("deposit bridge request is not bound to the pinned SPP pool");
    }
    let session_id = hex32(&request.session_id_hex, "session id")?;
    let note_private = hex32(&request.note_private_key_le_hex, "note private key")?;
    let note_public = hex32(&request.note_public_key_le_hex, "note public key")?;
    let encryption_private = hex32(
        &request.encryption_private_key_hex,
        "encryption private key",
    )?;
    let encryption_public = hex32(&request.encryption_public_key_hex, "encryption public key")?;
    let membership_blinding = Field::try_from_le_bytes(hex32(
        &request.membership_blinding_le_hex,
        "membership blinding",
    )?)?;
    let derived_note_public: [u8; 32] = derive_public_key(&note_private)?
        .try_into()
        .map_err(|_| anyhow::anyhow!("derived note public key is not 32 bytes"))?;
    if derived_note_public != note_public {
        bail!("note private/public key mismatch");
    }
    let amount = request
        .amount_atomic
        .parse::<u128>()
        .context("parse deposit amount")?;
    if amount == 0 {
        bail!("deposit amount must be positive");
    }

    let deployment: ContractConfig = serde_json::from_str(include_str!(
        "../../../../deployments/spp-usdc-testnet.sdk.json"
    ))?;
    let pool_config = deployment.pool(PINNED_POOL)?;
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
    let output_blindings = Arc::new(Mutex::new(Vec::new()));
    let storage = EphemeralDepositStorage {
        owner: request.funding_source.clone(),
        keys: StoredUserKeys {
            note_keypair: NoteKeyPair {
                private: NotePrivateKey(note_private),
                public: NotePublicKey(note_public),
            },
            encryption_keypair: EncryptionKeyPair {
                private: EncryptionPrivateKey(encryption_private),
                public: EncryptionPublicKey(encryption_public),
            },
            membership_blinding,
        },
        output_blindings: output_blindings.clone(),
    };
    let mut client = Client::init(RPC_URL, storage, prover, deployment, None)?;
    let _background_mode = client.background_sync()?;
    let account = client.account(
        NoteOwnerAddress::new(&request.funding_source),
        SignerAddress::new(&request.funding_source),
        Handle::from_box(Box::new(RefuseSigner) as Box<dyn Signer>),
    )?;
    let pool = account.pool(PINNED_POOL)?;
    let mut plan = pool.prepare_deposit(NoteAmount::from(amount))?;
    let mut prepared = pool.prove_next(&mut plan).await?;
    pool.simulate(&mut prepared).await?;

    let blindings = output_blindings
        .lock()
        .map_err(|_| anyhow::anyhow!("deposit bridge blinding lock poisoned"))?;
    let funding_output_blinding = *blindings.first().ok_or_else(|| {
        anyhow::anyhow!("deposit bridge did not retain its funding output blinding")
    })?;
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
    let operation_id = hex::encode(Sha256::digest(
        [session_id.as_slice(), envelope_bytes.as_slice()].concat(),
    ));
    let proof = &prepared.proof_uncompressed;
    println!(
        "{}",
        serde_json::json!({
            "schemaVersion": 1,
            "sourceRevision": PINNED_REVISION,
            "network": "testnet",
            "operationIdHex": operation_id,
            "assetMovement": false,
            "signed": false,
            "submitted": false,
            "proof": {
                "aHex": hex::encode(&proof[0..64]),
                "bHex": hex::encode(&proof[64..192]),
                "cHex": hex::encode(&proof[192..256]),
                "root": prepared.prepared.pool_root.to_string(),
                "inputNullifiers": prepared.prepared.input_nullifiers.iter().map(ToString::to_string).collect::<Vec<_>>(),
                "outputCommitment0": prepared.prepared.output_commitments[0].to_string(),
                "outputCommitment1": prepared.prepared.output_commitments[1].to_string(),
                "publicAmount": prepared.prepared.public_amount.to_string(),
                "extDataHashHex": hex::encode(prepared.prepared.ext_data_hash_be),
                "aspMembershipRoot": prepared.prepared.asp_membership_root.to_string(),
                "aspNonMembershipRoot": prepared.prepared.asp_non_membership_root.to_string()
            },
            "extData": {
                "recipient": prepared.ext_data.recipient,
                "extAmount": prepared.ext_data.ext_amount.to_string(),
                "encryptedOutput0Hex": hex::encode(&prepared.ext_data.encrypted_output0),
                "encryptedOutput1Hex": hex::encode(&prepared.ext_data.encrypted_output1)
            },
            "fundingOutputBlinding": funding_output_blinding.to_string(),
            "resource": {
                "authEntries": prepared.soroban_tx.auth_entries.len(),
                "diskReadBytes": resources.disk_read_bytes,
                "envelopeBytes": envelope_bytes.len(),
                "footprintReadOnlyEntries": resources.footprint.read_only.len(),
                "footprintReadWriteEntries": resources.footprint.read_write.len(),
                "instructions": resources.instructions,
                "latestLedger": prepared.soroban_tx.latest_ledger,
                "resourceFeeStroops": resource_fee.to_string(),
                "totalFeeStroops": total_fee.to_string(),
                "writeBytes": resources.write_bytes
            },
            "safety": { "storage": "ephemeral-memory-no-sqlite" }
        })
    );
    Ok(())
}
