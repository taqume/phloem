#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
upstream_root="${repo_root}/.phloem/upstream"

"${repo_root}/scripts/bootstrap/fetch-pinned-upstreams.sh"

rustup run 1.91.0 cargo test \
  --manifest-path "${upstream_root}/stellar-contracts/Cargo.toml" \
  -p stellar-accounts

corepack pnpm@10.33.0 --dir "${upstream_root}/smart-account-kit" install --frozen-lockfile
corepack pnpm@10.33.0 --dir "${upstream_root}/smart-account-kit" build
corepack pnpm@10.33.0 --dir "${upstream_root}/smart-account-kit" test

rustup run 1.95.0 cargo check \
  --manifest-path "${upstream_root}/stellar-private-payments/Cargo.toml" \
  -p stellar-private-payments \
  --locked

echo "Pinned upstream compatibility checks: PASS"
