use std::{
    collections::{BTreeMap, HashSet},
    io::{self, Read},
    sync::{Arc, Mutex},
};

use anyhow::{Context, Result, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use stellar_private_payments::{
    CircuitStore, Client, Error, Handle, LocalProver, Prover, Signer, Storage,
    chain::{ContractDataStorage, RpcClient},
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
        TransferRecipient, UserNoteSummary,
    },
    zk::{
        crypto::derive_public_key,
        encryption::generate_random_blinding,
        flows::{TransactInputNote, TransactOutput, TransactParams},
        merkle::MerklePrefixTree,
    },
};
use stellar_xdr::{Limits, ReadXdr, ScVal, TransactionEnvelope, TransactionExt};
use zeroize::Zeroize;

const RPC_URL: &str = "https://soroban-testnet.stellar.org";
const PINNED_POOL: &str = "CC57FDSWPIHALXW2XWVSKEA7FA72Z37Y7AP5ASRY6V3CXAZCWQAOSLB4";
const PINNED_REVISION: &str = "5f3a5d41f452069caf8d0e1654675bca55cb94d3";
const CIRCUIT_STEM: &str = "policy_tx_2_2_B";
const POOL_DEPLOYMENT_LEDGER: u32 = 4_765_550;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SpendNoteRequest {
    note_id_hex: String,
    commitment_le_hex: String,
    amount_atomic: String,
    blinding_le_hex: String,
    leaf_index: u32,
}

impl Drop for SpendNoteRequest {
    fn drop(&mut self) {
        self.blinding_le_hex.zeroize();
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TransferRequest {
    schema_version: u32,
    command: String,
    reservation_id_hex: String,
    session_id_hex: String,
    funding_source: String,
    claim_amount_atomic: String,
    refund_amount_atomic: String,
    pool_contract_id: String,
    provider_note_public_key_le_hex: String,
    provider_encryption_public_key_hex: String,
    note_private_key_le_hex: String,
    note_public_key_le_hex: String,
    encryption_private_key_hex: String,
    encryption_public_key_hex: String,
    membership_blinding_le_hex: String,
    available_notes: Vec<SpendNoteRequest>,
}

impl Drop for TransferRequest {
    fn drop(&mut self) {
        self.note_private_key_le_hex.zeroize();
        self.encryption_private_key_hex.zeroize();
        self.membership_blinding_le_hex.zeroize();
    }
}

#[derive(Clone)]
struct SpendNote {
    note_id: [u8; 32],
    commitment: Field,
    amount: NoteAmount,
    blinding: Field,
    leaf_index: u32,
}

fn hex32(value: &str, label: &str) -> Result<[u8; 32]> {
    let bytes = hex::decode(value).with_context(|| format!("decode {label}"))?;
    bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("{label} must be exactly 32 bytes"))
}

fn parse_amount(value: &str, label: &str) -> Result<NoteAmount> {
    let amount = value
        .parse::<u128>()
        .with_context(|| format!("parse {label}"))?;
    Ok(NoteAmount::from(amount))
}

fn u256_field(value: &ScVal) -> Result<Field> {
    let ScVal::U256(parts) = value else {
        bail!("commitment event topic is not U256");
    };
    let mut bytes = [0_u8; 32];
    bytes[0..8].copy_from_slice(&parts.hi_hi.to_be_bytes());
    bytes[8..16].copy_from_slice(&parts.hi_lo.to_be_bytes());
    bytes[16..24].copy_from_slice(&parts.lo_hi.to_be_bytes());
    bytes[24..32].copy_from_slice(&parts.lo_lo.to_be_bytes());
    Field::try_from_be_bytes(bytes)
}

fn parse_commitment_event(topics: &[String], value: &str) -> Result<Option<(u32, Field)>> {
    let Some(first) = topics.first() else {
        return Ok(None);
    };
    let name = match ScVal::from_xdr_base64(first, Limits::none())? {
        ScVal::Symbol(symbol) => symbol.to_utf8_string()?,
        _ => return Ok(None),
    };
    if name != "new_commitment_event" && name != "NewCommitmentEvent" {
        return Ok(None);
    }
    let commitment = topics
        .get(1)
        .ok_or_else(|| anyhow::anyhow!("commitment event is missing its commitment topic"))?;
    let commitment = u256_field(&ScVal::from_xdr_base64(commitment, Limits::none())?)?;
    let data = ScVal::from_xdr_base64(value, Limits::none())?;
    let ScVal::Map(Some(entries)) = data else {
        bail!("commitment event data is not a map");
    };
    let mut index = None;
    for entry in entries.iter() {
        if let ScVal::Symbol(symbol) = &entry.key
            && symbol.to_utf8_string()? == "index"
        {
            let ScVal::U32(value) = entry.val else {
                bail!("commitment event index is not u32");
            };
            index = Some(value);
        }
    }
    Ok(Some((
        index.ok_or_else(|| anyhow::anyhow!("commitment event is missing its index"))?,
        commitment,
    )))
}

async fn fetch_pool_leaves(rpc: &RpcClient, expected_next_index: u32) -> Result<Vec<Field>> {
    let contracts = vec![PINNED_POOL.to_string()];
    let mut cursor = None;
    let mut leaves = BTreeMap::new();
    for _ in 0..100 {
        let prior_cursor = cursor.clone();
        let (next_cursor, events, _) = rpc
            .get_contract_events(&contracts, POOL_DEPLOYMENT_LEDGER, 1_000, cursor)
            .await?;
        for event in events {
            if let Some((index, commitment)) = parse_commitment_event(&event.topic, &event.value)?
                && leaves.insert(index, commitment).is_some()
            {
                bail!("pool event stream contains a duplicate commitment index");
            }
        }
        cursor = next_cursor;
        if cursor == prior_cursor || leaves.len() >= expected_next_index as usize {
            break;
        }
    }
    if leaves.len() != expected_next_index as usize {
        bail!("pool event stream does not match the on-chain next index");
    }
    (0..expected_next_index)
        .map(|index| {
            leaves
                .remove(&index)
                .ok_or_else(|| anyhow::anyhow!("pool event stream has a commitment index gap"))
        })
        .collect()
}

#[derive(Clone)]
struct EphemeralTransferStorage {
    owner: String,
    keys: StoredUserKeys,
    notes: Vec<SpendNote>,
    rpc: RpcClient,
    output_blindings: Arc<Mutex<Vec<Field>>>,
    selected_note_ids: Arc<Mutex<Vec<[u8; 32]>>>,
}

impl EphemeralTransferStorage {
    fn ensure_owner(&self, owner: &str) -> Result<(), Error> {
        if owner == self.owner {
            Ok(())
        } else {
            Err(Error::other("transfer bridge owner mismatch"))
        }
    }
}

#[async_trait::async_trait(?Send)]
impl ContractDataStorage for EphemeralTransferStorage {
    async fn get_sync_state(&self) -> anyhow::Result<Vec<SyncMetadata>> {
        Ok(Vec::new())
    }

    async fn save_events_batch(&self, _batch: ContractsEventData) -> anyhow::Result<()> {
        bail!("transfer bridge rejects event persistence")
    }

    async fn save_sync_progress(
        &self,
        _metadata: Vec<SyncMetadata>,
        _fully_indexed: bool,
    ) -> anyhow::Result<()> {
        bail!("transfer bridge rejects sync persistence")
    }
}

#[async_trait::async_trait(?Send)]
impl Storage for EphemeralTransferStorage {
    fn fork(&self) -> Result<Self, Error> {
        Ok(self.clone())
    }

    async fn ensure_ready(&self) -> Result<(), Error> {
        Ok(())
    }

    async fn spendable_notes(&self, _pool: &str, owner: &str) -> Result<Vec<SpendableNote>, Error> {
        self.ensure_owner(owner)?;
        Ok(self
            .notes
            .iter()
            .map(|note| SpendableNote {
                commitment: note.commitment,
                amount: note.amount,
            })
            .collect())
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
        Err(Error::other("transfer bridge does not resolve recipients"))
    }

    async fn build_transact_params(
        &self,
        request: &TransactRequest,
    ) -> Result<TransactParams, Error> {
        self.ensure_owner(&request.user_address)?;
        if request.input_commitments.is_empty() || request.input_commitments.len() > 2 {
            return Err(Error::other(
                "transfer bridge requires one or two private inputs",
            ));
        }
        if request.policy_flags != PolicyFlags::BLOCKLIST {
            return Err(Error::other(
                "transfer bridge requires the pinned blocklist policy",
            ));
        }
        if request.pool_address != PINNED_POOL || request.ext_recipient != PINNED_POOL {
            return Err(Error::other(
                "transfer bridge pool differs from the pinned deployment",
            ));
        }
        if !request.ext_amount.is_zero() {
            return Err(Error::other(
                "transfer bridge refuses public asset movement",
            ));
        }
        let pool_root = request
            .pool_root
            .ok_or_else(|| Error::other("transfer bridge is missing the pool root"))?;
        let leaves = fetch_pool_leaves(&self.rpc, request.pool_next_index)
            .await
            .map_err(|error| Error::other(error.to_string()))?;
        let tree = MerklePrefixTree::new(request.tree_depth, &leaves)
            .map_err(|error| Error::other(error.to_string()))?
            .into_built();
        if tree
            .root()
            .map_err(|error| Error::other(error.to_string()))?
            != pool_root
        {
            return Err(Error::other(
                "transfer bridge reconstructed the wrong pool root",
            ));
        }
        let mut inputs = Vec::with_capacity(request.input_commitments.len());
        let mut selected = Vec::with_capacity(request.input_commitments.len());
        for commitment in &request.input_commitments {
            let note = self
                .notes
                .iter()
                .find(|note| note.commitment == *commitment)
                .ok_or_else(|| {
                    Error::other("transfer input is not an authorized Phloem treasury note")
                })?;
            if leaves.get(note.leaf_index as usize) != Some(commitment) {
                return Err(Error::other(
                    "transfer input leaf does not match its commitment",
                ));
            }
            let proof = tree
                .proof(note.leaf_index)
                .map_err(|error| Error::other(error.to_string()))?;
            inputs.push(TransactInputNote {
                amount: note.amount,
                blinding: note.blinding,
                merkle_path_elements: proof.path_elements,
                merkle_path_indices: proof.path_indices,
            });
            selected.push(note.note_id);
        }
        *self
            .selected_note_ids
            .lock()
            .map_err(|_| Error::other("transfer bridge selected-note lock poisoned"))? = selected;

        let mut outputs = Vec::with_capacity(2);
        let mut blindings = Vec::with_capacity(2);
        for index in 0..2 {
            let note_key = request.out_recipient_note_pubkeys[index].clone();
            let encryption_key = request.out_recipient_encryption_pubkeys[index].clone();
            if note_key.is_some() != encryption_key.is_some() {
                return Err(Error::other(
                    "transfer bridge received partial output ownership",
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
            .map_err(|_| Error::other("transfer bridge blinding lock poisoned"))? = blindings;
        Ok(TransactParams {
            priv_key: self.keys.note_keypair.private.clone(),
            encryption_pubkey: self.keys.encryption_keypair.public.clone(),
            pool_root,
            ext_recipient: request.ext_recipient.clone(),
            ext_amount: request.ext_amount,
            inputs,
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
        Err(Error::other("transfer bridge does not disclose"))
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
        Err(Error::other("transfer bridge uses explicit provider keys"))
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
        commitments: &[Field],
    ) -> Result<HashSet<Field>, Error> {
        let owned: HashSet<_> = self.notes.iter().map(|note| note.commitment).collect();
        Ok(commitments
            .iter()
            .copied()
            .filter(|commitment| owned.contains(commitment))
            .collect())
    }
}

struct RefuseSigner;

#[async_trait::async_trait(?Send)]
impl Signer for RefuseSigner {
    async fn sign_transaction(
        &self,
        _prepared: &stellar_private_payments::PreparedTransaction,
    ) -> Result<SignedTransaction, Error> {
        Err(Error::other("transfer bridge never signs or submits"))
    }
}

fn exact_notes(notes: Vec<SpendNote>, target: NoteAmount) -> Result<Vec<SpendNote>> {
    let mut notes = notes;
    notes.sort_by_key(|note| note.leaf_index);
    if let Some(note) = notes.iter().find(|note| note.amount == target) {
        return Ok(vec![note.clone()]);
    }
    for left in 0..notes.len() {
        for right in (left + 1)..notes.len() {
            if notes[left]
                .amount
                .checked_add(notes[right].amount)
                .is_some_and(|sum| sum == target)
            {
                return Ok(vec![notes[left].clone(), notes[right].clone()]);
            }
        }
    }
    bail!("transfer bridge cannot exactly back the reservation with one or two notes")
}

#[tokio::main]
async fn main() -> Result<()> {
    let mut serialized = String::new();
    io::stdin().read_to_string(&mut serialized)?;
    let request: TransferRequest =
        serde_json::from_str(&serialized).context("decode transfer bridge request")?;
    serialized.zeroize();
    if request.schema_version != 1 || request.command != "prepare_transfer" {
        bail!("unsupported transfer bridge request");
    }
    if request.pool_contract_id != PINNED_POOL {
        bail!("transfer bridge request is not bound to the pinned SPP pool");
    }
    let reservation_id = hex32(&request.reservation_id_hex, "reservation id")?;
    let session_id = hex32(&request.session_id_hex, "session id")?;
    let note_private = hex32(&request.note_private_key_le_hex, "note private key")?;
    let note_public = hex32(&request.note_public_key_le_hex, "note public key")?;
    let encryption_private = hex32(
        &request.encryption_private_key_hex,
        "encryption private key",
    )?;
    let encryption_public = hex32(&request.encryption_public_key_hex, "encryption public key")?;
    let provider_note_public = hex32(
        &request.provider_note_public_key_le_hex,
        "provider note public key",
    )?;
    let provider_encryption_public = hex32(
        &request.provider_encryption_public_key_hex,
        "provider encryption public key",
    )?;
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
    let claim_amount = parse_amount(&request.claim_amount_atomic, "claim amount")?;
    let refund_amount = parse_amount(&request.refund_amount_atomic, "refund amount")?;
    if claim_amount.is_zero() {
        bail!("claim amount must be positive");
    }
    let expected_input = claim_amount
        .checked_add(refund_amount)
        .ok_or_else(|| anyhow::anyhow!("reservation amount overflow"))?;
    let notes = request
        .available_notes
        .iter()
        .map(|note| {
            Ok(SpendNote {
                note_id: hex32(&note.note_id_hex, "note id")?,
                commitment: Field::try_from_le_bytes(hex32(
                    &note.commitment_le_hex,
                    "note commitment",
                )?)?,
                amount: parse_amount(&note.amount_atomic, "note amount")?,
                blinding: Field::try_from_le_bytes(hex32(&note.blinding_le_hex, "note blinding")?)?,
                leaf_index: note.leaf_index,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let notes = exact_notes(notes, expected_input)?;

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
    let selected_note_ids = Arc::new(Mutex::new(Vec::new()));
    let rpc = RpcClient::new(RPC_URL)?;
    let storage = EphemeralTransferStorage {
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
        notes: notes.clone(),
        rpc,
        output_blindings: output_blindings.clone(),
        selected_note_ids: selected_note_ids.clone(),
    };
    let mut client = Client::init(RPC_URL, storage, prover, deployment, None)?;
    let _background_mode = client.background_sync()?;
    let account = client.account(
        NoteOwnerAddress::new(&request.funding_source),
        SignerAddress::new(&request.funding_source),
        Handle::from_box(Box::new(RefuseSigner) as Box<dyn Signer>),
    )?;
    let pool = account.pool(PINNED_POOL)?;
    let wallet = notes
        .iter()
        .map(|note| SpendableNote {
            commitment: note.commitment,
            amount: note.amount,
        })
        .collect::<Vec<_>>();
    let recipient = TransferRecipient::keys(
        NotePublicKey(provider_note_public),
        EncryptionPublicKey(provider_encryption_public),
    );
    let mut plan = pool
        .prepare_transfer(&wallet, recipient, claim_amount)
        .await?;
    if plan.tx_count() != 1 {
        bail!("transfer bridge refuses a multi-transaction SPP plan");
    }
    let mut prepared = pool.prove_next(&mut plan).await?;
    if !plan.is_complete() {
        bail!("transfer bridge did not complete the one-step SPP plan");
    }
    pool.simulate(&mut prepared).await?;

    let blindings = output_blindings
        .lock()
        .map_err(|_| anyhow::anyhow!("transfer bridge blinding lock poisoned"))?;
    let provider_output_blinding = *blindings
        .first()
        .ok_or_else(|| anyhow::anyhow!("transfer bridge did not retain provider blinding"))?;
    let refund_output_blinding = *blindings
        .get(1)
        .ok_or_else(|| anyhow::anyhow!("transfer bridge did not retain second output blinding"))?;
    let selected = selected_note_ids
        .lock()
        .map_err(|_| anyhow::anyhow!("transfer bridge selected-note lock poisoned"))?;
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
        [
            session_id.as_slice(),
            reservation_id.as_slice(),
            envelope_bytes.as_slice(),
        ]
        .concat(),
    ));
    let proof = &prepared.proof_uncompressed;
    println!(
        "{}",
        serde_json::json!({
            "schemaVersion": 1,
            "sourceRevision": PINNED_REVISION,
            "network": "testnet",
            "operationIdHex": operation_id,
            "inputNoteIdsHex": selected.iter().map(hex::encode).collect::<Vec<_>>(),
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
            "providerOutputBlinding": provider_output_blinding.to_string(),
            "refundOutputBlinding": refund_output_blinding.to_string(),
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
