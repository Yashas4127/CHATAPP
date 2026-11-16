import crypto from "node:crypto";

/**
 * AES-256-GCM message vault.
 * Every message is stored as "v1.<iv>.<tag>.<ciphertext>" (base64 parts).
 * The conversation id is bound in as additional authenticated data, so a
 * ciphertext copied into another conversation fails to decrypt.
 */
export function createVault(hexKey) {
  const key = Buffer.from(hexKey, "hex");
  if (key.length !== 32) throw new Error("Encryption key must be 32 bytes (64 hex characters).");

  function encrypt(plaintext, context) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(String(context)));
    const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ["v1", iv.toString("base64"), tag.toString("base64"), data.toString("base64")].join(".");
  }

  function decrypt(payload, context) {
    try {
      const [version, iv, tag, data] = String(payload).split(".");
      if (version !== "v1") throw new Error("Unknown format");
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
      decipher.setAAD(Buffer.from(String(context)));
      decipher.setAuthTag(Buffer.from(tag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
    } catch {
      return "[message could not be decrypted]";
    }
  }

  return { encrypt, decrypt };
}
