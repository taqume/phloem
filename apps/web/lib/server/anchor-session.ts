import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export const ANCHOR_SESSION_COOKIE = "phloem_anchor_session";
export const ANCHOR_SESSION_MAX_AGE_SECONDS = 20 * 60;

export interface AnchorSession {
  account: string;
  expiresAt: number;
  token: string;
}

function encryptionKey(): Buffer {
  const secret = process.env.ANCHOR_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("ANCHOR_SESSION_SECRET must be set to a random value of at least 32 characters in apps/web/.env.local.");
  }
  return createHash("sha256").update(secret, "utf8").digest();
}

export function sealAnchorSession(session: AnchorSession): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(session), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64url");
}

export function openAnchorSession(value: string | undefined): AnchorSession {
  if (!value) throw new Error("Anchor authentication is required.");
  try {
    const payload = Buffer.from(value, "base64url");
    if (payload.length < 29) throw new Error("Invalid session payload.");
    const iv = payload.subarray(0, 12);
    const tag = payload.subarray(12, 28);
    const encrypted = payload.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
    decipher.setAuthTag(tag);
    const decoded = JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8")) as AnchorSession;
    if (!decoded.account || !decoded.token || decoded.expiresAt <= Date.now()) throw new Error("Expired session.");
    return decoded;
  } catch {
    throw new Error("Anchor authentication expired or is invalid. Sign a new SEP-10 challenge.");
  }
}

export const anchorSessionCookieOptions = {
  httpOnly: true,
  maxAge: ANCHOR_SESSION_MAX_AGE_SECONDS,
  path: "/api/anchor",
  sameSite: "strict" as const,
  secure: process.env.NODE_ENV === "production",
};
