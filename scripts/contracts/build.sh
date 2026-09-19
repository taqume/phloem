#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
contract_toolchain="1.95.0"
contract_toolchain_bin="$(dirname "$(rustup which cargo --toolchain "${contract_toolchain}")")"

cd "${repo_root}"

for package in \
  phloem-ed25519-verifier \
  phloem-budget-transition-verifier \
  phloem-agent-account \
  phloem-treasury-controller
do
  PATH="${contract_toolchain_bin}:${PATH}" \
    RUSTUP_TOOLCHAIN="${contract_toolchain}" \
    stellar contract build --locked --package "${package}"
done
