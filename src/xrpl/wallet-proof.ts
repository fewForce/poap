/**
 * Proof that somebody holds an address's key, without Xaman: a signature by
 * that key over a message this server can rebuild.
 *
 * WHAT IS SIGNED. Plain text, built by both sides from the same fields and
 * never sent as a whole — the client sends the fields, the server rebuilds the
 * text, and only then checks the signature. So a signature covers exactly the
 * event, the address, the name and email being registered, and the server's
 * challenge; change any one and it no longer verifies.
 *
 * WHY IT CANNOT BE A TRANSACTION. A transaction's signing bytes begin with the
 * 0x53545800 ("STX\0") prefix. This message begins "poap.live", so no signature
 * made here can ever be replayed onto the ledger as a transaction, nor one made
 * for the ledger presented here.
 */
import { convertStringToHex, deriveAddress, verifyKeypairSignature } from "xrpl";
import { XrplLayerError } from "../errors.js";
import type { EventId, XrplGateway } from "../types.js";
import { isRippledError } from "./client.js";

export const REGISTRATION_MESSAGE_PREFIX = "poap.live registration";

export interface RegistrationFields {
  eventId: EventId;
  address: string;
  displayName: string;
  /** Absent and empty are the same: an empty line. */
  email?: string | null;
  challenge: string;
}

/** The exact text a wallet signs to register. The app builds the same text. */
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
 * True when `publicKey` belongs to `address` and signed `message`. Never
 * throws: a malformed key or signature is simply not a proof.
 */
export function isSignedByAddress(input: {
  address: string;
  publicKey: string;
  signature: string;
  message: string;
}): boolean {
  try {
    if (deriveAddress(input.publicKey) !== input.address) return false;
    return verifyKeypairSignature(convertStringToHex(input.message), input.signature, input.publicKey);
  } catch {
    return false;
  }
}

/** lsfDisableMaster on an AccountRoot. */
const DISABLE_MASTER = 0x0010_0000;

/**
 * Whether the address's master key still speaks for it.
 *
 * A signature can only come from the master key — the address is derived from
 * it — and an account that has disabled its master key has said that key no
 * longer counts: it may be lost, or in somebody else's hands. An account not
 * on the ledger yet has nothing disabled; a brand-new app wallet is exactly
 * that, until the desk tops it up.
 */
export async function masterKeyCounts(gateway: XrplGateway, address: string): Promise<boolean> {
  let response: { result?: { account_data?: { Flags?: unknown } } };
  try {
    response = await gateway.request({ command: "account_info", account: address, ledger_index: "validated" });
  } catch (err) {
    if (isRippledError(err, "actNotFound")) return true;
    throw new XrplLayerError(
      "LEDGER_QUERY_FAILED",
      `account_info for ${address} failed: ${err instanceof Error ? err.message : String(err)}`,
      { method: "account_info", address },
    );
  }
  const flags = Number(response?.result?.account_data?.Flags ?? 0);
  return (flags & DISABLE_MASTER) === 0;
}
