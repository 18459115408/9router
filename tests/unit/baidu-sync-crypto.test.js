import { describe, it, expect } from "vitest";
import { encryptBuffer, decryptBuffer, isEncryptedBlob } from "@/lib/sync/baidu/crypto.js";

describe("baidu sync crypto", () => {
  it("roundtrips a payload", () => {
    const plain = Buffer.from("hello 9router 你好 " + "x".repeat(5000), "utf8");
    const blob = encryptBuffer(plain, "test-passphrase");
    expect(isEncryptedBlob(blob)).toBe(true);
    expect(decryptBuffer(blob, "test-passphrase").equals(plain)).toBe(true);
  });

  it("produces a different ciphertext each time (fresh salt/iv)", () => {
    const plain = Buffer.from("same input");
    const a = encryptBuffer(plain, "k");
    const b = encryptBuffer(plain, "k");
    expect(a.equals(b)).toBe(false);
  });

  it("rejects a wrong passphrase (auth tag)", () => {
    const blob = encryptBuffer(Buffer.from("secret"), "right-key");
    expect(() => decryptBuffer(blob, "wrong-key")).toThrow();
  });

  it("rejects tampered ciphertext", () => {
    const blob = encryptBuffer(Buffer.from("secret"), "k");
    blob[blob.length - 1] ^= 0xff;
    expect(() => decryptBuffer(blob, "k")).toThrow();
  });

  it("rejects non-blob input", () => {
    expect(isEncryptedBlob(Buffer.from("plain sqlite file bytes..."))).toBe(false);
    expect(() => decryptBuffer(Buffer.from("nope"), "k")).toThrow(/magic/);
  });

  it("compresses repetitive payloads", () => {
    const plain = Buffer.alloc(1024 * 1024, 0x41);
    const blob = encryptBuffer(plain, "k");
    expect(blob.length).toBeLessThan(plain.length / 10);
  });
});
