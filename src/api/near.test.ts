/**
 * NEAR events, end to end through the HTTP routes, with the badge contract
 * simulated (test/helpers/mock-near-gateway.ts). Nothing touches a network.
 *
 * What these pin: an event's chain is chosen once; a NEAR event mints straight
 * to the attendee with no offer; every read that names an attendee accepts a
 * NEAR account for a NEAR event and nothing changes for an XRPL one.
 */
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ZodType } from "zod";
import { ed25519Wallet } from "../../test/helpers/ed25519-wallet.js";
import { MockGateway } from "../../test/helpers/mock-gateway.js";
import { MockNearGateway } from "../../test/helpers/mock-near-gateway.js";
import type { AppConfig } from "../config.js";
import type { InviteeRecord, InviteeRepository } from "../types.js";
import {
  MemoryAttendanceRepository,
  MemoryClaimRepository,
  MemoryEventRepository,
  MemoryRegistrationRepository,
} from "../db/memory.js";
import { registrationMessage } from "../xrpl/wallet-proof.js";
import type { ApiDeps, ChainOps } from "./deps.js";
import { registerErrorHandler } from "./http-errors.js";
import { registerDeskRoutes } from "./routes/desk.js";
import { registerInviteeRoutes } from "./routes/invitees.js";
import { registerEventRoutes } from "./routes/events.js";
import { buildServer, publicRpcUrl } from "./server.js";

const ISSUER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const XRPL_ATTENDEE = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const NEAR_EVENT = 9001;
const XRPL_EVENT = 9002;

function config(): AppConfig {
  return {
    endpoint: "wss://s.altnet.rippletest.net:51233",
    fallbackEndpoints: [],
    network: "testnet",
    issuerAddress: ISSUER,
    issuerSeed: "sEdV6Xn3bRq9J2wY4tK8mZpL1cH7dQa", // the same fake as server.test.ts
    reward: { maxPerAttendeeXrp: "10", feeBufferXrp: "0.01" },
    pinata: { gateway: "https://gateway.pinata.cloud" },
    xumm: {},
    demoEnabled: false,
    badgeImageUriMode: "https",
    badgeMetadataUriMode: "https",
    badgeBaseUrl: "https://poap.example",
    admin: { sessionTtlHours: 12 },
    api: { port: 0, host: "127.0.0.1", trustProxy: false, secureCookies: false },
  };
}

/** Any ledger operation reaching here is a NEAR path touching XRPL: fail loudly. */
const noLedger = new Proxy({} as ChainOps, {
  get: (_t, name) => () => {
    throw new Error(`a NEAR request reached the XRPL ledger (${String(name)})`);
  },
});

let near: MockNearGateway;
let events: MemoryEventRepository;
let attendance: MemoryAttendanceRepository;
let claims: MemoryClaimRepository;
let registrations: MemoryRegistrationRepository;

function deps(opts: { withNear?: boolean } = {}): ApiDeps {
  return {
    config: config(),
    gateway: new MockGateway({ issuerAddress: ISSUER }),
    attendance,
    claims,
    events,
    registrations,
    chain: noLedger,
    metadataUriForEvent: () => "https://poap.example/meta.json",
    rateLimit: { enabled: false },
    requireAdmin: () => undefined,
    ...(opts.withNear === false ? {} : { near }),
  };
}

function server(opts: { withNear?: boolean } = {}) {
  return buildServer(deps(opts));
}

/**
 * The event routes on their own, as src/api/registrations.test.ts mounts them:
 * buildServer answers 503 for the whole admin surface when no admin account is
 * configured, which is right and beside the point here.
 */
function adminServer(opts: { withNear?: boolean } = {}) {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(({ schema }) => (data) => {
    const result = (schema as ZodType).safeParse(data);
    return result.success ? { value: result.data } : { error: result.error };
  });
  registerErrorHandler(app);
  registerEventRoutes(app, deps(opts));
  return app;
}

beforeEach(async () => {
  near = new MockNearGateway();
  near.accounts.add("alice.testnet");
  attendance = new MemoryAttendanceRepository();
  claims = new MemoryClaimRepository();
  events = new MemoryEventRepository(attendance);
  registrations = new MemoryRegistrationRepository(events);
  await events.create({ eventId: NEAR_EVENT, name: "Make Waves", status: "live", chain: "near" });
  await events.create({ eventId: XRPL_EVENT, name: "Ledger Days", status: "live" });
});

describe("creating an event on a chain", () => {
  it("creates a NEAR event and publishes its chain", async () => {
    const app = adminServer();
    const res = await app.inject({
      method: "POST",
      url: "/admin/api/events",
      payload: { eventId: 77, name: "NEAR Night", chain: "near", status: "open" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().event.chain).toBe("near");

    const pub = await app.inject({ method: "GET", url: "/api/events/77" });
    expect(pub.json().chain ?? pub.json().event?.chain).toBe("near");
  });

  it("defaults to XRPL", async () => {
    const res = await adminServer().inject({ method: "POST", url: "/admin/api/events", payload: { eventId: 78, name: "Old Way" } });
    expect(res.json().event.chain).toBe("xrpl");
  });

  it("refuses a NEAR event on a server without NEAR", async () => {
    const res = await adminServer({ withNear: false }).inject({
      method: "POST",
      url: "/admin/api/events",
      payload: { eventId: 79, name: "Nope", chain: "near" },
    });
    expect(res.statusCode).toBe(503);
    expect(await events.find(79)).toBeNull();
  });

  it("refuses an XRP allowance on a NEAR event", async () => {
    const res = await adminServer().inject({
      method: "POST",
      url: "/admin/api/events",
      payload: { eventId: 80, name: "Paid", chain: "near", allowanceXrp: "2" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/XRP/);
  });

  it("refuses to move an event to another chain, and lets the same chain round-trip", async () => {
    const app = adminServer();
    const move = await app.inject({ method: "PATCH", url: `/admin/api/events/${XRPL_EVENT}`, payload: { chain: "near" } });
    expect(move.statusCode).toBe(400);
    expect(move.json().error.message).toMatch(/fixed when it is created/);

    const same = await app.inject({
      method: "PATCH",
      url: `/admin/api/events/${NEAR_EVENT}`,
      payload: { chain: "near", venue: "Toronto" },
    });
    expect(same.statusCode).toBe(200);
    expect((await events.find(NEAR_EVENT))?.chain).toBe("near");
  });
});

describe("issuing on NEAR", () => {
  it("mints straight to the attendee: no offer, no Xaman, attendance recorded", async () => {
    const res = await server().inject({
      method: "POST",
      url: `/events/${NEAR_EVENT}/claims`,
      payload: { address: "alice.testnet" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      chain: "near",
      tokenId: `${NEAR_EVENT}:alice.testnet`,
      txHash: near.signed[0]!.hash,
    });
    expect(res.json().accept).toBeUndefined();
    expect(await attendance.findByEventAndAddress(NEAR_EVENT, "alice.testnet")).not.toBeNull();
  });

  it("answers a second issue with 409 and the record, like XRPL", async () => {
    const app = server();
    await app.inject({ method: "POST", url: `/events/${NEAR_EVENT}/claims`, payload: { address: "alice.testnet" } });
    const again = await app.inject({ method: "POST", url: `/events/${NEAR_EVENT}/claims`, payload: { address: "alice.testnet" } });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("DUPLICATE_CLAIM");
  });

  it("refuses an account that does not exist", async () => {
    const res = await server().inject({
      method: "POST",
      url: `/events/${NEAR_EVENT}/claims`,
      payload: { address: "nobody.testnet" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("ACCOUNT_NOT_FOUND");
  });

  it("refuses an XRPL address on a NEAR event", async () => {
    const res = await server().inject({
      method: "POST",
      url: `/events/${NEAR_EVENT}/claims`,
      payload: { address: XRPL_ATTENDEE },
    });
    expect(res.statusCode).toBe(400);
  });

  it("refuses a NEAR account on an XRPL event exactly as before", async () => {
    const res = await server().inject({
      method: "POST",
      url: `/events/${XRPL_EVENT}/claims`,
      payload: { address: "alice.testnet" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({
      code: "BAD_REQUEST",
      details: { location: "body", issues: [{ path: "address", message: "Not a valid XRPL classic address" }] },
    });
  });

  it("reports the contract's refusal and frees the slot", async () => {
    near.failNextSend("Minting is paused");
    const res = await server().inject({
      method: "POST",
      url: `/events/${NEAR_EVENT}/claims`,
      payload: { address: "alice.testnet" },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.message).toMatch(/Minting is paused/);
    expect(await claims.find(NEAR_EVENT, "alice.testnet")).toBeNull();
  });
});

describe("reading a NEAR attendee", () => {
  beforeEach(async () => {
    await server().inject({ method: "POST", url: `/events/${NEAR_EVENT}/claims`, payload: { address: "alice.testnet" } });
  });

  it("finds their attendance", async () => {
    const res = await server().inject({ method: "GET", url: `/events/${NEAR_EVENT}/attendance/alice.testnet` });
    expect(res.statusCode).toBe(200);
    expect(res.json().record.nftokenId).toBe(`${NEAR_EVENT}:alice.testnet`);
  });

  it("has no offer waiting, ever", async () => {
    const res = await server().inject({ method: "GET", url: `/events/${NEAR_EVENT}/claims/for/alice.testnet` });
    expect(res.statusCode).toBe(404);
  });

  it("verifies from the contract's record, with no hash, burned or not", async () => {
    const app = server();
    const res = await app.inject({ method: "GET", url: `/verify?address=alice.testnet&eventId=${NEAR_EVENT}` });
    expect(res.json()).toMatchObject({ chain: "near", attended: true, status: "attended" });

    near.burn(NEAR_EVENT, "alice.testnet");
    const after = await app.inject({ method: "GET", url: `/verify?address=alice.testnet&eventId=${NEAR_EVENT}` });
    expect(after.json()).toMatchObject({ attended: true, status: "attended_badge_burned" });
  });

  it("still asks XRPL callers for a hash, exactly as before", async () => {
    const res = await server().inject({ method: "GET", url: `/verify?address=${XRPL_ATTENDEE}&eventId=${XRPL_EVENT}` });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.issues[0].path).toBe("txHash");
  });

  it("lists the event's roster from the contract", async () => {
    const res = await server().inject({ method: "GET", url: `/events/${NEAR_EVENT}/roster` });
    expect(res.json()).toMatchObject({
      chain: "near",
      issuer: near.contractId,
      minted: 1,
      claimed: 1,
      entries: [{ nftokenId: `${NEAR_EVENT}:alice.testnet`, owner: "alice.testnet" }],
    });
  });

  it("draws the badge for a NEAR account, labelled NEAR", async () => {
    const app = server();
    const svg = await app.inject({ method: "GET", url: `/badge/${NEAR_EVENT}/alice.testnet.svg` });
    expect(svg.statusCode).toBe(200);
    expect(svg.body).toContain(`NEAR · EVENT ${NEAR_EVENT}`);

    const json = await app.inject({ method: "GET", url: `/badge/${NEAR_EVENT}/alice.testnet.json` });
    expect(json.json().description).toContain("issued on NEAR");
  });

  it("still draws an XRPL badge as XRPL", async () => {
    const svg = await server().inject({ method: "GET", url: `/badge/${XRPL_EVENT}/${XRPL_ATTENDEE}.svg` });
    expect(svg.body).toContain(`XRPL · EVENT ${XRPL_EVENT}`);
  });
});

describe("the desk's lookup of a NEAR account", () => {
  function deskServer() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(({ schema }) => (data) => {
      const result = (schema as ZodType).safeParse(data);
      return result.success ? { value: result.data } : { error: result.error };
    });
    registerErrorHandler(app);
    registerDeskRoutes(app, deps());
    return app;
  }
  const lookup = (app: ReturnType<typeof deskServer>, address: string) =>
    app.inject({ method: "GET", url: `/admin/api/desk/attendees/${address}?eventId=${NEAR_EVENT}` });

  it("is ready before the mint, and names the badge after it", async () => {
    const desk = deskServer();
    const before = (await lookup(desk, "alice.testnet")).json();
    expect(before).toMatchObject({ chain: "near", valid: true, accountExists: true, attended: false, needsSponsorship: false });

    await server().inject({ method: "POST", url: `/events/${NEAR_EVENT}/claims`, payload: { address: "alice.testnet" } });

    const after = (await lookup(desk, "alice.testnet")).json();
    expect(after).toMatchObject({ attended: true, attendedTxHash: near.signed[0]!.hash });
    expect(after.claim.nftokenId).toBe(`${NEAR_EVENT}:alice.testnet`);
  });

  it("says when a named account does not exist", async () => {
    const res = (await lookup(deskServer(), "nobody.testnet")).json();
    expect(res).toMatchObject({ valid: true, accountExists: false, activated: false });
  });

  it("does not take an XRPL address for a NEAR event", async () => {
    const res = (await lookup(deskServer(), XRPL_ATTENDEE)).json();
    expect(res.valid).toBe(false);
  });
});

describe("the volunteer app's new wallet on a NEAR event", () => {
  /** Just enough of an invite list for these routes. */
  class FakeInvitees implements InviteeRepository {
    rows: InviteeRecord[] = [];
    async addMany(eventId: number, entries: Array<{ email: string; displayName?: string | null }>) {
      for (const e of entries) {
        this.rows.push({ id: String(this.rows.length + 1), eventId, email: e.email, displayName: e.displayName ?? null, address: null, walletSetAt: null, createdAt: new Date() } as InviteeRecord);
      }
      return entries.length;
    }
    async list(eventId: number) {
      return this.rows.filter((r) => r.eventId === eventId);
    }
    async find(eventId: number, email: string) {
      return this.rows.find((r) => r.eventId === eventId && r.email === email) ?? null;
    }
    async setAddress(eventId: number, email: string, address: string) {
      const row = await this.find(eventId, email);
      if (!row || row.address) return null;
      row.address = address;
      row.walletSetAt = new Date();
      return row;
    }
    async remove() {
      return false;
    }
  }

  let invitees: FakeInvitees;
  function inviteServer() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(({ schema }) => (data) => {
      const result = (schema as ZodType).safeParse(data);
      return result.success ? { value: result.data } : { error: result.error };
    });
    registerErrorHandler(app);
    registerInviteeRoutes(app, { ...deps(), invitees });
    return app;
  }
  const IMPLICIT = "98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6648cdf0dbd6de";

  beforeEach(async () => {
    invitees = new FakeInvitees();
    await invitees.addMany(NEAR_EVENT, [{ email: "ada@example.com", displayName: "Ada" }]);
    await invitees.addMany(XRPL_EVENT, [{ email: "ada@example.com", displayName: "Ada" }]);
  });

  it("saves the NEAR account, puts them on the list, and pays nothing", async () => {
    const res = await inviteServer().inject({
      method: "POST",
      url: `/admin/api/events/${NEAR_EVENT}/invitees/wallet`,
      payload: { email: "ada@example.com", address: IMPLICIT },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ invitee: { address: IMPLICIT }, payment: null, paymentError: null });
    expect((await registrations.findByAddress(NEAR_EVENT, IMPLICIT))?.displayName).toBe("Ada");
  });

  it("will not save an XRPL address against a NEAR event", async () => {
    const res = await inviteServer().inject({
      method: "POST",
      url: `/admin/api/events/${NEAR_EVENT}/invitees/wallet`,
      payload: { email: "ada@example.com", address: XRPL_ATTENDEE },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_ADDRESS");
  });

  it("refuses a NEAR account on an XRPL event exactly as before", async () => {
    const res = await inviteServer().inject({
      method: "POST",
      url: `/admin/api/events/${XRPL_EVENT}/invitees/wallet`,
      payload: { email: "ada@example.com", address: IMPLICIT },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({
      code: "BAD_REQUEST",
      details: { location: "body", issues: [{ path: "address", message: "Not a valid XRPL classic address" }] },
    });
  });
});

describe("XRPL events answer exactly as before NEAR", () => {
  const validationIssues = (body: { error: { details?: { issues?: Array<{ path: string; message: string }> } } }) =>
    body.error.details?.issues ?? [];

  it("gives garbage the old message, once", async () => {
    const res = await server().inject({ method: "POST", url: `/events/${XRPL_EVENT}/claims`, payload: { address: "Hello!" } });
    expect(res.statusCode).toBe(400);
    expect(validationIssues(res.json())).toEqual([{ path: "address", message: "Not a valid XRPL classic address" }]);
  });

  it("refuses a NEAR-shaped address before the desk guard runs", async () => {
    const requireAdmin = vi.fn(() => undefined);
    const app = buildServer({ ...deps(), requireAdmin });
    const res = await app.inject({ method: "POST", url: `/events/${XRPL_EVENT}/claims`, payload: { address: "hello" } });
    expect(res.statusCode).toBe(400);
    expect(validationIssues(res.json())).toEqual([{ path: "address", message: "Not a valid XRPL classic address" }]);
    expect(requireAdmin).not.toHaveBeenCalled();
  });

  it("reports every bad field of /verify, as it did", async () => {
    const res = await server().inject({ method: "GET", url: `/verify?address=Hello!&eventId=${XRPL_EVENT}&txHash=zz` });
    expect(res.statusCode).toBe(400);
    expect(validationIssues(res.json()).map((i) => i.path).sort()).toEqual(["address", "txHash"]);
  });

  it("draws no art for a NEAR-shaped address on an XRPL event", async () => {
    const res = await server().inject({ method: "GET", url: `/badge/${XRPL_EVENT}/hello.png` });
    expect(res.statusCode).toBe(400);
  });

  it("still draws a NEAR event's art for a NEAR account", async () => {
    const res = await server().inject({ method: "GET", url: `/badge/${NEAR_EVENT}/alice.testnet.png` });
    expect(res.statusCode).toBe(200);
  });

  it("answers a NEAR /verify for an account from the other network with a 400, not a 502", async () => {
    const res = await server().inject({ method: "GET", url: `/verify?address=alice.near&eventId=${NEAR_EVENT}` });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_ADDRESS");
  });
});

describe("health", () => {
  it("says which chains this server serves, and never the key", async () => {
    const res = await server().inject({ method: "GET", url: "/health" });
    expect(res.json()).toMatchObject({
      chains: ["xrpl", "near"],
      near: { network: "testnet", contractId: near.contractId },
    });
    expect(JSON.stringify(res.json())).not.toMatch(/ed25519:/);
  });

  it("never publishes an RPC URL that carries a key", () => {
    expect(publicRpcUrl("testnet", "https://rpc.example.com/?apiKey=secret")).toBe("https://rpc.testnet.fastnear.com");
    expect(publicRpcUrl("mainnet", "https://user:pw@rpc.example.com")).toBe("https://rpc.mainnet.fastnear.com");
    expect(publicRpcUrl("testnet", "https://rpc.example.com/near")).toBe("https://rpc.example.com/near");
  });

  it("is XRPL-only without NEAR", async () => {
    const res = await server({ withNear: false }).inject({ method: "GET", url: "/health" });
    expect(res.json().chains).toEqual(["xrpl"]);
    expect(res.json().near).toBeUndefined();
  });
});

describe("registering for a NEAR event", () => {
  it("registers the app's implicit account by signature (near_signature)", async () => {
    const app = server();
    const wallet = ed25519Wallet();
    const accountId = wallet.publicKey.slice(2).toLowerCase();

    const ch = await app.inject({
      method: "POST",
      url: `/api/events/${NEAR_EVENT}/registrations/challenge`,
      payload: { address: accountId },
    });
    expect(ch.statusCode).toBe(201);
    const { challenge } = ch.json();

    const message = registrationMessage({ eventId: NEAR_EVENT, address: accountId, displayName: "Priya", email: null, challenge });
    const res = await app.inject({
      method: "POST",
      url: `/api/events/${NEAR_EVENT}/registrations/wallet`,
      payload: { address: accountId, publicKey: wallet.publicKey, signature: wallet.sign(message), challenge, displayName: "Priya" },
    });
    expect(res.statusCode).toBe(201);
    expect((await registrations.findByAddress(NEAR_EVENT, accountId))?.addressProof).toBe("near_signature");
  });

  it("refuses a signature from another key", async () => {
    const app = server();
    const wallet = ed25519Wallet();
    const impostor = ed25519Wallet();
    const accountId = wallet.publicKey.slice(2).toLowerCase();
    const { challenge } = (
      await app.inject({ method: "POST", url: `/api/events/${NEAR_EVENT}/registrations/challenge`, payload: { address: accountId } })
    ).json();
    const message = registrationMessage({ eventId: NEAR_EVENT, address: accountId, displayName: "Priya", email: null, challenge });
    const res = await app.inject({
      method: "POST",
      url: `/api/events/${NEAR_EVENT}/registrations/wallet`,
      payload: { address: accountId, publicKey: impostor.publicKey, signature: impostor.sign(message), challenge, displayName: "Priya" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("offers no Xaman sign-in for a NEAR event", async () => {
    const res = await server().inject({ method: "POST", url: `/api/events/${NEAR_EVENT}/registrations/signin`, payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/on NEAR/);
  });

  it("takes a typed account on the website, after checking it exists", async () => {
    const app = server();
    const ok = await app.inject({
      method: "POST",
      url: `/api/events/${NEAR_EVENT}/registrations/near`,
      payload: { accountId: "alice.testnet", displayName: "Alice" },
    });
    expect(ok.statusCode).toBe(201);
    expect((await registrations.findByAddress(NEAR_EVENT, "alice.testnet"))?.addressProof).toBe("self_declared");

    const typo = await app.inject({
      method: "POST",
      url: `/api/events/${NEAR_EVENT}/registrations/near`,
      payload: { accountId: "alcie.testnet", displayName: "Alice" },
    });
    expect(typo.statusCode).toBe(400);
    expect(typo.json().error.message).toMatch(/no NEAR account called alcie.testnet/);
  });

  it("will not take a typed NEAR account for an XRPL event", async () => {
    const res = await server().inject({
      method: "POST",
      url: `/api/events/${XRPL_EVENT}/registrations/near`,
      payload: { accountId: "alice.testnet", displayName: "Alice" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("issues a challenge for a named account (its dots survive the round trip)", async () => {
    const res = await server().inject({
      method: "POST",
      url: `/api/events/${NEAR_EVENT}/registrations/challenge`,
      payload: { address: "alice.testnet" },
    });
    expect(res.statusCode).toBe(201);
  });
});
