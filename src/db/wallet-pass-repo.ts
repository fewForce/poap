/**
 * Apple Wallet passes (018_wallet_passes.sql): one per registration, the
 * phones that added each one, and the scan, push and web-service logs.
 */
import type {
  EventId,
  WalletPassDevice,
  WalletPassPatch,
  WalletPassRecord,
  WalletPassRepository,
  WalletPassScanResult,
  WalletPushEvent,
} from "../types.js";
import { NotFoundError } from "../errors.js";
import type { Queryable } from "./pool.js";

interface PassRow {
  id: string;
  registration_id: string;
  event_id: number;
  serial_number: string;
  authentication_token: string;
  previous_authentication_token: string | null;
  download_key: string;
  status: WalletPassRecord["status"];
  issued_at: Date | null;
  suspended_at: Date | null;
  revoked_at: Date | null;
  expired_at: Date | null;
  delivered_at: Date | null;
  delivery_error: string | null;
  created_at: Date;
  updated_at: Date;
}

interface DeviceRow {
  pass_id: string;
  device_library_identifier: string;
  push_token: string;
  created_at: Date;
  updated_at: Date;
}

const PASS_COLUMNS =
  "id, registration_id, event_id, serial_number, authentication_token, previous_authentication_token, " +
  "download_key, status, issued_at, suspended_at, revoked_at, expired_at, delivered_at, delivery_error, " +
  "created_at, updated_at";

/** Patch field → column. The only columns update() may write. */
const PATCH_COLUMNS: Record<keyof WalletPassPatch, string> = {
  authenticationToken: "authentication_token",
  previousAuthenticationToken: "previous_authentication_token",
  status: "status",
  issuedAt: "issued_at",
  suspendedAt: "suspended_at",
  revokedAt: "revoked_at",
  expiredAt: "expired_at",
  deliveredAt: "delivered_at",
  deliveryError: "delivery_error",
};

function passFromRow(r: PassRow): WalletPassRecord {
  return {
    id: String(r.id),
    registrationId: String(r.registration_id),
    eventId: Number(r.event_id),
    serialNumber: r.serial_number,
    authenticationToken: r.authentication_token,
    previousAuthenticationToken: r.previous_authentication_token,
    downloadKey: r.download_key,
    status: r.status,
    issuedAt: r.issued_at,
    suspendedAt: r.suspended_at,
    revokedAt: r.revoked_at,
    expiredAt: r.expired_at,
    deliveredAt: r.delivered_at,
    deliveryError: r.delivery_error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function deviceFromRow(r: DeviceRow): WalletPassDevice {
  return {
    passId: String(r.pass_id),
    deviceLibraryIdentifier: r.device_library_identifier,
    pushToken: r.push_token,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class PgWalletPassRepository implements WalletPassRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: {
    registrationId: string;
    eventId: EventId;
    serialNumber: string;
    authenticationToken: string;
    downloadKey: string;
  }): Promise<WalletPassRecord> {
    const inserted = await this.db.query(
      `INSERT INTO wallet_passes (registration_id, event_id, serial_number, authentication_token, download_key)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (registration_id) DO NOTHING
       RETURNING ${PASS_COLUMNS}`,
      [input.registrationId, input.eventId, input.serialNumber, input.authenticationToken, input.downloadKey],
    );
    const row = inserted.rows[0] as PassRow | undefined;
    if (row) return passFromRow(row);
    const existing = await this.findByRegistration(input.registrationId);
    if (!existing) throw new NotFoundError(`No wallet pass for registration ${input.registrationId}`);
    return existing;
  }

  private async one(where: string, value: string): Promise<WalletPassRecord | null> {
    const r = await this.db.query(`SELECT ${PASS_COLUMNS} FROM wallet_passes WHERE ${where} = $1`, [value]);
    const row = r.rows[0] as PassRow | undefined;
    return row ? passFromRow(row) : null;
  }

  findById(id: string): Promise<WalletPassRecord | null> {
    return /^\d{1,18}$/.test(id) ? this.one("id", id) : Promise.resolve(null);
  }

  findByRegistration(registrationId: string): Promise<WalletPassRecord | null> {
    return /^\d{1,18}$/.test(registrationId) ? this.one("registration_id", registrationId) : Promise.resolve(null);
  }

  findBySerial(serialNumber: string): Promise<WalletPassRecord | null> {
    // A uuid column refuses anything else with an error, not a miss.
    return UUID_RE.test(serialNumber) ? this.one("serial_number", serialNumber) : Promise.resolve(null);
  }

  async findByToken(token: string): Promise<{ pass: WalletPassRecord; stale: boolean } | null> {
    const current = await this.one("authentication_token", token);
    if (current) return { pass: current, stale: false };
    const previous = await this.one("previous_authentication_token", token);
    return previous ? { pass: previous, stale: true } : null;
  }

  async listByEvent(eventId: EventId): Promise<WalletPassRecord[]> {
    const r = await this.db.query(`SELECT ${PASS_COLUMNS} FROM wallet_passes WHERE event_id = $1 ORDER BY id`, [eventId]);
    return (r.rows as PassRow[]).map(passFromRow);
  }

  async update(id: string, patch: WalletPassPatch): Promise<WalletPassRecord> {
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(PATCH_COLUMNS) as Array<[keyof WalletPassPatch, string]>) {
      if (patch[key] === undefined) continue;
      values.push(patch[key]);
      sets.push(`${column} = $${values.length}`);
    }
    values.push(id);
    const r = await this.db.query(
      `UPDATE wallet_passes SET ${[...sets, "updated_at = now()"].join(", ")}
        WHERE id = $${values.length} RETURNING ${PASS_COLUMNS}`,
      values,
    );
    const row = r.rows[0] as PassRow | undefined;
    if (!row) throw new NotFoundError(`No wallet pass ${id}`);
    return passFromRow(row);
  }

  async touchEvent(eventId: EventId): Promise<void> {
    await this.db.query(`UPDATE wallet_passes SET updated_at = now() WHERE event_id = $1`, [eventId]);
  }

  async registerDevice(passId: string, deviceLibraryIdentifier: string, pushToken: string): Promise<"created" | "updated"> {
    const r = await this.db.query(
      `INSERT INTO wallet_pass_devices (pass_id, device_library_identifier, push_token)
       VALUES ($1, $2, $3)
       ON CONFLICT (device_library_identifier, pass_id)
       DO UPDATE SET push_token = EXCLUDED.push_token, updated_at = now()
       RETURNING (xmax = 0) AS inserted`,
      [passId, deviceLibraryIdentifier, pushToken],
    );
    return (r.rows[0] as { inserted: boolean } | undefined)?.inserted ? "created" : "updated";
  }

  async unregisterDevice(passId: string, deviceLibraryIdentifier: string): Promise<void> {
    await this.db.query(`DELETE FROM wallet_pass_devices WHERE pass_id = $1 AND device_library_identifier = $2`, [
      passId,
      deviceLibraryIdentifier,
    ]);
  }

  async devicesFor(passId: string): Promise<WalletPassDevice[]> {
    const r = await this.db.query(
      `SELECT pass_id, device_library_identifier, push_token, created_at, updated_at
         FROM wallet_pass_devices WHERE pass_id = $1 ORDER BY id`,
      [passId],
    );
    return (r.rows as DeviceRow[]).map(deviceFromRow);
  }

  async updatedSerials(
    deviceLibraryIdentifier: string,
    since: Date | null,
  ): Promise<{ serialNumbers: string[]; lastUpdated: Date } | null> {
    const r = await this.db.query(
      `SELECT p.serial_number, p.updated_at
         FROM wallet_passes p
         JOIN wallet_pass_devices d ON d.pass_id = p.id
        WHERE d.device_library_identifier = $1
          AND ($2::timestamptz IS NULL OR p.updated_at > $2::timestamptz)
        ORDER BY p.updated_at`,
      [deviceLibraryIdentifier, since],
    );
    const rows = r.rows as Array<{ serial_number: string; updated_at: Date }>;
    if (rows.length === 0) return null;
    return {
      serialNumbers: rows.map((row) => row.serial_number),
      lastUpdated: rows[rows.length - 1]!.updated_at,
    };
  }

  async logScan(entry: {
    passId: string | null;
    eventId: EventId | null;
    tokenHash: string;
    result: WalletPassScanResult;
    ipAddress: string | null;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO wallet_pass_scans (pass_id, event_id, token_hash, result, ip_address) VALUES ($1, $2, $3, $4, $5)`,
      [entry.passId, entry.eventId, entry.tokenHash, entry.result, entry.ipAddress],
    );
  }

  async logPush(entry: {
    passId: string;
    pushToken: string;
    event: WalletPushEvent;
    statusCode: number | null;
    errorReason: string | null;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO wallet_pass_pushes (pass_id, push_token, event, status_code, error_reason, success)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [entry.passId, entry.pushToken, entry.event, entry.statusCode, entry.errorReason, entry.statusCode === 200],
    );
  }

  async logApi(entry: {
    passId: string | null;
    method: string;
    endpoint: string;
    responseStatus: number;
    timingMs: number;
    ipAddress: string | null;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO wallet_pass_api_logs (pass_id, method, endpoint, response_status, timing_ms, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [entry.passId, entry.method, entry.endpoint, entry.responseStatus, entry.timingMs, entry.ipAddress],
    );
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The same, in memory, for tests and the database-less demo server. Logs are kept for tests to read. */
export class MemoryWalletPassRepository implements WalletPassRepository {
  readonly passes: WalletPassRecord[] = [];
  readonly devices: WalletPassDevice[] = [];
  readonly scans: Array<{ passId: string | null; eventId: EventId | null; tokenHash: string; result: WalletPassScanResult }> = [];
  readonly pushes: Array<{ passId: string; pushToken: string; event: WalletPushEvent; statusCode: number | null }> = [];
  readonly apiLogs: Array<{ passId: string | null; method: string; endpoint: string; responseStatus: number }> = [];
  private seq = 0;
  /** Strictly increasing, so two changes in one millisecond still order. */
  private lastStamp = 0;

  private now(): Date {
    this.lastStamp = Math.max(Date.now(), this.lastStamp + 1);
    return new Date(this.lastStamp);
  }

  async create(input: {
    registrationId: string;
    eventId: EventId;
    serialNumber: string;
    authenticationToken: string;
    downloadKey: string;
  }): Promise<WalletPassRecord> {
    const existing = this.passes.find((p) => p.registrationId === input.registrationId);
    if (existing) return { ...existing };
    const now = this.now();
    const record: WalletPassRecord = {
      id: String(++this.seq),
      ...input,
      previousAuthenticationToken: null,
      status: "pending",
      issuedAt: null,
      suspendedAt: null,
      revokedAt: null,
      expiredAt: null,
      deliveredAt: null,
      deliveryError: null,
      createdAt: now,
      updatedAt: now,
    };
    this.passes.push(record);
    return { ...record };
  }

  async findById(id: string): Promise<WalletPassRecord | null> {
    const p = this.passes.find((x) => x.id === id);
    return p ? { ...p } : null;
  }

  async findByRegistration(registrationId: string): Promise<WalletPassRecord | null> {
    const p = this.passes.find((x) => x.registrationId === registrationId);
    return p ? { ...p } : null;
  }

  async findBySerial(serialNumber: string): Promise<WalletPassRecord | null> {
    const p = this.passes.find((x) => x.serialNumber === serialNumber);
    return p ? { ...p } : null;
  }

  async findByToken(token: string): Promise<{ pass: WalletPassRecord; stale: boolean } | null> {
    const current = this.passes.find((x) => x.authenticationToken === token);
    if (current) return { pass: { ...current }, stale: false };
    const previous = this.passes.find((x) => x.previousAuthenticationToken === token);
    return previous ? { pass: { ...previous }, stale: true } : null;
  }

  async listByEvent(eventId: EventId): Promise<WalletPassRecord[]> {
    return this.passes.filter((p) => p.eventId === eventId).map((p) => ({ ...p }));
  }

  async update(id: string, patch: WalletPassPatch): Promise<WalletPassRecord> {
    const p = this.passes.find((x) => x.id === id);
    if (!p) throw new NotFoundError(`No wallet pass ${id}`);
    for (const key of Object.keys(PATCH_COLUMNS) as Array<keyof WalletPassPatch>) {
      if (patch[key] !== undefined) (p as unknown as Record<string, unknown>)[key] = patch[key];
    }
    p.updatedAt = this.now();
    return { ...p };
  }

  async touchEvent(eventId: EventId): Promise<void> {
    const now = this.now();
    for (const p of this.passes) if (p.eventId === eventId) p.updatedAt = now;
  }

  async registerDevice(passId: string, deviceLibraryIdentifier: string, pushToken: string): Promise<"created" | "updated"> {
    const existing = this.devices.find((d) => d.passId === passId && d.deviceLibraryIdentifier === deviceLibraryIdentifier);
    const now = this.now();
    if (existing) {
      existing.pushToken = pushToken;
      existing.updatedAt = now;
      return "updated";
    }
    this.devices.push({ passId, deviceLibraryIdentifier, pushToken, createdAt: now, updatedAt: now });
    return "created";
  }

  async unregisterDevice(passId: string, deviceLibraryIdentifier: string): Promise<void> {
    const i = this.devices.findIndex((d) => d.passId === passId && d.deviceLibraryIdentifier === deviceLibraryIdentifier);
    if (i >= 0) this.devices.splice(i, 1);
  }

  async devicesFor(passId: string): Promise<WalletPassDevice[]> {
    return this.devices.filter((d) => d.passId === passId).map((d) => ({ ...d }));
  }

  async updatedSerials(
    deviceLibraryIdentifier: string,
    since: Date | null,
  ): Promise<{ serialNumbers: string[]; lastUpdated: Date } | null> {
    const ids = new Set(this.devices.filter((d) => d.deviceLibraryIdentifier === deviceLibraryIdentifier).map((d) => d.passId));
    const changed = this.passes
      .filter((p) => ids.has(p.id) && (since === null || p.updatedAt.getTime() > since.getTime()))
      .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());
    if (changed.length === 0) return null;
    return { serialNumbers: changed.map((p) => p.serialNumber), lastUpdated: changed[changed.length - 1]!.updatedAt };
  }

  async logScan(entry: {
    passId: string | null;
    eventId: EventId | null;
    tokenHash: string;
    result: WalletPassScanResult;
    ipAddress: string | null;
  }): Promise<void> {
    this.scans.push({ passId: entry.passId, eventId: entry.eventId, tokenHash: entry.tokenHash, result: entry.result });
  }

  async logPush(entry: {
    passId: string;
    pushToken: string;
    event: WalletPushEvent;
    statusCode: number | null;
    errorReason: string | null;
  }): Promise<void> {
    this.pushes.push({ passId: entry.passId, pushToken: entry.pushToken, event: entry.event, statusCode: entry.statusCode });
  }

  async logApi(entry: {
    passId: string | null;
    method: string;
    endpoint: string;
    responseStatus: number;
    timingMs: number;
    ipAddress: string | null;
  }): Promise<void> {
    this.apiLogs.push({
      passId: entry.passId,
      method: entry.method,
      endpoint: entry.endpoint,
      responseStatus: entry.responseStatus,
    });
  }
}
