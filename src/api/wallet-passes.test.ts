/**
 * Apple Wallet passes end to end through the HTTP routes: registering makes
 * and emails one, Wallet's own web service, the desk scan that replaces the
 * code, the organiser's actions, and the event and the badge moving the pass
 * along. APNs and SMTP are fakes; nothing touches a network.
 */
import Fastify from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import { MockGateway } from "../../test/helpers/mock-gateway.js";
import { testPassCertificate, TEST_PASS_TYPE } from "../../test/helpers/pass-certificate.js";
import type { AppConfig } from "../config.js";
import {
  MemoryAttendanceRepository,
  MemoryClaimRepository,
  MemoryEventRepository,
  MemoryRegistrationRepository,
} from "../db/memory.js";
import { MemoryWalletPassRepository } from "../db/wallet-pass-repo.js";
import type { EventRecord, RegistrationRecord, RegistrationRepository } from "../types.js";
import type { ApnsGateway, ApnsResult } from "../wallet/apns.js";
import type { MailMessage, Mailer } from "../wallet/mailer.js";
import { loadPassAssets, passCode } from "../wallet/pass.js";
import { WalletPassService, withWalletPasses } from "../wallet/service.js";
import { passCertificateFromPem } from "../wallet/signing.js";
import { unzipStored } from "../wallet/zip.js";
import type { ApiDeps, ChainOps } from "./deps.js";
import { registerErrorHandler } from "./http-errors.js";
import { markArrival } from "./routes/claims.js";
import { registerWalletPassRoutes } from "./routes/wallet-passes.js";

const NEAR_EVENT = 9101;
const OTHER_EVENT = 9102;
const ACCOUNT = "d67f283fd3a5b2911ded6855cbb6307e74947cf2ce4ad3a3cb972cbb3e230ce5";
const DEVICE = "device-abc123";
const PUSH_TOKEN = "ab".repeat(32);

class FakeApns implements ApnsGateway {
  readonly pushed: string[] = [];
  async pushAll(tokens: string[]): Promise<Map<string, ApnsResult>> {
    this.pushed.push(...tokens);
    return new Map(tokens.map((t) => [t, { statusCode: 200, reason: null }]));
  }
}

class FakeMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  fail: string | null = null;
  async send(message: MailMessage): Promise<void> {
    if (this.fail) throw new Error(this.fail);
    this.sent.push(message);
  }
}

function config(): AppConfig {
  return {
    endpoint: "wss://s.altnet.rippletest.net:51233",
    fallbackEndpoints: [],
    network: "testnet",
    issuerAddress: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh",
    issuerSeed: "sEdV6Xn3bRq9J2wY4tK8mZpL1cH7dQa",
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

let repo: MemoryWalletPassRepository;
let events: MemoryEventRepository;
let attendance: MemoryAttendanceRepository;
let innerRegistrations: MemoryRegistrationRepository;
let registrations: RegistrationRepository;
let apns: FakeApns;
let mailer: FakeMailer;
let service: WalletPassService;
let deps: ApiDeps;

function makeService(publicUrl = "https://poap.example"): WalletPassService {
  const t = testPassCertificate();
  return new WalletPassService({
    repo,
    registrations: innerRegistrations,
    events,
    attendance,
    assets: { ...loadPassAssets(), wwdrPem: t.wwdrPem },
    certificate: passCertificateFromPem(t.certificatePem, t.encryptedKeyPem, t.passphrase),
    passTypeIdentifier: TEST_PASS_TYPE,
    teamIdentifier: "TEAM123456",
    publicUrl,
    apns,
    mailer,
  });
}

function app() {
  const a = Fastify({ logger: false });
  a.setValidatorCompiler(({ schema }) => (data) => {
    const result = (schema as ZodType).safeParse(data);
    return result.success ? { value: result.data } : { error: result.error };
  });
  registerErrorHandler(a);
  registerWalletPassRoutes(a, deps);
  return a;
}

function wire(publicUrl?: string) {
  service = makeService(publicUrl);
  registrations = withWalletPasses(innerRegistrations, service);
  deps = {
    config: config(),
    gateway: new MockGateway({ issuerAddress: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh" }),
    attendance,
    claims: new MemoryClaimRepository(),
    events,
    registrations,
    chain: {} as ChainOps,
    rateLimit: { enabled: false },
    requireAdmin: () => undefined,
    walletPasses: service,
  } as ApiDeps;
}

async function register(email: string | null = "ada@example.com", eventId = NEAR_EVENT): Promise<RegistrationRecord> {
  const r = await registrations.create({
    eventId,
    address: eventId === NEAR_EVENT ? ACCOUNT : `${ACCOUNT.slice(0, 63)}1`,
    addressProof: "near_signature",
    displayName: "Ada Lovelace",
    ...(email ? { email } : {}),
  });
  await service.idle();
  return r;
}

const auth = (token: string) => ({ authorization: `ApplePass ${token}` });

beforeEach(async () => {
  repo = new MemoryWalletPassRepository();
  attendance = new MemoryAttendanceRepository();
  events = new MemoryEventRepository(attendance);
  innerRegistrations = new MemoryRegistrationRepository(events);
  apns = new FakeApns();
  mailer = new FakeMailer();
  await events.create({ eventId: NEAR_EVENT, name: "NEAR Testnet Night", status: "live", chain: "near", venue: "Toronto" });
  await events.create({ eventId: OTHER_EVENT, name: "Other Night", status: "live", chain: "near" });
  wire();
});

describe("registering", () => {
  it("makes a pass and emails it, the .pkpass attached and a download link in the text", async () => {
    const reg = await register();
    const pass = await repo.findByRegistration(reg.id);
    expect(pass).toMatchObject({ status: "issued", deliveryError: null });
    expect(pass!.deliveredAt).toBeInstanceOf(Date);
    expect(mailer.sent).toHaveLength(1);
    const mail = mailer.sent[0]!;
    expect(mail.to).toBe("ada@example.com");
    expect(mail.text).toContain(`/api/wallet-passes/${pass!.serialNumber}/${pass!.downloadKey}/pass.pkpass`);
    const files = unzipStored(mail.attachments![0]!.content);
    const json = JSON.parse(files.get("pass.json")!.toString());
    expect(json.eventTicket.secondaryFields[0].value).toBe("Ada Lovelace");
    expect(json.barcodes[0].message).toBe(passCode(pass!.authenticationToken));
    expect(json.webServiceURL).toBe("https://poap.example/api/passes/");
    expect(files.has("signature")).toBe(true);
  });

  it("still makes a pass without an email, and sends nothing", async () => {
    const reg = await register(null);
    expect(await repo.findByRegistration(reg.id)).toMatchObject({ status: "pending" });
    expect(mailer.sent).toHaveLength(0);
  });

  it("writes a failed send on the pass, and the registration still stands", async () => {
    mailer.fail = "connection refused";
    const reg = await register();
    expect(await innerRegistrations.findById(reg.id)).not.toBeNull();
    expect(await repo.findByRegistration(reg.id)).toMatchObject({ status: "pending", deliveryError: "connection refused" });
  });

  it("answers with the registration exactly as the store does", async () => {
    const reg = await register();
    expect(Object.keys(reg).sort()).toEqual(Object.keys((await innerRegistrations.findById(reg.id))!).sort());
  });
});

describe("the download link", () => {
  it("serves the pass with its key, and nothing without it", async () => {
    const reg = await register(null);
    const pass = (await repo.findByRegistration(reg.id))!;
    const a = app();
    const ok = await a.inject({ method: "GET", url: `/api/wallet-passes/${pass.serialNumber}/${pass.downloadKey}/pass.pkpass` });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toBe("application/vnd.apple.pkpass");
    expect(unzipStored(ok.rawPayload).has("pass.json")).toBe(true);
    // Downloaded is delivered.
    expect((await repo.findById(pass.id))!.status).toBe("issued");
    const bad = await a.inject({ method: "GET", url: `/api/wallet-passes/${pass.serialNumber}/${"x".repeat(32)}/pass.pkpass` });
    expect(bad.statusCode).toBe(404);
  });
});

describe("Wallet's web service", () => {
  async function setup() {
    const reg = await register(null);
    const pass = (await repo.findByRegistration(reg.id))!;
    const base = `/api/passes/v1/devices/${DEVICE}/registrations/${TEST_PASS_TYPE}`;
    return { reg, pass, base, a: app() };
  }

  it("registers a phone with the pass's token, and refuses one without it", async () => {
    const { pass, base, a } = await setup();
    const url = `${base}/${pass.serialNumber}`;
    expect((await a.inject({ method: "POST", url, payload: { pushToken: PUSH_TOKEN } })).statusCode).toBe(401);
    expect((await a.inject({ method: "POST", url, headers: auth("wrong-token-wrong-token"), payload: { pushToken: PUSH_TOKEN } })).statusCode).toBe(401);
    expect((await a.inject({ method: "POST", url, headers: auth(pass.authenticationToken), payload: { pushToken: PUSH_TOKEN } })).statusCode).toBe(201);
    expect((await a.inject({ method: "POST", url, headers: auth(pass.authenticationToken), payload: { pushToken: PUSH_TOKEN } })).statusCode).toBe(200);
    const other = `/api/passes/v1/devices/${DEVICE}/registrations/pass.someone.else/${pass.serialNumber}`;
    expect((await a.inject({ method: "POST", url: other, headers: auth(pass.authenticationToken), payload: { pushToken: PUSH_TOKEN } })).statusCode).toBe(401);
  });

  it("lists what changed since the tag it gave, and sends the latest pass", async () => {
    const { pass, base, a } = await setup();
    await a.inject({ method: "POST", url: `${base}/${pass.serialNumber}`, headers: auth(pass.authenticationToken), payload: { pushToken: PUSH_TOKEN } });

    const first = await a.inject({ method: "GET", url: base });
    expect(first.statusCode).toBe(200);
    expect(first.json().serialNumbers).toEqual([pass.serialNumber]);
    const tag = first.json().lastUpdated as string;
    expect((await a.inject({ method: "GET", url: `${base}?passesUpdatedSince=${tag}` })).statusCode).toBe(204);

    const latest = await a.inject({ method: "GET", url: `/api/passes/v1/passes/${TEST_PASS_TYPE}/${pass.serialNumber}`, headers: auth(pass.authenticationToken) });
    expect(latest.statusCode).toBe(200);
    expect(latest.headers["last-modified"]).toBeTruthy();
    expect((await a.inject({ method: "GET", url: `/api/passes/v1/passes/${TEST_PASS_TYPE}/${pass.serialNumber}` })).statusCode).toBe(401);
  });

  it("forgets a phone, takes the device's log, and logs every call by its route", async () => {
    const { pass, base, a } = await setup();
    const url = `${base}/${pass.serialNumber}`;
    await a.inject({ method: "POST", url, headers: auth(pass.authenticationToken), payload: { pushToken: PUSH_TOKEN } });
    expect((await a.inject({ method: "DELETE", url, headers: auth(pass.authenticationToken) })).statusCode).toBe(200);
    expect((await a.inject({ method: "GET", url: base })).statusCode).toBe(204);
    expect((await a.inject({ method: "POST", url: "/api/passes/v1/log", payload: { logs: ["something odd"] } })).statusCode).toBe(200);
    await service.idle();
    expect(repo.apiLogs.length).toBeGreaterThanOrEqual(4);
    expect(repo.apiLogs.every((l) => !l.endpoint.includes(DEVICE))).toBe(true);
    expect(repo.apiLogs[0]).toMatchObject({ passId: pass.id, method: "POST", responseStatus: 201 });
  });
});

describe("the desk scans a pass", () => {
  async function onPhone() {
    const reg = await register(null);
    const pass = (await repo.findByRegistration(reg.id))!;
    await repo.registerDevice(pass.id, DEVICE, PUSH_TOKEN);
    return { reg, pass, a: app() };
  }
  const scan = (a: ReturnType<typeof app>, code: string, eventId = NEAR_EVENT) =>
    a.inject({ method: "POST", url: "/admin/api/desk/pass-scan", payload: { eventId, code } });

  it("gives the desk the registration, replaces the code and pushes the phone", async () => {
    const { reg, pass, a } = await onPhone();
    const res = await scan(a, passCode(pass.authenticationToken));
    expect(res.json()).toMatchObject({ valid: true, address: ACCOUNT, chain: "near", registration: { id: reg.id, displayName: "Ada Lovelace" } });
    await service.idle();
    const after = (await repo.findById(pass.id))!;
    expect(after.authenticationToken).not.toBe(pass.authenticationToken);
    expect(after.previousAuthenticationToken).toBe(pass.authenticationToken);
    expect(apns.pushed).toEqual([PUSH_TOKEN]);
    expect(repo.pushes[0]).toMatchObject({ event: "token_rotation", statusCode: 200 });
  });

  it("refuses the old code, while the phone can still fetch its new pass with it", async () => {
    const { pass, a } = await onPhone();
    await scan(a, passCode(pass.authenticationToken));
    const again = await scan(a, passCode(pass.authenticationToken));
    expect(again.json()).toMatchObject({ valid: false, result: "stale" });
    const fetched = await a.inject({ method: "GET", url: `/api/passes/v1/passes/${TEST_PASS_TYPE}/${pass.serialNumber}`, headers: auth(pass.authenticationToken) });
    expect(fetched.statusCode).toBe(200);
    const json = JSON.parse(unzipStored(fetched.rawPayload).get("pass.json")!.toString());
    expect(json.barcodes[0].message).toBe(passCode((await repo.findById(pass.id))!.authenticationToken));
  });

  it("refuses another event's pass, and anything that is not a pass", async () => {
    const { pass, a } = await onPhone();
    expect((await scan(a, passCode(pass.authenticationToken), OTHER_EVENT)).json()).toMatchObject({ valid: false, result: "other_event", eventId: NEAR_EVENT });
    expect((await scan(a, "POAP-PASS:not-a-real-token-at-all-0000")).json()).toMatchObject({ valid: false, result: "invalid" });
    expect((await scan(a, ACCOUNT)).json()).toMatchObject({ valid: false, result: "invalid" });
    await service.idle();
    expect(repo.scans.map((s) => s.result)).toEqual(["other_event", "invalid", "invalid"]);
    expect(repo.scans.every((s) => /^[0-9a-f]{64}$/.test(s.tokenHash))).toBe(true);
  });

  it("keeps the code when the pass cannot update: no phone on it, or no https web service", async () => {
    const reg = await register(null);
    const pass = (await repo.findByRegistration(reg.id))!;
    const a = app();
    expect((await scan(a, passCode(pass.authenticationToken))).json().valid).toBe(true);
    expect((await scan(a, passCode(pass.authenticationToken))).json().valid).toBe(true);

    wire("http://10.0.0.77:3077");
    await repo.registerDevice(pass.id, DEVICE, PUSH_TOKEN);
    const local = app();
    expect((await scan(local, passCode(pass.authenticationToken))).json().valid).toBe(true);
    expect((await scan(local, passCode(pass.authenticationToken))).json().valid).toBe(true);
    expect(service.capabilities.updates).toBe(false);
  });
});

describe("the organiser", () => {
  it("suspends, reinstates and revokes, pushing the phone each time; the desk refuses meanwhile", async () => {
    const reg = await register();
    const pass = (await repo.findByRegistration(reg.id))!;
    await repo.registerDevice(pass.id, DEVICE, PUSH_TOKEN);
    const a = app();
    const act = (action: string) => a.inject({ method: "POST", url: `/admin/api/registrations/${reg.id}/wallet-pass/${action}` });

    expect((await act("suspend")).json().pass.status).toBe("suspended");
    expect((await a.inject({ method: "POST", url: "/admin/api/desk/pass-scan", payload: { eventId: NEAR_EVENT, code: passCode(pass.authenticationToken) } })).json()).toMatchObject({ valid: false, result: "suspended" });
    expect((await act("reinstate")).json().pass.status).toBe("issued");
    expect((await act("revoke")).json().pass.status).toBe("revoked");
    await service.idle();
    expect(repo.pushes.map((p) => p.event)).toEqual(["suspension", "reinstatement", "revocation"]);

    const latest = await a.inject({ method: "GET", url: `/api/passes/v1/passes/${TEST_PASS_TYPE}/${pass.serialNumber}`, headers: auth(pass.authenticationToken) });
    expect(JSON.parse(unzipStored(latest.rawPayload).get("pass.json")!.toString()).voided).toBe(true);
  });

  it("lists the event's passes without their tokens, resends and downloads", async () => {
    const reg = await register();
    const a = app();
    const list = await a.inject({ method: "GET", url: `/admin/api/events/${NEAR_EVENT}/wallet-passes` });
    expect(list.json().capabilities).toEqual({ signed: true, email: true, updates: true });
    const row = list.json().passes[0];
    expect(row).toMatchObject({ registrationId: reg.id, status: "issued", devices: 0 });
    expect(JSON.stringify(list.json())).not.toMatch(/authenticationToken|downloadKey/);

    expect((await a.inject({ method: "POST", url: `/admin/api/registrations/${reg.id}/wallet-pass/send` })).json().sent).toBe(true);
    expect(mailer.sent).toHaveLength(2);
    const dl = await a.inject({ method: "GET", url: `/admin/api/registrations/${reg.id}/wallet-pass.pkpass` });
    expect(dl.headers["content-type"]).toBe("application/vnd.apple.pkpass");
    expect((await a.inject({ method: "POST", url: "/admin/api/registrations/99999/wallet-pass/send" })).statusCode).toBe(404);
  });
});

describe("the event and the badge move the pass along", () => {
  it("a new name updates every pass, and closing the event expires them", async () => {
    const reg = await register(null);
    const pass = (await repo.findByRegistration(reg.id))!;
    await repo.registerDevice(pass.id, DEVICE, PUSH_TOKEN);
    const before = (await events.find(NEAR_EVENT)) as EventRecord;
    const since = (await repo.findById(pass.id))!.updatedAt;

    service.onEventChanged(before, { ...before, name: "NEAR Night, renamed" });
    await service.idle();
    expect((await repo.updatedSerials(DEVICE, since))!.serialNumbers).toEqual([pass.serialNumber]);

    service.onEventChanged(before, { ...before, status: "closed" });
    await service.idle();
    expect((await repo.findById(pass.id))!.status).toBe("expired");
    expect(repo.pushes.map((p) => p.event)).toEqual(["event_update", "expiry"]);
  });

  it("an unchanged look pushes nothing", async () => {
    const reg = await register(null);
    const pass = (await repo.findByRegistration(reg.id))!;
    await repo.registerDevice(pass.id, DEVICE, PUSH_TOKEN);
    const before = (await events.find(NEAR_EVENT)) as EventRecord;
    service.onEventChanged(before, { ...before, metadataUri: "https://x.example/m.json" });
    await service.idle();
    expect(repo.pushes).toHaveLength(0);
  });

  it("the badge being recorded says Issued on the pass and pushes the phone", async () => {
    const reg = await register(null);
    const pass = (await repo.findByRegistration(reg.id))!;
    await repo.registerDevice(pass.id, DEVICE, PUSH_TOKEN);
    await attendance.insert({
      eventId: NEAR_EVENT,
      address: ACCOUNT,
      nftokenId: `${NEAR_EVENT}:${ACCOUNT}`,
      offerId: null,
      txHash: "MockTx".padEnd(44, "x"),
      ledgerIndex: 1000,
      claimedAt: new Date(),
    });
    await markArrival(deps, NEAR_EVENT, ACCOUNT, { warn: () => undefined } as never);
    await service.idle();
    expect(repo.pushes.map((p) => p.event)).toEqual(["badge_issued"]);
    const json = JSON.parse(unzipStored(await service.pkpass((await repo.findById(pass.id))!)).get("pass.json")!.toString());
    expect(json.eventTicket.headerFields[0]).toMatchObject({ label: "BADGE", value: "Issued" });
    expect((await innerRegistrations.findById(reg.id))!.checkedInAt).toBeInstanceOf(Date);
  });
});

describe("without a pass certificate", () => {
  it("has no pass routes", async () => {
    deps = { ...deps, walletPasses: undefined } as ApiDeps;
    expect((await app().inject({ method: "POST", url: "/api/passes/v1/log", payload: {} })).statusCode).toBe(404);
  });
});
