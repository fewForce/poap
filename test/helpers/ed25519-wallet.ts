/**
 * A throwaway Ed25519 XRPL wallet that can sign arbitrary text — what the POAP
 * app does to register. Built on node:crypto, so the tests sign with an
 * implementation independent of the one that verifies.
 */
import { generateKeyPairSync, sign } from "node:crypto";
import { deriveAddress } from "xrpl";

export interface TestWallet {
  address: string;
  /** 0xED followed by the raw 32-byte key, as XRPL writes Ed25519 keys. */
  publicKey: string;
  sign(message: string): string;
}

export function ed25519Wallet(): TestWallet {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(String(publicKey.export({ format: "jwk" }).x), "base64url");
  const publicHex = "ED" + raw.toString("hex").toUpperCase();
  return {
    address: deriveAddress(publicHex),
    publicKey: publicHex,
    sign: (message) => sign(null, Buffer.from(message, "utf8"), privateKey).toString("hex").toUpperCase(),
  };
}
