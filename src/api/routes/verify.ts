/**
 * GET /verify — re-derive attendance from the chain, on demand (brief 6.4).
 *
 * The counterpart to GET /events/:eventId/attendance: that one reads the index,
 * this one reads the ledger. Anything that needs to be *sure* asks here.
 *
 * NEAR events are verified differently, and the query shows it: no hash is
 * needed. The badge contract keeps an attendance record per (event, account)
 * that a burn does not remove, and that record is the answer. A transaction
 * lookup would not do: an ordinary NEAR node forgets transactions after a few
 * epochs, while the record stays in contract state.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { nearAttendance } from "../../near/badges.js";
import type { ApiDeps } from "../deps.js";
import { addressSchema, anyChainAddressSchema, eventIdSchema, sendError, txHashSchema } from "../http-errors.js";

/** The XRPL query, exactly as it always was. Re-run in full for XRPL events. */
const xrplVerifyQuerySchema = z.object({
  address: addressSchema,
  eventId: eventIdSchema,
  /** The attendee's NFTokenAcceptOffer hash. This hash *is* the attendance record. */
  txHash: txHashSchema,
});

/** Loose enough for both; the chain's own rules are applied in the handler. */
const verifyQuerySchema = z.object({
  address: anyChainAddressSchema,
  eventId: eventIdSchema,
  txHash: z.string().max(100).optional(),
});

type VerifyQuery = z.infer<typeof verifyQuerySchema>;

export function registerVerifyRoute(app: FastifyInstance, deps: ApiDeps): void {
  /**
   * GET /verify?address=&eventId=&txHash=
   *
   * 200 always when the query is well formed — including `attended: false`.
   * A failed verification is an answer, not an error.
   * 400 bad query | 502 ledger trouble
   */
  app.get<{ Querystring: VerifyQuery }>(
    "/verify",
    { schema: { querystring: verifyQuerySchema } },
    async (request, reply) => {
      const event = deps.events ? await deps.events.find(request.query.eventId) : null;

      if (event?.chain === "near") {
        const { address, eventId } = request.query;
        if (!deps.near) {
          return sendError(reply, 503, "SERVICE_UNAVAILABLE", "NEAR is not set up on this server.", {
            eventId,
          });
        }
        const record = await nearAttendance(deps.near, eventId, address);
        const indexed = await deps.attendance.findByEventAndAddress(eventId, address);
        return reply.code(200).send({
          chain: "near",
          address,
          eventId,
          attended: record !== null,
          status: record === null ? "not_attended" : record.burnedAt ? "attended_badge_burned" : "attended",
          ...(record
            ? {
                tokenId: record.tokenId,
                blockHeight: record.blockHeight,
                mintedAt: record.mintedAt.toISOString(),
                burnedAt: record.burnedAt ? record.burnedAt.toISOString() : null,
                contractId: deps.near.contractId,
              }
            : {}),
          ...(indexed ? { txHash: indexed.txHash } : {}),
        });
      }

      const parsed = xrplVerifyQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        (parsed.error as { validationContext?: string }).validationContext = "querystring";
        throw parsed.error;
      }
      const { address, eventId, txHash } = parsed.data;

      // Attendance is an event, not a state. verifyClaim() answers "did this
      // wallet ever accept a badge we issued with this taxon", never "does it
      // hold one now", so a burned badge still returns attended: true with
      // status "attended_badge_burned".
      const result = await deps.chain.verifyClaim(deps.gateway, { address, eventId, txHash });

      // The whole result goes out, per-check breakdown included — plus
      // `degraded` (issuer and taxon decoded from the NFTokenID because the
      // endpoint has no Clio, so burn status is unknown rather than false) and
      // `nftokenIdSource`. A caller auditing a verdict needs to know how it was
      // reached, so nothing here is summarised away.
      return reply.code(200).send({ address, eventId, txHash, ...result });
    },
  );
}
