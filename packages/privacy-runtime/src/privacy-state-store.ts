import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { z } from "zod";

import {
  PRIVACY_STATE_SCHEMA_VERSION,
  emptyPrivacyState,
  privacyStateSchema,
  type PrivacyState,
} from "./state.js";

const ENVELOPE_FORMAT = "PHLOEM_PRIVACY_STATE_AES_256_GCM_V1";
const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

const envelopeSchema = z.object({
  format: z.literal(ENVELOPE_FORMAT),
  schemaVersion: z.literal(1),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16}$/u),
  ciphertext: z.string().regex(/^[A-Za-z0-9_-]+$/u),
  authenticationTag: z.string().regex(/^[A-Za-z0-9_-]{22}$/u),
}).strict();

type TransactionCallback<T> = (draft: PrivacyState) => T | Promise<T>;

export class PrivacyStateIntegrityError extends Error {
  constructor() {
    super("privacy state could not be authenticated or decoded");
    this.name = "PrivacyStateIntegrityError";
  }
}

export class PrivacyStateStoreClosedError extends Error {
  constructor() {
    super("privacy state store is closed");
    this.name = "PrivacyStateStoreClosedError";
  }
}

function additionalAuthenticatedData(): Buffer {
  return Buffer.from(`${ENVELOPE_FORMAT}:1`, "utf8");
}

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

function cloneState(value: PrivacyState): PrivacyState {
  return structuredClone(value);
}

function decodePrivacyState(value: unknown): PrivacyState {
  if (typeof value === "object" && value !== null && "schemaVersion" in value && value.schemaVersion === 1) {
    return privacyStateSchema.parse({
      ...value,
      schemaVersion: PRIVACY_STATE_SCHEMA_VERSION,
      treasuryPrivacyKeys: [],
      sppTreasuryNotes: [],
      sppSpendOperations: [],
      privateSessionActivations: [],
      agentIdentities: [],
    });
  }
  if (typeof value === "object" && value !== null && "schemaVersion" in value && value.schemaVersion === 2) {
    return privacyStateSchema.parse({
      ...value,
      schemaVersion: PRIVACY_STATE_SCHEMA_VERSION,
      sppSpendOperations: [],
      privateSessionActivations: [],
      agentIdentities: [],
    });
  }
  if (typeof value === "object" && value !== null && "schemaVersion" in value && value.schemaVersion === 3) {
    return privacyStateSchema.parse({
      ...value,
      schemaVersion: PRIVACY_STATE_SCHEMA_VERSION,
      privateSessionActivations: [],
      agentIdentities: [],
    });
  }
  if (typeof value === "object" && value !== null && "schemaVersion" in value && value.schemaVersion === 4) {
    return privacyStateSchema.parse({
      ...value,
      schemaVersion: PRIVACY_STATE_SCHEMA_VERSION,
      agentIdentities: [],
    });
  }
  return privacyStateSchema.parse(value);
}

/**
 * Trusted-boundary storage. Callers must never pass snapshots to the LLM,
 * frontend, relayer, indexer, or ordinary application logs.
 */
export class EncryptedPrivacyStateStore {
  readonly #path: string;
  readonly #key: Buffer;
  #closed = false;
  #tail: Promise<void> = Promise.resolve();

  constructor(path: string, encryptionKey: Uint8Array) {
    if (encryptionKey.length !== 32) throw new RangeError("privacy state encryption key must be exactly 32 bytes");
    this.#path = path;
    this.#key = Buffer.from(encryptionKey);
  }

  async initialize(): Promise<void> {
    await this.#exclusive(async () => {
      this.#assertOpen();
      try {
        const metadata = await lstat(this.#path);
        if (metadata.isSymbolicLink() || !metadata.isFile()) throw new PrivacyStateIntegrityError();
        await this.#readUnlocked();
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await this.#writeUnlocked(emptyPrivacyState());
      }
    });
  }

  async readSnapshot(): Promise<PrivacyState> {
    return this.#exclusive(async () => {
      this.#assertOpen();
      return cloneState(await this.#readUnlocked());
    });
  }

  async transaction<T>(callback: TransactionCallback<T>): Promise<T> {
    return this.#exclusive(async () => {
      this.#assertOpen();
      const current = await this.#readUnlocked();
      const draft = cloneState(current);
      const result = await callback(draft);
      draft.revision = current.revision + 1;
      const validated = privacyStateSchema.parse(draft);
      await this.#writeUnlocked(validated);
      return result;
    });
  }

  async resetClean(confirmation: "RESET_PRIVATE_STATE"): Promise<void> {
    if (confirmation !== "RESET_PRIVATE_STATE") throw new Error("explicit private-state reset confirmation is required");
    await this.#exclusive(async () => {
      this.#assertOpen();
      await this.#writeUnlocked(emptyPrivacyState());
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#key.fill(0);
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new PrivacyStateStoreClosedError();
  }

  #encrypt(state: PrivacyState): string {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(ENCRYPTION_ALGORITHM, this.#key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(additionalAuthenticatedData());
    const plaintext = Buffer.from(JSON.stringify(state), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    plaintext.fill(0);
    const envelope = {
      format: ENVELOPE_FORMAT,
      schemaVersion: 1 as const,
      nonce: encodeBase64Url(nonce),
      ciphertext: encodeBase64Url(ciphertext),
      authenticationTag: encodeBase64Url(cipher.getAuthTag()),
    };
    return `${JSON.stringify(envelope)}\n`;
  }

  #decrypt(serialized: string): PrivacyState {
    try {
      const envelope = envelopeSchema.parse(JSON.parse(serialized) as unknown);
      const nonce = decodeBase64Url(envelope.nonce);
      const tag = decodeBase64Url(envelope.authenticationTag);
      if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) throw new Error("invalid encrypted envelope");
      const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, this.#key, nonce, { authTagLength: TAG_BYTES });
      decipher.setAAD(additionalAuthenticatedData());
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(decodeBase64Url(envelope.ciphertext)),
        decipher.final(),
      ]);
      try {
        return decodePrivacyState(JSON.parse(plaintext.toString("utf8")) as unknown);
      } finally {
        plaintext.fill(0);
      }
    } catch {
      throw new PrivacyStateIntegrityError();
    }
  }

  async #readUnlocked(): Promise<PrivacyState> {
    try {
      const metadata = await lstat(this.#path);
      if (metadata.isSymbolicLink() || !metadata.isFile()) throw new PrivacyStateIntegrityError();
      return this.#decrypt(await readFile(this.#path, "utf8"));
    } catch (error: unknown) {
      if (error instanceof PrivacyStateIntegrityError) throw error;
      throw new PrivacyStateIntegrityError();
    }
  }

  async #writeUnlocked(state: PrivacyState): Promise<void> {
    const directory = dirname(this.#path);
    await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
    const temporaryPath = join(
      directory,
      `.${basename(this.#path)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined = await open(temporaryPath, "wx", FILE_MODE);
    let renamed = false;
    try {
      await handle.writeFile(this.#encrypt(state), "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.#path);
      renamed = true;
      await chmod(this.#path, FILE_MODE);
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error: unknown) {
      if (handle) await handle.close().catch(() => undefined);
      if (!renamed) await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}
