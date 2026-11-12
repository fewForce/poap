/**
 * near_signature: wallet_signature for a NEAR implicit account.
 *
 * An implicit account's id IS its ed25519 public key, in lowercase hex. So the
 * proof needs no network: the key the id spells out must have signed the
 * registration text, built by registrationMessage() exactly as for XRPL, with
 * the account id on its `address:` line.
 *
 * The POAP app holds ed25519 keys and uses the same key for both chains: its
 * XRPL address and its NEAR implicit account are two names for one key. A
 * signature here cannot be replayed as a transaction on either chain. XRPL
 * signs bytes that start "STX\0"; NEAR signs a 32-byte sha256 of a borsh
 * transaction; this text starts "poap.live registration".
 *
 * What it proves is the key that made the account, not current control. A
 * funded implicit account can add keys and delete that one; registration
 * accepts that, as wallet_signature accepts it for an XRPL key that has not
 * been disabled.
 *
 * Named accounts (alice.near) are not covered: their keys are on chain and can
 * be anything. They register on the website, by typing the account
 * (self_declared), until NEAR wallet sign-in exists there.
 */
import { convertStringToHex, verifyKeypairSignature } from "xrpl";
import { isImplicitAccountId } from "./account.js";

/**
 * The 32-byte key as 64 lowercase hex, from either spelling the app may send:
 * bare, or XRPL's 66-character form with its `ED` prefix.
 */
export function ed25519KeyHex(publicKey: string): string | null {
  const key = publicKey.toLowerCase();
  if (/^ed[0-9a-f]{64}$/.test(key)) return key.slice(2);
  if (/^[0-9a-f]{64}$/.test(key)) return key;
  return null;
}

/** True when the implicit account's own key signed `message`. Never throws. */
export function isSignedByImplicitAccount(input: {
  accountId: string;
  publicKey: string;
  signature: string;
  message: string;
}): boolean {
  try {
    if (!isImplicitAccountId(input.accountId)) return false;
    const key = ed25519KeyHex(input.publicKey);
    if (!key || key !== input.accountId) return false;
    if (!/^[0-9A-Fa-f]{128}$/.test(input.signature)) return false;
    return verifyKeypairSignature(convertStringToHex(input.message), input.signature, `ED${key.toUpperCase()}`);
  } catch {
    return false;
  }
}
