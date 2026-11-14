/**
 * The wallet's keys: making one, and signing with it.
 *
 * The key is made on the phone and never leaves it. Nothing here talks to the
 * network, and the private key never escapes this module — a Signer can sign
 * for its own address and do nothing else.
 *
 * Kept free of anything Expo so it runs the same under Node, which is how it is
 * checked against a real ledger.
 */
import { base58 } from "@scure/base";
import { sha512 } from "@xrplf/isomorphic/sha512";
import { bytesToHex, hexToBytes, stringToHex } from "@xrplf/isomorphic/utils";
import { encode, encodeForSigning } from "ripple-binary-codec";
import { deriveAddress, deriveKeypair, generateSeed, sign } from "ripple-keypairs";

export interface Signer {
  readonly address: string;
  /**
   * The same key as a NEAR account: an ed25519 public key in lowercase hex is
   * a NEAR "implicit" account. Nothing has to be made or funded for it to hold
   * a badge, and the written backup covers it too.
   */
  readonly nearAccount: string;
  /** Signs a transaction for this wallet. Refuses one for any other account. */
  sign(tx: Record<string, unknown>): { txBlob: string; hash: string };
  /**
   * Signs the text that registers this wallet for an event — and nothing else
   * that is not a transaction. poap.live rebuilds the same text from the fields
   * and checks the signature before it writes a registration.
   */
  signRegistration(
    fields: Omit<RegistrationFields, "address">,
    opts?: { chain?: "xrpl" | "near" },
  ): { publicKey: string; signature: string };
}

/** The NEAR implicit account of an ed25519 key: its 32 bytes, in lowercase hex. */
export function nearAccountOf(publicKey: string): string {
  const key = publicKey.toLowerCase();
  if (!/^ed[0-9a-f]{64}$/.test(key)) throw new Error("only an ed25519 wallet has a NEAR account");
  return key.slice(2);
}

/**
 * The same key the way NEAR wallets import it — Meteor's "private crypto key",
 * MyNearWallet, near-cli: `ed25519:` and the base58 of the 32-byte secret
 * followed by the 32-byte public key. Null for a key that is not ed25519.
 *
 * It is the whole key, exactly as the seed is: for the backup screen only.
 */
export function nearPrivateKeyOf(seed: string): string | null {
  const { publicKey, privateKey } = deriveKeypair(seed.trim());
  if (!/^ED[0-9A-F]{64}$/i.test(privateKey) || !/^ED[0-9A-F]{64}$/i.test(publicKey)) return null;
  return `ed25519:${base58.encode(hexToBytes(privateKey.slice(2) + publicKey.slice(2)))}`;
}

// ---- registering -------------------------------------------------------------

export const REGISTRATION_MESSAGE_PREFIX = "poap.live registration";

export interface RegistrationFields {
  eventId: number;
  address: string;
  displayName: string;
  email: string | null;
  /** Issued by poap.live for this event and this address; expires in minutes. */
  challenge: string;
}

/**
 * The exact text a wallet signs to register, byte for byte the same as
 * poap.live's registrationMessage(). It begins "poap.live", which no
 * transaction's signing bytes ever do, so it can never be replayed onto the
 * ledger.
 */
export function registrationMessage(f: RegistrationFields): string {
  return [
    REGISTRATION_MESSAGE_PREFIX,
    `event: ${f.eventId}`,
    `address: ${f.address}`,
    `name: ${f.displayName}`,
    `email: ${f.email ?? ""}`,
    `challenge: ${f.challenge}`,
  ].join("\n");
}

/**
 * A new wallet secret from sixteen random bytes. Ed25519: the same kind of
 * key Xaman makes, and quick to sign with in JavaScript.
 */
export function newSeed(entropy: Uint8Array): string {
  if (entropy.length !== 16) throw new Error("a wallet secret needs exactly 16 bytes of entropy");
  return generateSeed({ entropy, algorithm: "ed25519" });
}

/** True when `text` is a wallet secret this app can use. */
export function isSeed(text: string): boolean {
  try {
    deriveKeypair(text.trim());
    return true;
  } catch {
    return false;
  }
}

export function signerFromSeed(seed: string): Signer {
  const { publicKey, privateKey } = deriveKeypair(seed.trim());
  const address = deriveAddress(publicKey);
  // Every wallet this app makes is ed25519. One imported from elsewhere might
  // not be; it still works on the XRP Ledger, and has no NEAR account.
  let nearAccount = "";
  try {
    nearAccount = nearAccountOf(publicKey);
  } catch {
    nearAccount = "";
  }
  return {
    address,
    nearAccount,
    sign(tx) {
      if (tx.Account !== address) throw new Error("refusing to sign a transaction for another account");
      const unsigned = { ...tx, SigningPubKey: publicKey };
      const TxnSignature = sign(encodeForSigning(unsigned as Parameters<typeof encodeForSigning>[0]), privateKey);
      const txBlob = encode({ ...unsigned, TxnSignature } as Parameters<typeof encode>[0]);
      return { txBlob, hash: transactionHash(txBlob) };
    },
    signRegistration(fields, opts) {
      const near = opts?.chain === "near";
      if (near && !nearAccount) throw new Error("this wallet's key cannot be a NEAR account");
      // The same text either way; on NEAR its address line is the NEAR account.
      const message = registrationMessage({ ...fields, address: near ? nearAccount : address });
      return { publicKey, signature: sign(stringToHex(message), privateKey) };
    },
  };
}

/** A transaction's id: the first half of SHA-512 over "TXN\0" and the signed bytes. */
export function transactionHash(txBlob: string): string {
  return bytesToHex(sha512(hexToBytes("54584E00" + txBlob))).slice(0, 64);
}
