# PrivateRootBackingV1 verifier fixture

These public fixtures were generated from `PrivateRootBackingV1.circom` with
Circom 2.2.3 and snarkjs 0.7.6. The setup uses explicitly non-production,
single-contributor test entropy. The proof and verification key contain no
witness or production secret.

The circuit has 3,476 constraints and seven public inputs. The R1CS SHA-256 is
`fa0c4fcb481b7dd1e3b17b357487d1bb504b858803a5be872e61f2a0e007ee5f`; the
verification-key SHA-256 is
`36cd9762d1ffcdd5d32c35f11d31e707a03fc1738a6432439a576923e590fb8c`.

These files exercise the real BN254 Groth16 verifier in native contract tests.
A deployment key needs separately recorded hackathon setup provenance;
production requires a proper multi-party ceremony.
