#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SPP_ROOT="$REPO_ROOT/.phloem/upstream/stellar-private-payments"
PINNED_REVISION="5f3a5d41f452069caf8d0e1654675bca55cb94d3"

if [[ ! -d "$SPP_ROOT/.git" ]]; then
  echo "Pinned SPP checkout is missing. Run pnpm phase1:upstreams first." >&2
  exit 1
fi
if [[ "$(git -C "$SPP_ROOT" rev-parse HEAD)" != "$PINNED_REVISION" ]]; then
  echo "Pinned SPP checkout revision does not match the runtime binding." >&2
  exit 1
fi
if [[ -n "$(git -C "$SPP_ROOT" status --short)" ]]; then
  echo "Pinned SPP checkout has local changes; refusing to run the resource probe." >&2
  exit 1
fi

cd "$REPO_ROOT"
rustup run 1.95.0 cargo run \
  --release \
  --locked \
  --manifest-path tools/spp-runtime-probe/Cargo.toml \
  --quiet
