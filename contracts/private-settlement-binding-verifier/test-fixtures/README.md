# PrivateSettlementBindingV1 verifier fixture

These public fixtures were generated from `PrivateSettlementBindingV1.circom`
with Circom 2.2.3 and snarkjs 0.7.6. The Phase 1 and circuit-specific Phase 2
setup used explicitly non-production, single-contributor test entropy. The proof
and verification key contain no witness or production secret.

The circuit has 18,487 constraints and 16 public inputs. The R1CS SHA-256 is
`9ed3a4936475b5fde5c3b547e29c50e2442a00abf3fa08073e91be0c7e7570e3`; the
verification-key SHA-256 is
`4fcd4629d37732d6279a23003568c191636ca153ab138aa71774ef60ac3485cb`.

These files exist only to exercise the real BN254 Groth16 verifier in native
contract tests. A deployment verification key requires separately recorded
hackathon setup provenance; production requires a proper multi-party ceremony.
