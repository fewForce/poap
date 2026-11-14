/**
 * A NEAR event's id is chosen by the server, never typed.
 *
 * Every NEAR event, on every server pointed at the same contract, shares the
 * contract's one `event_id` space. Two events with one id share one attendee
 * list, and an attendee of the first could never get a badge for the second:
 * the contract keeps one record per event and account. A typed id invites
 * exactly that, the more so when a staging server and a laptop share the
 * testnet contract.
 *
 * So the id is drawn at random from nine digits and kept only when neither
 * this server's events nor the contract know it. The contract names an event
 * (`event_title`) from its first badge on, whichever server minted it.
 *
 * Nine digits: short enough to read out, and far below the ids
 * scripts/04-near-testnet-e2e.ts mints under (1.9 billion up).
 */
import { randomInt } from "node:crypto";
import { XrplLayerError } from "../errors.js";
import type { EventId, EventRepository, NearGateway } from "../types.js";

export const NEAR_EVENT_ID_MIN = 100_000_000;
export const NEAR_EVENT_ID_MAX = 999_999_999;
/** Ids in use are a vanishing share of 900 million: more than a few misses means something else is wrong. */
export const NEAR_EVENT_ID_ATTEMPTS = 8;

function drawNearEventId(): EventId {
  return randomInt(NEAR_EVENT_ID_MIN, NEAR_EVENT_ID_MAX + 1);
}

/** Whether the contract has ever minted a badge under this event id. */
export async function nearEventIdUsed(near: NearGateway, eventId: EventId): Promise<boolean> {
  return (await near.view<string | null>("event_title", { event_id: eventId })) !== null;
}

/**
 * An event id that no event on this server has and the contract has never
 * minted under. Throws `ConnectionError` when the contract cannot be read:
 * an id that was not checked is not handed out.
 */
export async function pickNearEventId(
  deps: { near: NearGateway; events: Pick<EventRepository, "find"> },
  draw: () => EventId = drawNearEventId,
): Promise<EventId> {
  for (let i = 0; i < NEAR_EVENT_ID_ATTEMPTS; i++) {
    const eventId = draw();
    if (await deps.events.find(eventId)) continue;
    if (await nearEventIdUsed(deps.near, eventId)) continue;
    return eventId;
  }
  throw new XrplLayerError(
    "CONFLICT",
    `Could not find an unused NEAR event id in ${NEAR_EVENT_ID_ATTEMPTS} tries. Try again.`,
    { attempts: NEAR_EVENT_ID_ATTEMPTS },
  );
}
