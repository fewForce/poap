/**
 * Apple Wallet passes over HTTP (src/wallet, docs/wallet-passes.md).
 *
 *   /api/passes/v1/…                        Apple's web service: what Wallet calls on its own
 *   GET  /api/wallet-passes/:serial/:key/pass.pkpass     the download link from the email
 *   GET  /admin/api/events/:eventId/wallet-passes        the console's list
 *   POST /admin/api/registrations/:id/wallet-pass/send   make and email it (again)
 *   GET  /admin/api/registrations/:id/wallet-pass.pkpass the organiser downloads it
 *   POST /admin/api/registrations/:id/wallet-pass/:action  revoke | suspend | reinstate
 *   POST /admin/api/desk/pass-scan                       the desk scanned a pass
 *
 * The web service follows Apple's spec as tessera found it on real phones
 * (tessera docs/02-verification-api.md): Wallet inserts "v1/" after the
 * webServiceURL, and logs to a single global /v1/log.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { PKPASS_CONTENT_TYPE } from "../../wallet/pass.js";
import type { WalletPassService } from "../../wallet/service.js";
import type { ApiDeps } from "../deps.js";
import { eventIdSchema, sendError } from "../http-errors.js";
import { adminGuard } from "./events.js";

const deviceParams = z.object({
  deviceLibraryIdentifier: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  passTypeIdentifier: z.string().min(1).max(200),
});
const passParams = deviceParams.extend({ serialNumber: z.string().uuid() });
const latestParams = z.object({ passTypeIdentifier: z.string().min(1).max(200), serialNumber: z.string().uuid() });
const registerBody = z.object({ pushToken: z.string().regex(/^[0-9a-fA-F]{8,200}$/) });
const serialsQuery = z.object({ passesUpdatedSince: z.string().max(40).optional() });
const logBody = z.object({ logs: z.array(z.string().max(2000)).max(50).default([]) }).partial();
const downloadParams = z.object({ serialNumber: z.string().uuid(), downloadKey: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/) });
const registrationParams = z.object({ id: z.string().regex(/^\d{1,18}$/) });
const actionParams = registrationParams.extend({ action: z.enum(["revoke", "suspend", "reinstate"]) });
const deskScanBody = z.object({ eventId: eventIdSchema, code: z.string().min(1).max(300) });

/** What tells Wallet "nothing changed": an opaque tag it hands back, here milliseconds since 1970. */
function sinceTag(raw: string | undefined): Date | null {
  if (!raw) return null;
  const ms = /^\d{1,16}$/.test(raw) ? Number(raw) : Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

function sendPkpass(reply: FastifyReply, bytes: Buffer, updatedAt: Date): FastifyReply {
  return reply
    .code(200)
    .header("content-type", PKPASS_CONTENT_TYPE)
    .header("content-disposition", 'attachment; filename="pass.pkpass"')
    .header("last-modified", updatedAt.toUTCString())
    .header("cache-control", "no-store")
    .send(bytes);
}

/** The pass's view for the console: never the token or the download key. */
function passView(passes: WalletPassService, p: Awaited<ReturnType<WalletPassService["findBySerial"]>>, devices: number) {
  if (!p) return null;
  return {
    registrationId: p.registrationId,
    serialNumber: p.serialNumber,
    status: p.status,
    issuedAt: p.issuedAt,
    deliveredAt: p.deliveredAt,
    deliveryError: p.deliveryError,
    suspendedAt: p.suspendedAt,
    revokedAt: p.revokedAt,
    expiredAt: p.expiredAt,
    updatedAt: p.updatedAt,
    devices,
    capabilities: passes.capabilities,
  };
}

export function registerWalletPassRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const passes = deps.walletPasses;
  if (!passes) return;
  const requireAdmin = adminGuard(deps);

  // ---- Apple's web service ---------------------------------------------------
  app.register(async (scope) => {
    // Every call Wallet makes, logged after the answer. The route's pattern,
    // not its URL: the URL carries the device id and serial.
    scope.addHook("onResponse", async (request: FastifyRequest, reply: FastifyReply) => {
      passes.logApi({
        passId: (request as FastifyRequest & { walletPassId?: string }).walletPassId ?? null,
        method: request.method,
        endpoint: request.routeOptions.url ?? request.url.split("?")[0] ?? "",
        responseStatus: reply.statusCode,
        timingMs: Math.round(reply.elapsedTime),
        ipAddress: request.ip ?? null,
      });
    });

    const authed = async (request: FastifyRequest, passTypeIdentifier: string, serialNumber: string) => {
      const pass = await passes.authenticate(passTypeIdentifier, serialNumber, request.headers.authorization);
      if (pass) (request as FastifyRequest & { walletPassId?: string }).walletPassId = pass.id;
      return pass;
    };

    scope.post<{ Params: z.infer<typeof passParams>; Body: z.infer<typeof registerBody> }>(
      "/api/passes/v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier/:serialNumber",
      { schema: { params: passParams, body: registerBody } },
      async (request, reply) => {
        const { deviceLibraryIdentifier, passTypeIdentifier, serialNumber } = request.params;
        const pass = await authed(request, passTypeIdentifier, serialNumber);
        if (!pass) return reply.code(401).send();
        const outcome = await passes.registerDevice(pass, deviceLibraryIdentifier, request.body.pushToken);
        return reply.code(outcome === "created" ? 201 : 200).send();
      },
    );

    scope.delete<{ Params: z.infer<typeof passParams> }>(
      "/api/passes/v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier/:serialNumber",
      { schema: { params: passParams } },
      async (request, reply) => {
        const { deviceLibraryIdentifier, passTypeIdentifier, serialNumber } = request.params;
        const pass = await authed(request, passTypeIdentifier, serialNumber);
        if (!pass) return reply.code(401).send();
        await passes.unregisterDevice(pass, deviceLibraryIdentifier);
        return reply.code(200).send();
      },
    );

    // Which of this device's passes changed. No pass token: the device id is the key, as Apple specifies.
    scope.get<{ Params: z.infer<typeof deviceParams>; Querystring: z.infer<typeof serialsQuery> }>(
      "/api/passes/v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier",
      { schema: { params: deviceParams, querystring: serialsQuery } },
      async (request, reply) => {
        const { deviceLibraryIdentifier, passTypeIdentifier } = request.params;
        const changed = await passes.updatedSerials(deviceLibraryIdentifier, passTypeIdentifier, sinceTag(request.query.passesUpdatedSince));
        if (!changed) return reply.code(204).send();
        return reply.code(200).send({ lastUpdated: String(changed.lastUpdated.getTime()), serialNumbers: changed.serialNumbers });
      },
    );

    // The latest pass. Revoked and expired passes are sent too, voided: iOS
    // ignores a 410 these days (tessera docs/04-pass-revocation.md).
    scope.get<{ Params: z.infer<typeof latestParams> }>(
      "/api/passes/v1/passes/:passTypeIdentifier/:serialNumber",
      { schema: { params: latestParams } },
      async (request, reply) => {
        const pass = await authed(request, request.params.passTypeIdentifier, request.params.serialNumber);
        if (!pass) return reply.code(401).send();
        return sendPkpass(reply, await passes.pkpass(pass), pass.updatedAt);
      },
    );

    scope.post<{ Body: z.infer<typeof logBody> }>("/api/passes/v1/log", { schema: { body: logBody } }, async (request, reply) => {
      for (const line of request.body?.logs ?? []) request.log.info({ walletDevice: line.slice(0, 500) }, "Wallet reported");
      return reply.code(200).send();
    });
  });

  // ---- the download link -----------------------------------------------------
  app.get<{ Params: z.infer<typeof downloadParams> }>(
    "/api/wallet-passes/:serialNumber/:downloadKey/pass.pkpass",
    { schema: { params: downloadParams } },
    async (request, reply) => {
      const pass = await passes.findBySerial(request.params.serialNumber);
      if (!pass || pass.downloadKey !== request.params.downloadKey) {
        return sendError(reply, 404, "NOT_FOUND", "There is no such pass.");
      }
      const { pass: current, bytes } = await passes.download(pass);
      return sendPkpass(reply, bytes, current.updatedAt);
    },
  );

  // ---- the console -----------------------------------------------------------
  const registrationOr404 = async (id: string, reply: FastifyReply) => {
    const registration = deps.registrations ? await deps.registrations.findById(id) : null;
    if (!registration) {
      sendError(reply, 404, "NOT_FOUND", `There is no registration ${id}.`);
      return null;
    }
    return registration;
  };

  app.get<{ Params: { eventId: number } }>(
    "/admin/api/events/:eventId/wallet-passes",
    { schema: { params: z.object({ eventId: eventIdSchema }) }, preHandler: requireAdmin },
    async (request, reply) => {
      const list = await passes.listByEvent(request.params.eventId);
      const rows = await Promise.all(list.map(async (p) => passView(passes, p, (await passes.devicesFor(p)).length)));
      return reply.code(200).send({ capabilities: passes.capabilities, passes: rows });
    },
  );

  app.post<{ Params: z.infer<typeof registrationParams> }>(
    "/admin/api/registrations/:id/wallet-pass/send",
    { schema: { params: registrationParams }, preHandler: requireAdmin },
    async (request, reply) => {
      const registration = await registrationOr404(request.params.id, reply);
      if (!registration) return reply;
      const pass = await passes.ensurePass(registration);
      const outcome = await passes.deliver(pass);
      const view = passView(passes, outcome.pass, (await passes.devicesFor(outcome.pass)).length);
      if (!outcome.sent) return sendError(reply, 502, "SERVICE_UNAVAILABLE", outcome.error ?? "The email was not sent.", { pass: view });
      return reply.code(200).send({ sent: true, pass: view });
    },
  );

  app.get<{ Params: z.infer<typeof registrationParams> }>(
    "/admin/api/registrations/:id/wallet-pass.pkpass",
    { schema: { params: registrationParams }, preHandler: requireAdmin },
    async (request, reply) => {
      const registration = await registrationOr404(request.params.id, reply);
      if (!registration) return reply;
      const { pass, bytes } = await passes.download(await passes.ensurePass(registration));
      return sendPkpass(reply, bytes, pass.updatedAt);
    },
  );

  app.post<{ Params: z.infer<typeof actionParams> }>(
    "/admin/api/registrations/:id/wallet-pass/:action",
    { schema: { params: actionParams }, preHandler: requireAdmin },
    async (request, reply) => {
      const pass = await passes.findByRegistration(request.params.id);
      if (!pass) return sendError(reply, 404, "NOT_FOUND", "This registration has no wallet pass yet.");
      const updated =
        request.params.action === "revoke"
          ? await passes.revoke(pass)
          : request.params.action === "suspend"
            ? await passes.suspend(pass)
            : await passes.reinstate(pass);
      return reply.code(200).send({ pass: passView(passes, updated, (await passes.devicesFor(updated)).length) });
    },
  );

  // ---- the desk --------------------------------------------------------------
  app.post<{ Body: z.infer<typeof deskScanBody> }>(
    "/admin/api/desk/pass-scan",
    { schema: { body: deskScanBody }, preHandler: requireAdmin },
    async (request, reply) => {
      const scan = await passes.scanAtDesk(request.body.code, request.body.eventId, request.ip ?? null);
      if (!scan.ok) {
        return reply.code(200).send({ valid: false, result: scan.result, message: scan.message, ...(scan.eventId !== undefined ? { eventId: scan.eventId } : {}) });
      }
      return reply.code(200).send({
        valid: true,
        result: "valid",
        eventId: scan.event.eventId,
        chain: scan.event.chain ?? "xrpl",
        address: scan.registration.address,
        registration: { id: scan.registration.id, displayName: scan.registration.displayName ?? null, addressProof: scan.registration.addressProof },
        pass: { serialNumber: scan.pass.serialNumber, status: scan.pass.status },
      });
    },
  );
}
