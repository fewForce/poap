/**
 * Registration: an attendee proves a wallet before the event, so the desk
 * already knows them when they walk in.
 *
 * A TYPED ADDRESS IS A CLAIM; ONLY A SIGNATURE IS PROOF. An address gets onto
 * a registration one of two ways, and both are proof that the registrant holds
 * its key:
 *
 *   - Xaman. The address is never taken from the request at all: it is read
 *     off a Xaman SignIn payload this server created and resolved against
 *     Xaman itself, and handed straight to the repository.
 *   - The wallet's own signature, for the POAP app, which keeps its key on the
 *     phone and has no Xaman to sign in with. The request names the address,
 *     and nothing is written until a signature by that address's key over a
 *     challenge this server issued checks out (src/xrpl/wallet-proof.ts).
 *
 * The difference from a typed address is not cosmetic:
 *
 *   - it stops someone registering a wallet that is not theirs;
 *   - it stops a typo. Badges are soulbound (CLAUDE.md) — minted with
 *     `tfTransferable` unset, they can never be moved — so a badge minted to a
 *     mistyped address is gone. There is no transfer, only a burn.
 *
 * Everything else in this file is bookkeeping around that one rule.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { XrplLayerError } from "../../errors.js";
import type { EventRecord, EventStatus, RegistrationRecord } from "../../types.js";
import {
  MemoryConsumedSignIns,
  NullSignInService,
  type ConsumedSignIns,
  type SignInService,
} from "../../xaman/signin.js";
import { isSignedByAddress, masterKeyCounts, registrationMessage } from "../../xrpl/wallet-proof.js";
import type { ApiDeps } from "../deps.js";
import {
  addressSchema,
  anyChainAddressSchema,
  eventIdParamsSchema,
  requireAddressForChain,
  sendError,
  type EventIdParams,
} from "../http-errors.js";
import { assertNearAccountId, isImplicitAccountId } from "../../near/account.js";
import { isSignedByImplicitAccount } from "../../near/wallet-proof.js";
import { WalletChallenges } from "../wallet-challenge.js";
import { toPublicEvent, type PublicEvent } from "./events.js";

/** Why a NEAR event has no Xaman sign-in. */
function nearNotXaman(eventId: number): string {
  return (
    `Event ${eventId} is on NEAR, so its badge goes to a NEAR account, not an XRPL wallet. ` +
    "Register with a NEAR account instead."
  );
}

/**
 * Statuses that accept a new registration.
 *
 * `live` is in the list because a walk-up who was never on the roster is the
 * exact person this flow is for — the desk still needs a proven address for
 * them. `draft` and `closed` are not: a draft is not public at all, and a
 * closed event has nothing left to register for.
 */
const REGISTRABLE_STATUSES: readonly EventStatus[] = ["open", "live"];

/**
 * Creating a sign-in payload calls Xaman, on a public, unauthenticated route.
 * Ten a minute per IP is generous for a person filling in a form and cheap
 * insurance for our side of somebody else's rate limit.
 */
const SIGNIN_CREATE_RATE_LIMIT = { max: 10, timeWindow: "1 minute" } as const;

/**
 * The registration page polls this while the attendee finds their phone. Wide
 * enough for a poll every two seconds for the whole of a payload's life,
 * narrow enough that it is not a free proxy onto the Xaman API.
 */
const SIGNIN_POLL_RATE_LIMIT = { max: 120, timeWindow: "1 minute" } as const;

/** Also resolves a payload against Xaman, and also writes a row. */
const REGISTER_RATE_LIMIT = { max: 10, timeWindow: "1 minute" } as const;

/** Long enough for "Ada Lovelace (Analytical Engines Ltd)", short enough for a badge list. */
const MAX_DISPLAY_NAME = 120;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const returnUrlSchema = z.object({
  app: z.string().url().optional(),
  web: z.string().url().optional(),
});

/** `.nullish()`: a POST with nothing to say is the normal case here. */
const signInBodySchema = z.object({ returnUrl: returnUrlSchema.optional() }).nullish();

const signInUuidParamsSchema = z.object({ uuid: z.uuid() });

/**
 * Note what is NOT here: `address`.
 *
 * Unknown keys are stripped rather than rejected, so a caller that sends one
 * gets a successful registration of the address they actually proved — not a
 * 400 that invites them to try again with better-formed lying. The route's
 * preValidation hook logs that it saw one and ignored it.
 */
const registerBodySchema = z.object({
  /** The payload THIS server created. Its resolution is the only source of the address. */
  signinUuid: z.uuid(),
  /**
   * A name is required; an email is not.
   *
   * Neither is needed to MINT anything — the wallet is the whole of what a
   * badge depends on, and nothing in the claim or verify path reads either.
   * The name is required because the EVENT needs it: a door cannot be run off
   * a list of wallet addresses.
   *
   * The email was mandatory for one release (migration 008) and is optional
   * again as of 009. Asking for it costs registrations at a door, and the
   * badge does not depend on reaching anyone afterwards.
   */
  displayName: z.string().trim().min(1).max(MAX_DISPLAY_NAME),
  email: z.email().max(254).optional(),
});

/**
 * The wallet-signature route names its address — and proves it, see the
 * handler. An XRPL address, or a NEAR account id for a NEAR event.
 */
const challengeBodySchema = z.object({ address: anyChainAddressSchema });

/** The XRPL body, exactly as it always was. Re-run in full for XRPL events. */
const xrplWalletRegisterBodySchema = z.object({
  address: addressSchema,
  /** 33 bytes: an ed25519 key (0xED…) or a compressed secp256k1 one. */
  publicKey: z.string().regex(/^[0-9A-Fa-f]{66}$/),
  /** 64 bytes for ed25519; a DER secp256k1 signature is about 71. */
  signature: z.string().regex(/^[0-9A-Fa-f]{64,200}$/),
  challenge: z.string().min(20).max(300),
  displayName: z.string().trim().min(1).max(MAX_DISPLAY_NAME),
  email: z.email().max(254).optional(),
});

/**
 * Loose enough for both chains. For a NEAR implicit account the key may come
 * bare (64 hex) or in XRPL's ED-prefixed spelling; the signature is ed25519.
 */
const walletRegisterBodySchema = xrplWalletRegisterBodySchema.extend({
  address: anyChainAddressSchema,
  publicKey: z.string().regex(/^(?:[0-9A-Fa-f]{2})?[0-9A-Fa-f]{64}$/),
});

/** A NEAR event, registered from the website by typing the account. */
const nearRegisterBodySchema = z.object({
  accountId: anyChainAddressSchema,
  displayName: z.string().trim().min(1).max(MAX_DISPLAY_NAME),
  email: z.email().max(254).optional(),
});

const registrationIdParamsSchema = z.object({ id: z.string().min(1).max(64) });

type SignInBody = z.infer<typeof signInBodySchema>;
type SignInUuidParams = z.infer<typeof signInUuidParamsSchema>;
type RegisterBody = z.infer<typeof registerBodySchema>;
type ChallengeBody = z.infer<typeof challengeBodySchema>;
type WalletRegisterBody = z.infer<typeof walletRegisterBodySchema>;
type NearRegisterBody = z.infer<typeof nearRegisterBodySchema>;
type RegistrationIdParams = z.infer<typeof registrationIdParamsSchema>;

// ---------------------------------------------------------------------------
// What an attendee is shown
// ---------------------------------------------------------------------------

/**
 * The attendee-facing view of a registration.
 *
 * No email — they typed it, we do not need to read it back to them, and this
 * view is reachable by anyone holding the id. No `signinPayloadUuid`: it is a
 * one-shot credential, and echoing it would put a spent-but-replayable value in
 * a page and a browser history. No `addressProof`, no timestamps beyond the two
 * that mean something to a person.
 */
export interface RegistrationView {
  id: string;
  event: PublicEvent | null;
  address: string;
  displayName: string | null;
  registeredAt: Date | null;
  checkedInAt: Date | null;
}

export function toRegistrationView(
  registration: RegistrationRecord,
  event: EventRecord | null,
): RegistrationView {
  return {
    id: registration.id,
    event: event ? toPublicEvent(event) : null,
    address: registration.address,
    displayName: registration.displayName ?? null,
    registeredAt: registration.registeredAt ?? null,
    checkedInAt: registration.checkedInAt ?? null,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerRegistrationRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const events = deps.events;
  const registrations = deps.registrations;
  // Same rule as the event routes: no store, no routes. A 404 that says the
  // feature is not wired beats a 500 on every call.
  if (!events || !registrations) return;

  /**
   * Absent keys are a supported mode for the server as a whole — it must boot
   * and serve claims, verification and the roster without Xaman — so the
   * fallback is the Null service, which fails loudly on use and only on use.
   */
  const signIn: SignInService = deps.signIn ?? new NullSignInService();

  /**
   * One ticket book per server instance. See ConsumedSignIns: a signed payload
   * answers `signed: true` forever, so the uuid has to be spent exactly once.
   */
  const consumed: ConsumedSignIns = new MemoryConsumedSignIns();

  /** Stateless, so a challenge outlives a restart — see WalletChallenges. */
  const challenges = new WalletChallenges(deps.config.admin.sessionSecret);

  const limits = deps.rateLimit;
  const rateLimitsOff = limits?.enabled === false;
  const signinCreateLimit = rateLimitsOff ? false : (limits?.signin ?? SIGNIN_CREATE_RATE_LIMIT);
  const signinPollLimit = rateLimitsOff ? false : (limits?.signinPoll ?? SIGNIN_POLL_RATE_LIMIT);
  const registerLimit = rateLimitsOff ? false : (limits?.registration ?? REGISTER_RATE_LIMIT);

  /** The event, if it is one a stranger may register for. */
  const findRegistrableEvent = async (eventId: number): Promise<EventRecord | null> => {
    const event = await events.find(eventId);
    if (!event || !REGISTRABLE_STATUSES.includes(event.status)) return null;
    return event;
  };

  /**
   * POST /api/events/:eventId/registrations/signin — start the proof.
   *
   * Creates a Xaman SignIn payload and hands back the QR code, the deeplink and
   * the websocket. Costs the attendee nothing: a SignIn is not a transaction.
   *
   * 201 payload created | 400 bad input | 404 no such open event
   * 429 rate limited | 500 Xaman is not configured | 502 Xaman is unreachable
   */
  app.post<{ Params: EventIdParams; Body: SignInBody }>(
    "/api/events/:eventId/registrations/signin",
    {
      schema: { params: eventIdParamsSchema, body: signInBodySchema },
      config: { rateLimit: signinCreateLimit },
    },
    async (request, reply) => {
      const { eventId } = request.params;

      const event = await findRegistrableEvent(eventId);
      if (!event) {
        return sendError(
          reply,
          404,
          "NOT_FOUND",
          `No event ${eventId} is open for registration.`,
          { eventId },
        );
      }
      // Xaman proves an XRPL wallet, which a NEAR event cannot issue to.
      if (event.chain === "near") {
        return sendError(reply, 400, "INVALID_INPUT", nearNotXaman(eventId), { eventId });
      }

      const returnUrl = request.body?.returnUrl;
      const handles = await signIn.create({
        eventId,
        ...(returnUrl && (returnUrl.app || returnUrl.web) ? { returnUrl } : {}),
      });

      request.log.info({ eventId, uuid: handles.uuid }, "sign-in payload created for registration");

      return reply.code(201).send(handles);
    },
  );

  /**
   * GET /api/registrations/signin/:uuid — has it been signed yet?
   *
   * The page polls this until `signed` or `rejected`. `address` appears only on
   * a signed payload, and only after the service has validated it — see
   * XummSignInService.resolve(). The uuid is a 128-bit value known only to the
   * browser that asked for it, and it is the whole authorisation for this read.
   *
   * 200 status | 400 not a uuid | 404 no such payload | 429 | 500 not configured
   */
  app.get<{ Params: SignInUuidParams }>(
    "/api/registrations/signin/:uuid",
    { schema: { params: signInUuidParamsSchema }, config: { rateLimit: signinPollLimit } },
    async (request, reply) => {
      const { uuid } = request.params;
      const resolution = await signIn.resolve(uuid);

      return reply.code(200).send({
        uuid,
        resolved: resolution.resolved,
        signed: resolution.signed,
        rejected: resolution.rejected,
        // Present only when signed. There is no branch of resolve() that
        // returns an address without a signature behind it.
        ...(resolution.account ? { address: resolution.account } : {}),
      });
    },
  );

  /**
   * POST /api/events/:eventId/registrations — finish the proof, store the row.
   *
   * 201 registered | 400 unsigned, rejected or malformed | 404 no such open event
   * 409 the sign-in was already used, or this address is already registered
   * 429 | 500 Xaman is not configured | 502 Xaman is unreachable
   */
  app.post<{ Params: EventIdParams; Body: RegisterBody }>(
    "/api/events/:eventId/registrations",
    {
      schema: { params: eventIdParamsSchema, body: registerBodySchema },
      config: { rateLimit: registerLimit },
      // Runs BEFORE validation, so it sees the body as it was sent. Nothing it
      // finds changes the outcome; it exists so that an integration quietly
      // sending an address leaves a trace instead of appearing to work.
      preValidation: async (request) => {
        const raw = request.body;
        if (raw && typeof raw === "object" && "address" in raw) {
          request.log.warn(
            { url: request.url },
            "ignoring an address in the registration body: the address comes from the resolved " +
              "Xaman sign-in and nowhere else",
          );
        }
      },
    },
    async (request, reply) => {
      const { eventId } = request.params;
      const { signinUuid, displayName, email } = request.body;

      const event = await findRegistrableEvent(eventId);
      if (!event) {
        return sendError(
          reply,
          404,
          "NOT_FOUND",
          `No event ${eventId} is open for registration.`,
          { eventId },
        );
      }
      if (event.chain === "near") {
        return sendError(reply, 400, "INVALID_INPUT", nearNotXaman(eventId), { eventId });
      }

      // 1. THE ONLY SOURCE OF THE ADDRESS. Resolved server-side against Xaman;
      //    the request body cannot influence what comes back beyond naming
      //    which payload to look up.
      const resolution = await signIn.resolve(signinUuid);

      if (!resolution.signed || !resolution.account) {
        return sendError(
          reply,
          400,
          "INVALID_INPUT",
          resolution.rejected
            ? "That Xaman sign-in was declined or expired. Start a new one and approve it in Xaman."
            : "That Xaman sign-in has not been signed yet. Approve it in Xaman, then submit again.",
          { signinUuid, resolved: resolution.resolved, rejected: resolution.rejected },
        );
      }

      const address = resolution.account;

      // 2. REPLAY. A signed payload stays signed, so Xaman will keep answering
      //    `signed: true` for this uuid forever. One registration per proof.
      if (!(await consumed.claim(signinUuid))) {
        return sendError(
          reply,
          409,
          "DUPLICATE_CLAIM",
          "That Xaman sign-in has already been used to register. Start a new sign-in.",
          { eventId, signinUuid },
        );
      }

      try {
        const existing = await registrations.findByAddress(eventId, address);
        if (existing) {
          // The durable half of the replay guard: the same uuid coming back
          // after a restart, when the in-process ticket book has forgotten it.
          if (existing.signinPayloadUuid === signinUuid) {
            return sendError(
              reply,
              409,
              "DUPLICATE_CLAIM",
              "That Xaman sign-in has already been used to register. Start a new sign-in.",
              { eventId, signinUuid },
            );
          }

          // Not an error worth a 500 and not a lie worth a 200: re-registering
          // is a normal thing a person does when they lose the confirmation
          // link. Hand back the row they already have.
          return reply.code(409).send({
            error: {
              code: "DUPLICATE_CLAIM",
              message: `${address} is already registered for event ${eventId}.`,
            },
            registration: toRegistrationView(existing, event),
          });
        }

        const created = await registrations.create({
          eventId,
          address,
          // The whole point of the flow. Never "self_declared" on this route —
          // there is no path through it that has not been through Xaman.
          addressProof: "xaman_signin",
          signinPayloadUuid: signinUuid,
          ...(displayName === undefined ? {} : { displayName }),
          ...(email === undefined ? {} : { email }),
        });

        request.log.info(
          { eventId, address, registrationId: created.id },
          "registration created from a verified Xaman sign-in",
        );

        return reply.code(201).send({ registration: toRegistrationView(created, event) });
      } catch (err) {
        // Lost a race against a concurrent registration for the same address:
        // the unique index did the job this route was trying to do.
        if (err instanceof XrplLayerError && err.code === "DUPLICATE_CLAIM") {
          const existing = await registrations.findByAddress(eventId, address);
          if (existing) {
            return reply.code(409).send({
              error: {
                code: "DUPLICATE_CLAIM",
                message: `${address} is already registered for event ${eventId}.`,
              },
              registration: toRegistrationView(existing, event),
            });
          }
        }

        // Nothing was written, so the proof was not spent. Hand the uuid back
        // rather than making someone sign again for our failure.
        await consumed.release(signinUuid);
        throw err;
      }
    },
  );

  /**
   * POST /api/events/:eventId/registrations/challenge — what to sign.
   *
   * The first half of registering with the wallet's own key, for the POAP app.
   * Bound to this event and this address, good for ten minutes. Costs nothing
   * and stores nothing.
   *
   * 201 {challenge, expiresAt} | 400 bad address | 404 no such open event | 429
   */
  app.post<{ Params: EventIdParams; Body: ChallengeBody }>(
    "/api/events/:eventId/registrations/challenge",
    {
      schema: { params: eventIdParamsSchema, body: challengeBodySchema },
      config: { rateLimit: signinCreateLimit },
    },
    async (request, reply) => {
      const { eventId } = request.params;
      const event = await findRegistrableEvent(eventId);
      if (!event) {
        return sendError(reply, 404, "NOT_FOUND", `No event ${eventId} is open for registration.`, { eventId });
      }
      requireAddressForChain(event.chain, request.body.address, "body");
      if (event.chain === "near") {
        if (!deps.near) {
          return sendError(reply, 503, "SERVICE_UNAVAILABLE", "NEAR is not set up on this server.", { eventId });
        }
        assertNearAccountId(request.body.address, deps.near.network);
      }
      return reply.code(201).send(challenges.issue(eventId, request.body.address));
    },
  );

  /**
   * POST /api/events/:eventId/registrations/wallet — register with a signature.
   *
   * The body names the address, and that is only a claim until three things
   * hold: the challenge is one this server issued for this event and address
   * and it has not expired; the signature, over the text registrationMessage()
   * rebuilds from the body, is by that address's key; and the account has not
   * disabled that key. Then — and only then — the row is written.
   *
   * 201 registered | 400 bad body, challenge or signature | 404 no such open event
   * 409 this address is already registered | 429 | 502 the ledger could not be read
   */
  app.post<{ Params: EventIdParams; Body: WalletRegisterBody }>(
    "/api/events/:eventId/registrations/wallet",
    {
      schema: { params: eventIdParamsSchema, body: walletRegisterBodySchema },
      config: { rateLimit: registerLimit },
    },
    async (request, reply) => {
      const { eventId } = request.params;
      const { address, publicKey, signature, challenge, displayName, email } = request.body;

      const event = await findRegistrableEvent(eventId);
      if (!event) {
        return sendError(reply, 404, "NOT_FOUND", `No event ${eventId} is open for registration.`, { eventId });
      }
      const near = event.chain === "near";
      if (!near) {
        // XRPL: exactly the checks this route always made, errors included.
        const parsed = xrplWalletRegisterBodySchema.safeParse(request.body);
        if (!parsed.success) {
          (parsed.error as { validationContext?: string }).validationContext = "body";
          throw parsed.error;
        }
      } else if (!deps.near) {
        return sendError(reply, 503, "SERVICE_UNAVAILABLE", "NEAR is not set up on this server.", { eventId });
      } else if (!isImplicitAccountId(address)) {
        return sendError(
          reply,
          400,
          "INVALID_INPUT",
          "Signing to register needs a NEAR implicit account (64 hex characters), whose id is its key. " +
            "A named account registers on the event's web page instead.",
          { reason: "not_implicit" },
        );
      }

      const fresh = challenges.check(challenge, eventId, address);
      if (fresh !== "ok") {
        return sendError(
          reply,
          400,
          "INVALID_INPUT",
          fresh === "expired"
            ? "That challenge has expired. Ask for a new one and sign again."
            : "That challenge was not issued for this wallet and event.",
          { reason: fresh === "expired" ? "challenge_expired" : "challenge_invalid" },
        );
      }

      const message = registrationMessage({ eventId, address, displayName, email: email ?? null, challenge });
      const signed = near
        ? isSignedByImplicitAccount({ accountId: address, publicKey, signature, message })
        : isSignedByAddress({ address, publicKey, signature, message });
      if (!signed) {
        return sendError(reply, 400, "INVALID_INPUT", "That signature is not from this wallet's key.", {
          reason: "bad_signature",
        });
      }

      // NEAR: the implicit account's id is its key, checked just above. There
      // is no master-key flag to consult.
      if (!near && !(await masterKeyCounts(deps.gateway, address))) {
        return sendError(
          reply,
          400,
          "INVALID_INPUT",
          "This wallet has disabled its master key, so a signature from it proves nothing. Register with Xaman instead.",
          { reason: "master_key_disabled" },
        );
      }

      const already = (existing: RegistrationRecord) =>
        reply.code(409).send({
          error: { code: "DUPLICATE_CLAIM", message: `${address} is already registered for event ${eventId}.` },
          registration: toRegistrationView(existing, event),
        });

      const existing = await registrations.findByAddress(eventId, address);
      if (existing) return already(existing);

      try {
        const created = await registrations.create({
          eventId,
          address,
          addressProof: near ? "near_signature" : "wallet_signature",
          displayName,
          ...(email === undefined ? {} : { email }),
        });
        request.log.info(
          { eventId, address, registrationId: created.id },
          "registration created from a verified wallet signature",
        );
        return reply.code(201).send({ registration: toRegistrationView(created, event) });
      } catch (err) {
        // Lost a race against a concurrent registration for the same address.
        if (err instanceof XrplLayerError && err.code === "DUPLICATE_CLAIM") {
          const raced = await registrations.findByAddress(eventId, address);
          if (raced) return already(raced);
        }
        throw err;
      }
    },
  );

  /**
   * POST /api/events/:eventId/registrations/near — a NEAR event, from the website.
   *
   * The attendee types their NEAR account. Nothing proves they hold it, so the
   * row says so (self_declared), as for a typed XRPL address. What it does
   * check: that the account is the protocol's shape, on this server's NEAR
   * network, and, for a named account, that it exists — a typo would otherwise
   * be minted to, forever, at the door. Signing in with a NEAR wallet here is
   * the follow-up (docs/near-chain.md).
   *
   * 201 registered | 400 not a NEAR account, or not a NEAR event | 404 no such
   * open event | 409 already registered | 429 | 503 NEAR not set up
   */
  app.post<{ Params: EventIdParams; Body: NearRegisterBody }>(
    "/api/events/:eventId/registrations/near",
    {
      schema: { params: eventIdParamsSchema, body: nearRegisterBodySchema },
      config: { rateLimit: registerLimit },
    },
    async (request, reply) => {
      const { eventId } = request.params;
      const { accountId, displayName, email } = request.body;

      const event = await findRegistrableEvent(eventId);
      if (!event) {
        return sendError(reply, 404, "NOT_FOUND", `No event ${eventId} is open for registration.`, { eventId });
      }
      if (event.chain !== "near") {
        return sendError(reply, 400, "INVALID_INPUT", `Event ${eventId} is not a NEAR event.`, { eventId });
      }
      if (!deps.near) {
        return sendError(reply, 503, "SERVICE_UNAVAILABLE", "NEAR is not set up on this server.", { eventId });
      }
      assertNearAccountId(accountId, deps.near.network);
      if (!isImplicitAccountId(accountId) && !(await deps.near.accountExists(accountId))) {
        return sendError(
          reply,
          400,
          "INVALID_ADDRESS",
          `There is no NEAR account called ${accountId} on ${deps.near.network}. Check the spelling.`,
          { accountId },
        );
      }

      const already = (existing: RegistrationRecord) =>
        reply.code(409).send({
          error: { code: "DUPLICATE_CLAIM", message: `${accountId} is already registered for event ${eventId}.` },
          registration: toRegistrationView(existing, event),
        });

      const existing = await registrations.findByAddress(eventId, accountId);
      if (existing) return already(existing);

      try {
        const created = await registrations.create({
          eventId,
          address: accountId,
          addressProof: "self_declared",
          displayName,
          ...(email === undefined ? {} : { email }),
        });
        request.log.info({ eventId, address: accountId, registrationId: created.id }, "NEAR registration created");
        return reply.code(201).send({ registration: toRegistrationView(created, event) });
      } catch (err) {
        if (err instanceof XrplLayerError && err.code === "DUPLICATE_CLAIM") {
          const raced = await registrations.findByAddress(eventId, accountId);
          if (raced) return already(raced);
        }
        throw err;
      }
    },
  );

  /**
   * GET /api/registrations/:id — the attendee's own confirmation view.
   *
   * 200 | 404
   */
  app.get<{ Params: RegistrationIdParams }>(
    "/api/registrations/:id",
    { schema: { params: registrationIdParamsSchema } },
    async (request, reply) => {
      const { id } = request.params;

      const registration = await registrations.findById(id);
      if (!registration) {
        return sendError(reply, 404, "NOT_FOUND", "No such registration.", { id });
      }

      const event = await events.find(registration.eventId);
      return reply.code(200).send({ registration: toRegistrationView(registration, event) });
    },
  );
}
