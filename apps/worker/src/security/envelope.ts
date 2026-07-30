import { decodeBase64Secret, decodeBase64Url, encodeBase64Url, toArrayBufferView } from "./encoding";

// Envelope shape follows CF-Workers-WebSSH/frontend/src/password-crypto.ts (Apache-2.0),
// moved server-side with record-bound AAD and a deployment secret master key.
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export const CREDENTIAL_ENVELOPE_VERSION = 1 as const;

export type SecretField = "password" | "privateKey" | "passphrase" | "totp" | "pendingTotp" | "oauthTransaction";

export interface EncryptedEnvelope {
  version: typeof CREDENTIAL_ENVELOPE_VERSION;
  iv: string;
  ciphertext: string;
}

export interface EnvelopeContext {
  ownerId: string;
  recordId: string;
  field: SecretField;
}

function encodeContext(context: EnvelopeContext): Uint8Array<ArrayBuffer> {
  if (!context.ownerId || !context.recordId) throw new Error("Envelope context is incomplete");
  return toArrayBufferView(encoder.encode(`edgesh:v${CREDENTIAL_ENVELOPE_VERSION}:${context.ownerId}:${context.recordId}:${context.field}`));
}

async function importMasterKey(masterKey: string): Promise<CryptoKey> {
  const bytes = decodeBase64Secret(masterKey, 32);
  const keyBytes = toArrayBufferView(bytes);
  try {
    return await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  } finally {
    bytes.fill(0);
    keyBytes.fill(0);
  }
}

export async function encryptSecret(
  masterKey: string | undefined,
  plaintext: string,
  context: EnvelopeContext,
): Promise<EncryptedEnvelope> {
  if (!masterKey) throw new Error("CREDENTIAL_MASTER_KEY is required to store credentials");
  const key = await importMasterKey(masterKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = encoder.encode(plaintext);
  const plaintextBytes = toArrayBufferView(bytes);
  try {
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encodeContext(context), tagLength: 128 },
      key,
      plaintextBytes,
    ));
    return { version: CREDENTIAL_ENVELOPE_VERSION, iv: encodeBase64Url(iv), ciphertext: encodeBase64Url(ciphertext) };
  } finally {
    bytes.fill(0);
    plaintextBytes.fill(0);
  }
}

export async function decryptSecret(
  masterKey: string | undefined,
  envelope: EncryptedEnvelope,
  context: EnvelopeContext,
): Promise<string> {
  if (!masterKey) throw new Error("CREDENTIAL_MASTER_KEY is required to decrypt credentials");
  if (envelope.version !== CREDENTIAL_ENVELOPE_VERSION) throw new Error("Unsupported credential envelope version");
  const key = await importMasterKey(masterKey);
  const iv = decodeBase64Url(envelope.iv);
  const ciphertext = decodeBase64Url(envelope.ciphertext);
  const ivBytes = toArrayBufferView(iv);
  const ciphertextBytes = toArrayBufferView(ciphertext);
  if (iv.byteLength !== 12 || ciphertext.byteLength < 16) throw new Error("Invalid credential envelope");
  try {
    const plaintext = new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: ivBytes, additionalData: encodeContext(context), tagLength: 128 },
      key,
      ciphertextBytes,
    ));
    try {
      return decoder.decode(plaintext);
    } finally {
      plaintext.fill(0);
    }
  } catch {
    throw new Error("Credential envelope authentication failed");
  }
}
