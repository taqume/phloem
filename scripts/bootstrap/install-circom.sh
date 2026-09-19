#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
install_root="${repo_root}/.phloem/toolchain/circom"

rustup run 1.91.0 cargo install \
  --git https://github.com/iden3/circom.git \
  --rev a100faedb1c62d4d3e1463f8a3f88342d82351cd \
  --locked \
  --root "${install_root}" \
  --force \
  circom

"${install_root}/bin/circom" --version
