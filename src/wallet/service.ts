/**
 * Apple Wallet passes for registrations: tessera's card holders, with a
 * poap registration as the holder and its event as the card.
 *
 *   registering         a pass is made and, when there is an email and SMTP, emailed
 *   the desk scans it   the QR's token is checked, then replaced; the phone is pushed
 *   the badge lands     the pass says "Issued"; the phone is pushed
 *   the event changes   name, date, place: every pass of it is pushed
 *   the event closes    its passes expire (voided on the phone)
 *   the organiser       revokes, suspends, reinstates, resends
 *
 * A push only tells the phone to ask; the phone then calls the web service
 * (src/api/routes/wallet-passes.ts) for the new pass. Pushes and emails run
 * after the request that caused them has answered, and never fail it: a lost
 * push is caught up the next time Wallet polls.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  AttendanceRepository,
  EventId,
  EventRecord,
  EventRepository,
  RegistrationRecord,
  RegistrationRepository,
  WalletPassRecord,
  WalletPassRepository,
  WalletPassScanResult,
  WalletPushEvent,
} from "../types.js";
import type { ApnsGateway } from "./apns.js";
import { passEmail, type Mailer } from "./mailer.js";
import {
  buildPkpass,
  DEFAULT_PASS_STYLE,
  tokenFromPassCode,
  type PassAssets,
  type PassContent,
  type PassIdentity,
  type PassStyle,
} from "./pass.js";
import type { PassCertificate } from "./signing.js";

export interface WalletPassLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface WalletPassServiceDeps {
  repo: WalletPassRepository;
  registrations: RegistrationRepository;
  events: EventRepository;
  attendance: AttendanceRepository;
  assets: PassAssets;
  /** Absent only in tests: Wallet refuses an unsigned pass. */
  certificate?: PassCertificate;
  passTypeIdentifier: string;
  teamIdentifier: string;
  /** Where this server is reached, e.g. https://poap.live. Download links, and the web service when https. */
  publicUrl: string;
  apns?: ApnsGateway;
  mailer?: Mailer;
  style?: PassStyle;
  log?: WalletPassLogger;
}

export type DeskScan =
  | { ok: true; pass: WalletPassRecord; registration: RegistrationRecord; event: EventRecord }
  | { ok: false; result: WalletPassScanResult; message: string; eventId?: EventId };

const ACTIVE: ReadonlySet<WalletPassRecord["status"]> = new Set(["pending", "issued"]);

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export class WalletPassService {
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly deps: WalletPassServiceDeps) {}

  get passTypeIdentifier(): string {
    return this.deps.passTypeIdentifier;
  }

  /** What the console shows about the setup. */
  get capabilities(): { signed: boolean; email: boolean; updates: boolean } {
    return { signed: Boolean(this.deps.certificate), email: Boolean(this.deps.mailer), updates: this.updatesEnabled };
  }

  /** Wallet only calls an https web service, and only a reachable one can update a pass. */
  private get updatesEnabled(): boolean {
    return /^https:\/\//.test(this.deps.publicUrl) && !/\/\/(localhost|127\.|\[::1\])/.test(this.deps.publicUrl);
  }

  private get identity(): PassIdentity {
    return {
      passTypeIdentifier: this.deps.passTypeIdentifier,
      teamIdentifier: this.deps.teamIdentifier,
      ...(this.updatesEnabled ? { webServiceUrl: `${this.deps.publicUrl.replace(/\/+$/, "")}/api/passes/` } : {}),
    };
  }

  /** Runs `task` after the caller has answered. Errors are logged, never thrown. */
  private later(what: string, task: () => Promise<unknown>): void {
    const p = task()
      .catch((err: unknown) => this.deps.log?.warn({ err, what }, "wallet pass background task failed"))
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  /** Resolves once every background push and email has finished. For tests and shutdown. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  downloadUrl(pass: WalletPassRecord): string {
    return `${this.deps.publicUrl.replace(/\/+$/, "")}/api/wallet-passes/${pass.serialNumber}/${pass.downloadKey}/pass.pkpass`;
  }

  /** The registration's pass, made now if it has none. */
  async ensurePass(registration: RegistrationRecord): Promise<WalletPassRecord> {
    return (
      (await this.deps.repo.findByRegistration(registration.id)) ??
      this.deps.repo.create({
        registrationId: registration.id,
        eventId: registration.eventId,
        serialNumber: randomUUID(),
        authenticationToken: newToken(),
        downloadKey: randomBytes(24).toString("base64url"),
      })
    );
  }

  /** After a registration is stored: make its pass and email it. Answers at once; the work follows. */
  onRegistered(registration: RegistrationRecord): void {
    this.later("issue on registration", async () => {
      const pass = await this.ensurePass(registration);
      if (registration.email && this.deps.mailer) await this.deliver(pass);
    });
  }

  private async content(pass: WalletPassRecord): Promise<PassContent> {
    const registration = await this.deps.registrations.findById(pass.registrationId);
    const event = await this.deps.events.find(pass.eventId);
    if (!registration || !event) throw new Error(`wallet pass ${pass.id} has lost its registration or event`);
    const badge = await this.deps.attendance.findByEventAndAddress(pass.eventId, registration.address);
    return { pass, registration, event, badgeIssued: badge !== null };
  }

  async pkpass(pass: WalletPassRecord): Promise<Buffer> {
    const content = await this.content(pass);
    return buildPkpass(content, this.identity, this.deps.assets, this.deps.certificate, this.deps.style ?? DEFAULT_PASS_STYLE);
  }

  /** A download, by the attendee's link or the organiser: the pass is out, so a pending one is now issued. */
  async download(pass: WalletPassRecord): Promise<{ pass: WalletPassRecord; bytes: Buffer }> {
    const current = pass.status === "pending" ? await this.deps.repo.update(pass.id, { status: "issued", issuedAt: new Date() }) : pass;
    return { pass: current, bytes: await this.pkpass(current) };
  }

  /** Emails the pass. The outcome is written on the pass; nothing is thrown for a failed send. */
  async deliver(pass: WalletPassRecord): Promise<{ sent: boolean; error?: string; pass: WalletPassRecord }> {
    const content = await this.content(pass);
    const to = content.registration.email;
    let error: string | undefined;
    if (!this.deps.mailer) error = "Email is not set up on this server (SMTP_HOST, MAIL_FROM).";
    else if (!to) error = "This registration has no email address.";
    if (error) return { sent: false, error, pass: await this.deps.repo.update(pass.id, { deliveryError: error }) };

    try {
      const bytes = buildPkpass(content, this.identity, this.deps.assets, this.deps.certificate, this.deps.style ?? DEFAULT_PASS_STYLE);
      await this.deps.mailer!.send(passEmail({ to: to!, event: content.event, registration: content.registration, pkpass: bytes, downloadUrl: this.downloadUrl(pass) }));
    } catch (err) {
      const message = (err as Error).message?.slice(0, 300) || "The email could not be sent.";
      this.deps.log?.warn({ passId: pass.id, err: message }, "wallet pass email failed");
      return { sent: false, error: message, pass: await this.deps.repo.update(pass.id, { deliveryError: message }) };
    }
    const now = new Date();
    const updated = await this.deps.repo.update(pass.id, {
      deliveredAt: now,
      deliveryError: null,
      ...(pass.status === "pending" ? { status: "issued" as const, issuedAt: now } : {}),
    });
    this.deps.log?.info({ passId: pass.id, eventId: pass.eventId }, "wallet pass emailed");
    return { sent: true, pass: updated };
  }

  /**
   * The desk scanned a code. A pass of this event, active, on its current
   * token: the registration comes back and the token is replaced, so a
   * screenshot of the code cannot be used again. Everything is logged, the
   * token hashed.
   */
  async scanAtDesk(code: string, eventId: EventId, ipAddress: string | null): Promise<DeskScan> {
    const token = tokenFromPassCode(code);
    const tokenHash = createHash("sha256").update(token ?? code).digest("hex");
    const found = token ? await this.deps.repo.findByToken(token) : null;
    const record = (passId: string | null, result: WalletPassScanResult) =>
      this.later("log scan", () => this.deps.repo.logScan({ passId, eventId, tokenHash, result, ipAddress }));

    if (!found) {
      record(null, "invalid");
      return { ok: false, result: "invalid", message: "This is not a pass of ours, or its code has been replaced." };
    }
    const { pass, stale } = found;
    if (pass.eventId !== eventId) {
      record(pass.id, "other_event");
      return { ok: false, result: "other_event", message: `This pass is for event ${pass.eventId}, not this one.`, eventId: pass.eventId };
    }
    if (pass.status === "suspended" || pass.status === "revoked" || pass.status === "expired") {
      record(pass.id, pass.status);
      return { ok: false, result: pass.status, message: `This pass has been ${pass.status}.` };
    }
    if (stale) {
      record(pass.id, "stale");
      return {
        ok: false,
        result: "stale",
        message: "This code was replaced when the pass was last scanned. Ask them to open the pass in Wallet again, then scan the new code.",
      };
    }

    const { registration, event } = await this.content(pass);
    record(pass.id, "valid");
    // Only a pass that can fetch its new code gets one: rotating a pass that
    // cannot update would leave it showing a dead code.
    const scanned = this.updatesEnabled && (await this.deps.repo.devicesFor(pass.id)).length > 0
      ? await this.deps.repo.update(pass.id, { previousAuthenticationToken: pass.authenticationToken, authenticationToken: newToken() })
      : pass;
    if (scanned !== pass) this.later("push token rotation", () => this.push(scanned, "token_rotation"));
    return { ok: true, pass: scanned, registration, event };
  }

  /** The badge for (event, address) was recorded: the pass now says so. */
  onBadgeIssued(eventId: EventId, address: string): void {
    this.later("badge issued", async () => {
      const registration = await this.deps.registrations.findByAddress(eventId, address);
      const pass = registration ? await this.deps.repo.findByRegistration(registration.id) : null;
      if (!pass) return;
      await this.push(await this.deps.repo.update(pass.id, {}), "badge_issued");
    });
  }

  /** An event was edited: a close expires its passes; a new name, date or place updates them. */
  onEventChanged(before: EventRecord, after: EventRecord): void {
    this.later("event changed", async () => {
      if (after.status === "closed" && before.status !== "closed") {
        const now = new Date();
        for (const pass of await this.deps.repo.listByEvent(after.eventId)) {
          if (pass.status === "revoked" || pass.status === "expired") continue;
          await this.push(await this.deps.repo.update(pass.id, { status: "expired", expiredAt: now }), "expiry");
        }
        return;
      }
      const looks = (e: EventRecord) => [e.name, e.eventDate ?? "", e.venue ?? "", e.description ?? ""].join("\u0000");
      if (looks(before) === looks(after)) return;
      await this.deps.repo.touchEvent(after.eventId);
      for (const pass of await this.deps.repo.listByEvent(after.eventId)) {
        if (pass.status !== "revoked" && pass.status !== "expired") await this.push(pass, "event_update");
      }
    });
  }

  async revoke(pass: WalletPassRecord): Promise<WalletPassRecord> {
    if (pass.status === "revoked" || pass.status === "expired") return pass;
    const updated = await this.deps.repo.update(pass.id, { status: "revoked", revokedAt: new Date() });
    this.later("push revocation", () => this.push(updated, "revocation"));
    return updated;
  }

  async suspend(pass: WalletPassRecord): Promise<WalletPassRecord> {
    if (!ACTIVE.has(pass.status)) return pass;
    const updated = await this.deps.repo.update(pass.id, { status: "suspended", suspendedAt: new Date() });
    this.later("push suspension", () => this.push(updated, "suspension"));
    return updated;
  }

  async reinstate(pass: WalletPassRecord): Promise<WalletPassRecord> {
    if (pass.status !== "suspended") return pass;
    const updated = await this.deps.repo.update(pass.id, { status: pass.issuedAt ? "issued" : "pending", suspendedAt: null });
    this.later("push reinstatement", () => this.push(updated, "reinstatement"));
    return updated;
  }

  /** One push per phone, deduplicated by token, each outcome logged. */
  private async push(pass: WalletPassRecord, event: WalletPushEvent): Promise<void> {
    if (!this.deps.apns) return;
    const devices = await this.deps.repo.devicesFor(pass.id);
    if (devices.length === 0) return;
    const results = await this.deps.apns.pushAll(devices.map((d) => d.pushToken));
    for (const [pushToken, r] of results) {
      await this.deps.repo.logPush({ passId: pass.id, pushToken, event, statusCode: r.statusCode, errorReason: r.reason });
      if (r.statusCode !== 200) this.deps.log?.warn({ passId: pass.id, event, status: r.statusCode, reason: r.reason }, "APNs push not accepted");
    }
  }

  // ---- the web service Wallet calls -------------------------------------------

  /** `Authorization: ApplePass <token>` for this serial: the current token, or the one before it. */
  async authenticate(passTypeIdentifier: string, serialNumber: string, authorization: string | undefined): Promise<WalletPassRecord | null> {
    if (passTypeIdentifier !== this.deps.passTypeIdentifier) return null;
    const m = /^ApplePass (\S{16,200})$/.exec(authorization ?? "");
    if (!m) return null;
    const pass = await this.deps.repo.findBySerial(serialNumber);
    if (!pass) return null;
    const token = m[1]!;
    return safeEqual(token, pass.authenticationToken) ||
      (pass.previousAuthenticationToken !== null && safeEqual(token, pass.previousAuthenticationToken))
      ? pass
      : null;
  }

  registerDevice(pass: WalletPassRecord, deviceLibraryIdentifier: string, pushToken: string): Promise<"created" | "updated"> {
    return this.deps.repo.registerDevice(pass.id, deviceLibraryIdentifier, pushToken);
  }

  unregisterDevice(pass: WalletPassRecord, deviceLibraryIdentifier: string): Promise<void> {
    return this.deps.repo.unregisterDevice(pass.id, deviceLibraryIdentifier);
  }

  async updatedSerials(
    deviceLibraryIdentifier: string,
    passTypeIdentifier: string,
    since: Date | null,
  ): Promise<{ serialNumbers: string[]; lastUpdated: Date } | null> {
    if (passTypeIdentifier !== this.deps.passTypeIdentifier) return null;
    return this.deps.repo.updatedSerials(deviceLibraryIdentifier, since);
  }

  logApi(entry: { passId: string | null; method: string; endpoint: string; responseStatus: number; timingMs: number; ipAddress: string | null }): void {
    this.later("log web service call", () => this.deps.repo.logApi(entry));
  }

  findByRegistration(registrationId: string): Promise<WalletPassRecord | null> {
    return this.deps.repo.findByRegistration(registrationId);
  }

  findBySerial(serialNumber: string): Promise<WalletPassRecord | null> {
    return this.deps.repo.findBySerial(serialNumber);
  }

  listByEvent(eventId: EventId): Promise<WalletPassRecord[]> {
    return this.deps.repo.listByEvent(eventId);
  }

  devicesFor(pass: WalletPassRecord) {
    return this.deps.repo.devicesFor(pass.id);
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

/**
 * The registration store, with a pass made (and emailed) for every new
 * registration. Wraps whichever store the server uses, so each registration
 * route gets passes without changing what it answers.
 */
export function withWalletPasses(inner: RegistrationRepository, passes: WalletPassService): RegistrationRepository {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "create") {
        return async (input: Parameters<RegistrationRepository["create"]>[0]) => {
          const created = await target.create(input);
          passes.onRegistered(created);
          return created;
        };
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}
