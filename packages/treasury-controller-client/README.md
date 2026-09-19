# TreasuryController TypeScript client

Stellar CLI generates this typed client from the final
`phloem_treasury_controller.wasm` contract spec. The package contains no
network address, signer, secret, or deployment state.

Run the ABI drift check after each contract build:

```bash
pnpm contracts:bindings:check
```

Application code supplies `contractId`, `rpcUrl`, `networkPassphrase`, the
transaction source public key, and an explicit signing callback when it creates
`Client`. Calling a generated method builds and simulates an
`AssembledTransaction`; no method submits until the caller invokes a signing and
sending path.
