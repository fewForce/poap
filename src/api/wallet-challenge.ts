/**
 * The challenge a wallet signs to register — fresh, bound to one event and one
 * address, and stateless.
 *
 * A challenge is `eventId.address.expiresAtMs.nonce.mac`, the mac an HMAC over
 * the rest. Nothing is stored when one is issued, so asking for challenges
 * costs the server no memory and survives a restart or a second process.
 *
 * NOT SINGLE-USE, AND THAT IS FINE. The signature also covers the name and
 * email being registered (src/xrpl/wallet-proof.ts), so replaying a signed
 * request can only register the same address, for the same event, under the
 * same name — what its signer asked for. The unique (event, address) index
 * turns a second copy into a 409. Expiry is what keeps a signature from being
 * held back and used weeks later.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { EventId } from "../types.js";

/** Long enough to type a name on a phone; short enough that a leaked one goes stale. */
export const CHALLENGE_TTL_MS = 10 * 60_000;

export type ChallengeCheck = "ok" | "invalid" | "expired";

export class WalletChallenges {
  readonly #key: Buffer;

  constructor(
    /** SESSION_SECRET when there is one; otherwise challenges last as long as the process. */
    secret: string | undefined,
    private readonly ttlMs = CHALLENGE_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {
    this.#key = secret
      ? createHmac("sha256", secret).update("poap/registration-challenge/v1").digest()
      : randomBytes(32);
  }

  issue(eventId: EventId, address: string): { challenge: string; expiresAt: string } {
    const expiresAt = this.now() + this.ttlMs;
    const body = `${eventId}.${address}.${expiresAt}.${randomBytes(12).toString("hex")}`;
    return { challenge: `${body}.${this.#mac(body)}`, expiresAt: new Date(expiresAt).toISOString() };
  }

  check(challenge: string, eventId: EventId, address: string): ChallengeCheck {
    // Read from both ends: the address in the middle may itself contain dots
    // (a NEAR account such as alice.near); the other four fields never do.
    const parts = challenge.split(".");
    if (parts.length < 5) return "invalid";
    const ev = parts[0]!;
    const mac = parts[parts.length - 1]!;
    const exp = parts[parts.length - 3]!;
    const addr = parts.slice(1, -3).join(".");
    const body = parts.slice(0, -1).join(".");
    const expected = Buffer.from(this.#mac(body));
    const given = Buffer.from(mac);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return "invalid";
    if (ev !== String(eventId) || addr !== address) return "invalid";
    if (!/^\d+$/.test(exp) || Number(exp) <= this.now()) return "expired";
    return "ok";
  }

  #mac(body: string): string {
    return createHmac("sha256", this.#key).update(body).digest("base64url");
  }
}
