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
  if (typeof reason === "object" && reason !== null && "message" in reason) {
    const message = (reason as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return fallback;
}
