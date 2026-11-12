/**
 * NEAR account ids: what a NEAR attendee is, as XRPL attendees are classic
 * addresses.
 *
 * Two kinds are accepted:
 *
 *   named     alice.near, alice.testnet, desk.feooh.testnet
 *   implicit  64 lowercase hex characters: an ed25519 public key, which is an
 *             account the moment anyone uses it. The POAP app's wallets are
 *             these — the same key as the wallet's XRPL address.
 *
 * ETH-implicit accounts (0x + 40 hex) are refused for now: they are controlled
 * by an Ethereum key through a wallet contract, and nothing here has been
 * checked against one.
 *
 * Strict on purpose. An account id goes into badge art, a URL path and a
 * contract call; the NEAR protocol's own rule is the only shape allowed in.
 */
import { ValidationError } from "../errors.js";
import type { NearNetwork } from "../types.js";

/** nearcore's account-id rule: parts of [a-z0-9] joined by single - or _, parts separated by single dots. */
const NAMED = /^(?:(?:[a-z\d]+[-_])*[a-z\d]+\.)*(?:[a-z\d]+[-_])*[a-z\d]+$/;
const IMPLICIT = /^[0-9a-f]{64}$/;
const ETH_IMPLICIT = /^0x[0-9a-f]{40}$/;

export const MIN_ACCOUNT_ID_LENGTH = 2;
export const MAX_ACCOUNT_ID_LENGTH = 64;

export function isImplicitAccountId(value: string): boolean {
  return IMPLICIT.test(value);
}

/** Syntax only: says nothing about which network, or whether it exists. */
export function isNearAccountId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length < MIN_ACCOUNT_ID_LENGTH || value.length > MAX_ACCOUNT_ID_LENGTH) return false;
  if (ETH_IMPLICIT.test(value)) return false;
  return NAMED.test(value);
}

/**
 * Whether a named account can belong to this network at all. Testnet accounts
 * end in `.testnet`; on mainnet they never do, though they may end in `.near`,
 * `.tg` or any other top-level account. Implicit ids exist on both.
 */
export function fitsNetwork(accountId: string, network: NearNetwork): boolean {
  if (isImplicitAccountId(accountId)) return true;
  const testnetName = accountId === "testnet" || accountId.endsWith(".testnet");
  return network === "testnet" ? testnetName : !testnetName;
}

/** Throws INVALID_ADDRESS unless this could be an attendee on this network. */
export function assertNearAccountId(value: unknown, network: NearNetwork): asserts value is string {
  if (!isNearAccountId(value)) {
    throw new ValidationError(
      "INVALID_ADDRESS",
      "Not a NEAR account id. Use a named account such as alice.near, or a 64-character " +
        "implicit account.",
      { address: value },
    );
  }
  if (!fitsNetwork(value, network)) {
    throw new ValidationError(
      "INVALID_ADDRESS",
      network === "testnet"
        ? `${value} is not a testnet account: testnet accounts end in .testnet.`
        : `${value} is a testnet account, and this event is on NEAR mainnet.`,
      { address: value, network },
    );
  }
}
