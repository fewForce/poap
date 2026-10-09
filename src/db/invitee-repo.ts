/**
 * The invite list (016_event_invitees.sql): emails the organiser entered for an
 * event, and the wallet address the volunteer app later saved against each.
 */
import type { Pool } from "pg";
import type { EventId, InviteeRecord, InviteeRepository } from "../types.js";

export function normalizeInviteeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function cleanName(name: string | null | undefined): string | null {
  const t = (name ?? "").trim().replace(/\s+/g, " ");
  return t === "" ? null : t.slice(0, 120);
}

interface Row {
  id: string;
  event_id: number;
  email: string;
  display_name: string | null;
  address: string | null;
  wallet_set_at: Date | null;
  created_at: Date;
}

const COLUMNS = "id, event_id, email, display_name, address, wallet_set_at, created_at";

function fromRow(r: Row): InviteeRecord {
  return {
    id: String(r.id),
    eventId: Number(r.event_id),
    email: r.email,
    displayName: r.display_name,
    address: r.address,
    walletSetAt: r.wallet_set_at,
    createdAt: r.created_at,
  };
}

export class PgInviteeRepository implements InviteeRepository {
  constructor(private readonly pool: Pool) {}

  async addMany(eventId: EventId, entries: Array<{ email: string; displayName?: string | null }>): Promise<number> {
    let added = 0;
    for (const e of entries) {
      const r = await this.pool.query(
        `INSERT INTO event_invitees (event_id, email, display_name) VALUES ($1, $2, $3)
         ON CONFLICT (event_id, email) DO NOTHING`,
        [eventId, normalizeInviteeEmail(e.email), cleanName(e.displayName)],
      );
      added += r.rowCount ?? 0;
    }
    return added;
  }

  async list(eventId: EventId): Promise<InviteeRecord[]> {
    const r = await this.pool.query<Row>(
      `SELECT ${COLUMNS} FROM event_invitees WHERE event_id = $1 ORDER BY id DESC`,
      [eventId],
    );
    return r.rows.map(fromRow);
  }

  async find(eventId: EventId, email: string): Promise<InviteeRecord | null> {
    const r = await this.pool.query<Row>(
      `SELECT ${COLUMNS} FROM event_invitees WHERE event_id = $1 AND email = $2`,
      [eventId, normalizeInviteeEmail(email)],
    );
    return r.rows[0] ? fromRow(r.rows[0]) : null;
  }

  async setAddress(eventId: EventId, email: string, address: string): Promise<InviteeRecord | null> {
    const r = await this.pool.query<Row>(
      `UPDATE event_invitees SET address = $3, wallet_set_at = now()
        WHERE event_id = $1 AND email = $2 AND address IS NULL
        RETURNING ${COLUMNS}`,
      [eventId, normalizeInviteeEmail(email), address],
    );
    return r.rows[0] ? fromRow(r.rows[0]) : null;
  }

  async remove(eventId: EventId, email: string): Promise<boolean> {
    const r = await this.pool.query(`DELETE FROM event_invitees WHERE event_id = $1 AND email = $2`, [
      eventId,
      normalizeInviteeEmail(email),
    ]);
    return (r.rowCount ?? 0) > 0;
  }
}

export class MemoryInviteeRepository implements InviteeRepository {
  private readonly rows: InviteeRecord[] = [];
  private seq = 0;

  async addMany(eventId: EventId, entries: Array<{ email: string; displayName?: string | null }>): Promise<number> {
    let added = 0;
    for (const e of entries) {
      const email = normalizeInviteeEmail(e.email);
      if (this.rows.some((r) => r.eventId === eventId && r.email === email)) continue;
      this.seq += 1;
      this.rows.push({
        id: String(this.seq),
        eventId,
        email,
        displayName: cleanName(e.displayName),
        address: null,
        walletSetAt: null,
        createdAt: new Date(),
      });
      added += 1;
    }
    return added;
  }

  async list(eventId: EventId): Promise<InviteeRecord[]> {
    return this.rows.filter((r) => r.eventId === eventId).reverse().map((r) => ({ ...r }));
  }

  async find(eventId: EventId, email: string): Promise<InviteeRecord | null> {
    const row = this.rows.find((r) => r.eventId === eventId && r.email === normalizeInviteeEmail(email));
    return row ? { ...row } : null;
  }

  async setAddress(eventId: EventId, email: string, address: string): Promise<InviteeRecord | null> {
    const row = this.rows.find((r) => r.eventId === eventId && r.email === normalizeInviteeEmail(email));
    if (!row || row.address) return null;
    row.address = address;
    row.walletSetAt = new Date();
    return { ...row };
  }

  async remove(eventId: EventId, email: string): Promise<boolean> {
    const i = this.rows.findIndex((r) => r.eventId === eventId && r.email === normalizeInviteeEmail(email));
    if (i < 0) return false;
    this.rows.splice(i, 1);
    return true;
  }
}
