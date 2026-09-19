#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
wasm="$repo_root/target/wasm32v1-none/release/phloem_treasury_controller.wasm"
binding="$repo_root/packages/treasury-controller-client/src/index.ts"
mode="${1:-check}"

if [[ "$mode" != "check" && "$mode" != "--write" ]]; then
  echo "usage: $0 [--write]" >&2
  exit 2
fi

if [[ ! -f "$wasm" ]]; then
  echo "TreasuryController WASM is missing; run pnpm contracts:build first." >&2
  exit 1
fi

temporary="$(mktemp -d "${TMPDIR:-/tmp}/phloem-bindings.XXXXXX")"
trap 'rm -rf "$temporary"' EXIT

stellar contract bindings typescript \
  --wasm "$wasm" \
  --output-dir "$temporary/generated" \
  --overwrite \
  >/dev/null

# The Stellar generator emits type-only symbols in a value import. Normalize
# that output so consumers using verbatimModuleSyntax can compile the binding.
perl -0pi -e '
  s/  ClientOptions as ContractClientOptions,\n  MethodOptions,\n  Result,\n//;
  s/import type \{\n/import type {\n  ClientOptions as ContractClientOptions,\n  MethodOptions,\n  Result,\n/;
  s/\z/\n/ unless /\n\z/;
' "$temporary/generated/src/index.ts"

if [[ "$mode" == "--write" ]]; then
  cp "$temporary/generated/src/index.ts" "$binding"
  echo "Regenerated TreasuryController TypeScript binding from the current WASM."
  exit 0
fi

if ! cmp -s "$temporary/generated/src/index.ts" "$binding"; then
  echo "TreasuryController TypeScript binding is stale; regenerate it from the current WASM." >&2
  diff -u "$binding" "$temporary/generated/src/index.ts" || true
  exit 1
fi

echo "TreasuryController TypeScript binding matches the current WASM."
