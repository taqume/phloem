export interface WalletConnectionApi {
  fetchAddress: () => Promise<{ address: string }>;
  getNetwork: () => Promise<{ network: string; networkPassphrase: string }>;
}

const DEFAULT_WALLET_TIMEOUT_MS = 20_000;

async function withWalletTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error("Freighter did not respond. Open and unlock the extension, then try again."));
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export async function requestWalletConnection(
  api: WalletConnectionApi,
  timeoutMs = DEFAULT_WALLET_TIMEOUT_MS,
) {
  const { address } = await withWalletTimeout(api.fetchAddress(), timeoutMs);
  const network = await withWalletTimeout(api.getNetwork(), timeoutMs);
  return { address, network };
}

export function walletErrorMessage(reason: unknown, fallback: string): string {
  if (reason instanceof Error && reason.message) return reason.message;
  if (typeof reason === "string" && reason) return reason;
  if (typeof reason === "object" && reason !== null && "message" in reason) {
    const message = (reason as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  if (typeof reason === "object" && reason !== null && "error" in reason) {
    return walletErrorMessage((reason as { error?: unknown }).error, fallback);
  }
  return fallback;
}

function walletErrorCode(reason: unknown): number | undefined {
  if (typeof reason !== "object" || reason === null) return undefined;
  if ("code" in reason && typeof (reason as { code?: unknown }).code === "number") {
    return (reason as { code: number }).code;
  }
  if ("error" in reason) return walletErrorCode((reason as { error?: unknown }).error);
  return undefined;
}

export function walletStageError(stage: string, reason: unknown, fallback: string): string {
  if (stage === "Freighter signing" && walletErrorCode(reason) === -4) {
    return "Freighter signing: the wallet window closed before returning a signed transaction (SEP-43 code -4). No transaction was submitted.";
  }
  return `${stage}: ${walletErrorMessage(reason, fallback)}`;
}
