import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const REQUIRED_KEY_LENGTH = 32; // AES-256 = 32 bytes

const CURRENT_KEY_ID = "v1";

/** Load key registry from env vars. Supports rotation via HOMER_ENCRYPTION_KEY_V1, V2, etc. */
function getKeyRegistry(): Record<string, Buffer> {
  const registry: Record<string, Buffer> = {};

  // Load versioned keys: HOMER_ENCRYPTION_KEY_V1, HOMER_ENCRYPTION_KEY_V2, etc.
  for (const [name, value] of Object.entries(process.env)) {
    const match = name.match(/^HOMER_ENCRYPTION_KEY_(V\d+)$/i);
    if (match && value) {
      const keyId = match[1]!.toLowerCase();
      const buf = Buffer.from(value, "hex");
      if (buf.length !== REQUIRED_KEY_LENGTH) {
        throw new Error(`Encryption key ${name} must be ${REQUIRED_KEY_LENGTH} bytes, got ${buf.length}`);
      }
      registry[keyId] = buf;
    }
  }

  // Fallback: HOMER_ENCRYPTION_KEY as "v1" if no versioned keys
  if (Object.keys(registry).length === 0) {
    const keyHex = process.env.HOMER_ENCRYPTION_KEY;
    if (!keyHex) throw new Error("HOMER_ENCRYPTION_KEY not set");
    const buf = Buffer.from(keyHex, "hex");
    if (buf.length !== REQUIRED_KEY_LENGTH) {
      throw new Error(`HOMER_ENCRYPTION_KEY must be ${REQUIRED_KEY_LENGTH} bytes, got ${buf.length}`);
    }
    registry[CURRENT_KEY_ID] = buf;
  }

  return registry;
}

function getKey(keyId?: string): Buffer {
  const registry = getKeyRegistry();
  const id = keyId ?? CURRENT_KEY_ID;
  const key = registry[id];
  if (!key) throw new Error(`Encryption key not found for keyId: ${id}`);
  return key;
}

export interface EncryptedValue {
  ciphertext: string; // base64
  iv: string; // base64
  tag: string; // base64
  keyId: string;
}

export function encrypt(plaintext: string, keyId = CURRENT_KEY_ID): EncryptedValue {
  const key = getKey(keyId);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    keyId,
  };
}

export function decrypt(value: EncryptedValue): string {
  const key = getKey(value.keyId);
  const iv = Buffer.from(value.iv, "base64");
  const tag = Buffer.from(value.tag, "base64");
  const ciphertext = Buffer.from(value.ciphertext, "base64");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
