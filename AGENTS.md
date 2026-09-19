# Phloem repository rules

`PHLOEM_MASTER_SPEC.md` is the private canonical product and protocol specification. It is intentionally ignored by Git. Read it before changing protocol behavior, but never stage or commit it.

## Priority

1. Preserve economic conservation, authorization boundaries, privacy, and atomicity.
2. Prefer Stellar-native primitives and current official APIs.
3. Keep the Genesis Track P0 narrow enough for one developer.
4. Treat tests, deployment evidence, and judge-facing documentation as implementation work.

## Locked P0 boundaries

- Company authorization is `Session.company: Address` plus `require_auth`; Root authority never passes through an AI Smart Account.
- Agent Smart Accounts have expiring `CallContract(TreasuryController)` authority and no company signer.
- STANDARD payment is a direct atomic SAC transfer. MPP is roadmap.
- PRIVATE payment uses SPP, a reservation-specific voucher key, one binding proof, refund creation, and the canonical audit update in the same Soroban call tree.
- Circuits use Circom, Groth16, BN254, and the pinned Poseidon2 parameter set.
- The only P0 audit predicate is `TOTAL_SPEND_LEQ`.
- The only P0 provider is the deterministic Research Data Service.
- Do not add production recovery, governance, marketplaces, additional providers, or mutable active-session policies.

## Security

- Never commit Stellar secret keys, SPP note secrets, witness files, proving secrets, Anchor tokens, or PrivacyStateStore contents.
- Before any step needs an API key, wallet signature, account authorization, or comparable user-controlled credential, stop and ask the user for that exact input. Never fabricate, extract, or silently substitute one.
- Keep user-provided credentials server-side and out of Git, browser bundles, logs, documentation, prompts, and test fixtures.
- Test fixture keys must be unmistakably deterministic and non-production.
- Do not weaken settlement/audit atomicity to work around resource limits. Report the blocker.
- A relayer, indexer, frontend, agent process, or generic backend is never a financial authority.

## Verification

Run `pnpm phase0:check` for protocol encoding changes. Contract, circuit, and Testnet work must add the relevant positive and negative tests and retain resource evidence.
