#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SPP_ROOT="$REPO_ROOT/.phloem/upstream/stellar-private-payments"
OUTPUT_DIR="$REPO_ROOT/target/spp-testnet-usdc"
PINNED_REVISION="5f3a5d41f452069caf8d0e1654675bca55cb94d3"

[[ -d "$SPP_ROOT/.git" ]] || { echo "Pinned SPP checkout is missing at $SPP_ROOT" >&2; exit 1; }
[[ "$(git -C "$SPP_ROOT" rev-parse HEAD)" == "$PINNED_REVISION" ]] || {
  echo "Pinned SPP checkout is not at $PINNED_REVISION" >&2
  exit 1
}
[[ -z "$(git -C "$SPP_ROOT" status --short)" ]] || {
  echo "Pinned SPP checkout has local changes; refusing to build deployment artifacts." >&2
  exit 1
}

rustup target add --toolchain 1.97.1 wasm32v1-none
CARGO_BINARY="$(rustup which --toolchain 1.97.1 cargo)"
export PATH="$(dirname "$CARGO_BINARY"):$PATH"

mkdir -p "$OUTPUT_DIR"
for package in asp-membership asp-non-membership public-key-registry pool; do
  stellar contract build \
    --manifest-path "$SPP_ROOT/Cargo.toml" \
    --out-dir "$OUTPUT_DIR" \
    --optimize \
    --package "$package"
done

"$SPP_ROOT/scripts/build-verifier-with-vk.sh" \
  "$SPP_ROOT/deployments/testnet/circuit_keys/policy_tx_2_2_B_vk.json" \
  --out-dir "$OUTPUT_DIR" \
  --wasm-name circom_groth16_verifier_B.wasm

cd "$OUTPUT_DIR"
shasum -a 256 -c <<'HASHES'
51c6b3752bc89f5ddd5cc57472e3b808bdc7e1311d19cdc03b29a3129c8f42a3  asp_membership.wasm
4b3a6058063641953e76dd5fb4451f6ecebee2b52c225b3c93b3ab08cf83b5e3  asp_non_membership.wasm
0b612d77030494a6f9490416ae0dae3708e70142f1a828cf9dc5e2ead43cfd2b  circom_groth16_verifier_B.wasm
47d68ca6096cce15d1bf383fc8427ec6a44d95a62d73610d796ff9b4db39f867  pool.wasm
6806c9ea5aaf8e3d6e09b2f0deb2852ca267b6b8be94be775381ff89e2354f7f  public_key_registry.wasm
HASHES
