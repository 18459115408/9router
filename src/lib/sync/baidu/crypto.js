// Encrypted container for the synced DB snapshot.
//
// Format: MAGIC(8) | salt(16) | iv(12) | gcm-tag(16) | AES-256-GCM(gzip(payload))
// The salt is generated per file, so one passphrase ("BAIDU_SYNC_KEY") works on
// every machine while each upload still gets a fresh key + IV. Auth-tag failure
// means wrong passphrase or corrupted download — callers must treat that as
// "cannot trust remote" instead of overwriting local data.
import crypto from "node:crypto";
import zlib from "node:zlib";

const MAGIC = Buffer.from("9RSYNC1", "utf8"); // 8 bytes
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
export const HEADER_LEN = MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN;

export function deriveKey(passphrase, salt) {
  if (!passphrase) throw new Error("Missing sync passphrase");
  return crypto.scryptSync(String(passphrase), salt, 32);
}

export function isEncryptedBlob(buf) {
  return Buffer.isBuffer(buf) && buf.length > HEADER_LEN && buf.subarray(0, MAGIC.length).equals(MAGIC);
}

export function encryptBuffer(plain, passphrase) {
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt);
  const compressed = zlib.gzipSync(plain);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), ciphertext]);
}

// Returns the gzip-decompressed payload, or throws on tag mismatch / bad magic.
export function decryptBuffer(blob, passphrase) {
  if (!isEncryptedBlob(blob)) throw new Error("Not a 9router sync blob (bad magic)");
  const salt = blob.subarray(MAGIC.length, MAGIC.length + SALT_LEN);
  const iv = blob.subarray(MAGIC.length + SALT_LEN, MAGIC.length + SALT_LEN + IV_LEN);
  const tag = blob.subarray(HEADER_LEN - TAG_LEN, HEADER_LEN);
  const ciphertext = blob.subarray(HEADER_LEN);
  const key = deriveKey(passphrase, salt);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return zlib.gunzipSync(compressed);
}
