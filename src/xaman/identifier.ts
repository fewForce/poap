/**
 * `custom_meta.identifier` on a Xaman payload.
 *
 * IT IS UNIQUE PER APPLICATION, FOR GOOD. Xaman indexes payloads by it — that
 * is what `GET /payload/ci/{identifier}` looks up — so a payload carrying one
 * the platform has seen before is refused outright:
 *
 *   400 · internal 409 · Duplicated custom payload identifier
 *       (options.custom_meta.identifier)
 *
 * A fixed identifier therefore works exactly once and then breaks the flow for
 * everybody afterwards. `poap-vendor` did: the first vendor who ever signed in
 * got a payload, and every vendor after that got a 400. The same was true of
 * `poap-reg-<eventId>` after the first attendee at an event, and of a claim or
 * an order whose payload was built a second time — a reload, or a desk
 * reopening a claim that is already waiting.
 *
 * So the identifier is a PREFIX plus something new each time. The prefix is
 * what we read back: the webhook recovery takes the event id out of it when
 * the blob is missing, and an operator reading Xaman's dashboard can tell what
 * a payload was for. The suffix is only there to make it unique.
 */
import { randomBytes } from "node:crypto";

/**
 * `prefix` with a random suffix, in the characters Xaman accepts for an
 * identifier ([A-Za-z0-9-_.]). Eight base64url characters is 48 bits: two
 * payloads colliding would need about 17 million of them before it was likely,
 * and a collision costs one refused payload, not a lost badge.
 */
export function payloadIdentifier(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString("base64url")}`;
}
