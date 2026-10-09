/**
 * The invite list, and the two calls the volunteer app makes at the door.
 *
 *   GET    /admin/api/events/:eventId/invitees               the list
 *   POST   /admin/api/events/:eventId/invitees               add emails (one per line, "email, name")
 *   DELETE /admin/api/events/:eventId/invitees/:email        take one off
 *   GET    /admin/api/events/:eventId/invitees/check?email=  is this email invited?
 *   POST   /admin/api/events/:eventId/invitees/wallet        save a new wallet against an email,
 *                                                            register it, fund it from the treasury
 *
 * All behind the desk login, like the rest of /admin/api. The volunteer app
 * signs in with the same email and password the desk uses.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { XrplLayerError } from "../../errors.js";
import { payAllowanceFor } from "../allowance.js";
import type { ApiDeps } from "../deps.js";
import { addressSchema, eventIdParamsSchema, eventIdSchema, sendError, type EventIdParams } from "../http-errors.js";
import { adminGuard } from "./events.js";

const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));

const addBodySchema = z.object({
  /** One invitee per line: `email` or `email, name`. */
  text: z.string().max(200_000),
});
const checkQuerySchema = z.object({ email: emailSchema });
const walletBodySchema = z.object({ email: emailSchema, address: addressSchema });
const emailParamsSchema = z.object({ eventId: eventIdSchema, email: emailSchema });

function parseLines(text: string): { entries: Array<{ email: string; displayName: string | null }>; rejected: string[] } {
  const entries: Array<{ email: string; displayName: string | null }> = [];
  const rejected: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const [first, ...rest] = line.split(/[,;\t]/);
    const parsed = emailSchema.safeParse(first ?? "");
    if (!parsed.success) {
      rejected.push(line);
      continue;
    }
    entries.push({ email: parsed.data, displayName: rest.join(" ").trim() || null });
  }
  return { entries, rejected };
}

export function registerInviteeRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const invitees = deps.invitees;
  const events = deps.events;
  if (!invitees || !events) return;
  const guard = adminGuard(deps);

  const eventOr404 = async (eventId: number) => events.find(eventId);

  app.get<{ Params: EventIdParams }>(
    "/admin/api/events/:eventId/invitees",
    { schema: { params: eventIdParamsSchema }, preHandler: guard },
    async (request, reply) => {
      const { eventId } = request.params;
      if (!(await eventOr404(eventId))) return sendError(reply, 404, "NOT_FOUND", `No event ${eventId}.`, { eventId });
      return reply.code(200).send({ eventId, invitees: await invitees.list(eventId) });
    },
  );

  app.post<{ Params: EventIdParams; Body: z.infer<typeof addBodySchema> }>(
    "/admin/api/events/:eventId/invitees",
    { schema: { params: eventIdParamsSchema, body: addBodySchema }, preHandler: guard },
    async (request, reply) => {
      const { eventId } = request.params;
      if (!(await eventOr404(eventId))) return sendError(reply, 404, "NOT_FOUND", `No event ${eventId}.`, { eventId });
      const { entries, rejected } = parseLines(request.body.text);
      const added = await invitees.addMany(eventId, entries);
      request.log.info({ eventId, added, rejected: rejected.length }, "invitees added");
      return reply.code(200).send({ added, alreadyListed: entries.length - added, rejected });
    },
  );

  app.delete<{ Params: z.infer<typeof emailParamsSchema> }>(
    "/admin/api/events/:eventId/invitees/:email",
    { schema: { params: emailParamsSchema }, preHandler: guard },
    async (request, reply) => {
      const { eventId, email } = request.params;
      const removed = await invitees.remove(eventId, email);
      return removed ? reply.code(200).send({ removed: true }) : sendError(reply, 404, "NOT_FOUND", "Not on the list.");
    },
  );

  app.get<{ Params: EventIdParams; Querystring: z.infer<typeof checkQuerySchema> }>(
    "/admin/api/events/:eventId/invitees/check",
    { schema: { params: eventIdParamsSchema, querystring: checkQuerySchema }, preHandler: guard },
    async (request, reply) => {
      const { eventId } = request.params;
      const invitee = await invitees.find(eventId, request.query.email);
      return reply.code(200).send({ invited: invitee !== null, invitee });
    },
  );

  app.post<{ Params: EventIdParams; Body: z.infer<typeof walletBodySchema> }>(
    "/admin/api/events/:eventId/invitees/wallet",
    { schema: { params: eventIdParamsSchema, body: walletBodySchema }, preHandler: guard },
    async (request, reply) => {
      const { eventId } = request.params;
      const { email, address } = request.body;

      const event = await eventOr404(eventId);
      if (!event) return sendError(reply, 404, "NOT_FOUND", `No event ${eventId}.`, { eventId });

      const invitee = await invitees.find(eventId, email);
      if (!invitee) {
        return sendError(reply, 404, "NOT_FOUND", `${email} is not on the list for ${event.name}.`, { reason: "not_invited" });
      }
      if (invitee.address) {
        return sendError(reply, 409, "CONFLICT", `${email} already has a wallet (${invitee.address}).`, {
          reason: "has_wallet",
          address: invitee.address,
        });
      }

      const saved = await invitees.setAddress(eventId, email, address);
      if (!saved) {
        return sendError(reply, 409, "CONFLICT", `${email} already has a wallet.`, { reason: "has_wallet" });
      }

      // On the event's list too, so the desk and the console show the name.
      if (deps.registrations) {
        try {
          const existing = await deps.registrations.findByAddress(eventId, address);
          if (!existing) {
            await deps.registrations.create({
              eventId,
              address,
              addressProof: "self_declared",
              displayName: saved.displayName ?? email.split("@")[0] ?? email,
              email,
            });
          }
        } catch (err) {
          if (!(err instanceof XrplLayerError && err.code === "DUPLICATE_CLAIM")) throw err;
        }
      }

      // The new wallet's XRP, from the event's own treasury: what it needs to
      // hold a badge plus the event's allowance (1.21 + allowance).
      let payment: unknown = null;
      let paymentError: string | null = null;
      try {
        payment = await payAllowanceFor(deps, { eventId, address });
      } catch (err) {
        paymentError = err instanceof Error ? err.message : "The treasury payment did not go through.";
        request.log.warn({ eventId, address, err: paymentError }, "volunteer wallet saved but not funded");
      }

      request.log.info({ eventId, email, address }, "volunteer app saved a wallet against an invitee");
      return reply.code(200).send({ invitee: saved, payment, paymentError });
    },
  );
}
