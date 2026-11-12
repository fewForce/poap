/**
 * GET /events/:eventId/roster — the chain read (brief 6.1).
 *
 * `nfts_by_issuer` with the event's taxon is the single most useful query in
 * the system and also the most expensive: it is a Clio call that walks every
 * badge ever minted for the event, against a public server with no SLA.
 *
 * This is the deliberately expensive path. It is for organiser tooling,
 * reconciliation and "is the index lying to me?" — not for page loads. The
 * cheap read is GET /events/:eventId/attendance (brief 6.5).
 *
 * WHICH ISSUER. The event's own, when it has one recorded; the server's
 * configured issuer otherwise. Asking the configured one for every event was
 * silently wrong the moment an issuer was rotated: every past event answered
 * zero minted, zero claimed, zero burned, because its badges belong to an
 * account nobody was asking about. The answer names the issuer it asked.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { nearRoster } from "../../near/badges.js";
import type { EventId, NearGateway, Roster, RosterEntry } from "../../types.js";
import type { ApiDeps } from "../deps.js";
import { eventIdParamsSchema, sendError, type EventIdParams } from "../http-errors.js";

const rosterQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(400).optional(),
});

type RosterParams = EventIdParams;
type RosterQuery = z.infer<typeof rosterQuerySchema>;

export function registerRosterRoute(app: FastifyInstance, deps: ApiDeps): void {
  /**
   * GET /events/:eventId/roster?limit=
   *
   * 200 with every badge for the event, minted/claimed/burned counts and the
   * ledger's marker when the response was paginated.
   * 400 bad params | 502 ledger trouble
   */
  app.get<{ Params: RosterParams; Querystring: RosterQuery }>(
    "/events/:eventId/roster",
    { schema: { params: eventIdParamsSchema, querystring: rosterQuerySchema } },
    async (request, reply) => {
      const { eventId } = request.params;
      const { limit } = request.query;

      const event = deps.events ? await deps.events.find(eventId) : null;
      if (event?.chain === "near") {
        if (!deps.near) {
          return sendError(reply, 503, "SERVICE_UNAVAILABLE", "NEAR is not set up on this server.", {
            eventId,
          });
        }
        return reply.code(200).send(await nearRosterOf(deps.near, eventId, limit));
      }
      const issuerAddress = event?.issuerAddress ?? undefined;

      const roster = await deps.chain.getRoster(deps.gateway, eventId, {
        ...(limit === undefined ? {} : { limit }),
        ...(issuerAddress === undefined ? {} : { issuerAddress }),
      });

      return reply.code(200).send(roster);
    },
  );
}

/**
 * The same shape as an XRPL roster, read from the badge contract's attendance
 * records. Every NEAR badge was minted straight to its holder, so every entry
 * is claimed; a burned one stays on the roster, because attendance stands.
 */
async function nearRosterOf(near: NearGateway, eventId: EventId, limit?: number): Promise<Roster> {
  const records = await nearRoster(near, eventId, limit === undefined ? {} : { max: limit });
  const entries: RosterEntry[] = records.map((r, i) => ({
    nftokenId: r.tokenId,
    owner: r.accountId,
    isBurned: r.burnedAt !== null,
    taxon: eventId,
    serial: i + 1,
    claimed: true,
  }));
  return {
    eventId,
    chain: "near",
    issuer: near.contractId,
    entries,
    minted: entries.length,
    claimed: entries.length,
    burned: entries.filter((e) => e.isBurned).length,
    ownerUnknown: 0,
  };
}
