#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
upstream_root="${repo_root}/.phloem/upstream"
mkdir -p "${upstream_root}"

ensure_checkout() {
  local name="$1"
  local url="$2"
  local revision="$3"
  local target="${upstream_root}/${name}"

  if [[ ! -d "${target}/.git" ]]; then
    if [[ -e "${target}" ]]; then
      echo "Refusing to overwrite non-git path: ${target}" >&2
      return 1
    fi
    git clone --filter=blob:none "${url}" "${target}"
  fi

  if [[ -n "$(git -C "${target}" status --porcelain)" ]]; then
    echo "Refusing to change dirty checkout: ${target}" >&2
    return 1
  fi

  git -C "${target}" fetch --depth 1 origin "${revision}"
  git -C "${target}" checkout --detach "${revision}"
  test "$(git -C "${target}" rev-parse HEAD)" = "${revision}"
}

ensure_checkout \
  stellar-contracts \
  https://github.com/OpenZeppelin/stellar-contracts.git \
  f11f8c0f7001f0ac61ffedb4c4f234ecfe7e1feb

ensure_checkout \
  smart-account-kit \
  https://github.com/stellar/smart-account-kit.git \
  33f4044330ced023d45d200b004e7f42f0ea9eed

ensure_checkout \
  stellar-private-payments \
  https://github.com/NethermindEth/stellar-private-payments.git \
  5f3a5d41f452069caf8d0e1654675bca55cb94d3

echo "Pinned clean upstreams are available under ${upstream_root}"
