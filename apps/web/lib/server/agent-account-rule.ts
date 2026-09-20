interface DecodedContextRule {
  readonly context_type?: { readonly tag?: string; readonly values?: readonly unknown[] };
  readonly signers?: readonly { readonly tag?: string; readonly values?: readonly unknown[] }[];
  readonly valid_until?: number;
}

export interface ExpectedAgentAccountRule {
  readonly controllerId: string;
  readonly verifierId: string;
  readonly publicKeyHex: string;
  readonly validUntilLedger: number;
}

function bytes32Hex(value: unknown): string | null {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) return null;
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("hex");
}

export function assertCanonicalAgentAccountRule(
  value: unknown,
  expected: ExpectedAgentAccountRule,
): void {
  const rule = value as DecodedContextRule;
  const signer = rule.signers?.[0];
  const signerValues = signer?.values;
  const signerKey = signerValues?.[1];
  if (
    rule.context_type?.tag !== "CallContract"
    || rule.context_type.values?.[0] !== expected.controllerId
    || rule.signers?.length !== 1
    || signer?.tag !== "External"
    || signerValues?.[0] !== expected.verifierId
    || bytes32Hex(signerKey) !== expected.publicKeyHex
    || rule.valid_until !== expected.validUntilLedger
  ) {
    throw new Error("confirmed AgentAccount rule differs from the session-bound identity");
  }
}
