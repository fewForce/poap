/**
 * GET /events/:eventId/attendance — the local index (brief 6.5).
 *
 * "Never read attendance from the chain on a page load. Read from this table,
 * and expose a separate verify endpoint that re-derives from the chain on
 * demand." That separate endpoint is GET /verify; this one never touches the
 * ledger and never calls the gateway.
 *
 * The ledger stays the source of truth. This is the index.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiDeps } from "../deps.js";
import { addressSchema, eventIdParamsSchema, eventIdSchema, sendError, type EventIdParams } from "../http-errors.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const attendanceQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
});

type AttendanceParams = EventIdParams;
type AttendanceQuery = z.infer<typeof attendanceQuerySchema>;

const oneAttendeeParamsSchema = z.object({ eventId: eventIdSchema, address: addressSchema });
type OneAttendeeParams = z.infer<typeof oneAttendeeParamsSchema>;

export function registerAttendanceRoute(app: FastifyInstance, deps: ApiDeps): void {
  /**
   * GET /events/:eventId/attendance?limit=&offset=
   *
   * 200 with the page | 400 bad params
   */
  app.get<{ Params: AttendanceParams; Querystring: AttendanceQuery }>(
    "/events/:eventId/attendance",
    { schema: { params: eventIdParamsSchema, querystring: attendanceQuerySchema } },
    async (request, reply) => {
      const { eventId } = request.params;
      const { limit, offset } = request.query;

      const [records, total] = await Promise.all([
        deps.attendance.listByEvent(eventId, { limit, offset }),
        deps.attendance.countByEvent(eventId),
      ]);

      return reply.code(200).send({ eventId, total, limit, offset, records });
    },
  );

  /**
   * GET /events/:eventId/attendance/:address — has THIS wallet attended?
   *
   * The attendee's pass asks this on every load. Without it the pass had no
   * public way to learn that somebody already holds their badge: the list above
   * pages two hundred at a time, /verify needs the transaction hash the pass no
   * longer has, and the desk's lookup is not mounted in production. So a person
   * who had collected their badge opened their pass and was asked to collect it
   * again.
   *
   * Public, like the list it is one row of. Index only — no ledger call.
   *
   * 200 { record } | 404 not recorded for this event | 400 bad params
   */
  app.get<{ Params: OneAttendeeParams }>(
    "/events/:eventId/attendance/:address",
    { schema: { params: oneAttendeeParamsSchema } },
    async (request, reply) => {
      const { eventId, address } = request.params;
      const record = await deps.attendance.findByEventAndAddress(eventId, address);
      if (!record) {
        return sendError(reply, 404, "NOT_FOUND", "No attendance is recorded for this wallet at this event.", {
          eventId,
          address,
        });
      }
      return reply.code(200).send({ eventId, record });
    },
  );
}
