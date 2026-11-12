/**
 * The badge contract's calls, typed. contracts/near-badges/src/lib.rs is the
 * other side of every function here.
 *
 * VERIFY BY THE RECORD. CLAUDE.md: never verify attendance by current NFT
 * ownership. On NEAR the contract keeps an attendance record per (event,
 * account) that a burn does not remove, and `attendance` answers from it. A
 * transaction lookup is not used to verify: an ordinary RPC node forgets
 * transactions after a few epochs, while the record stays in contract state.
 */
import { XrplLayerError } from "../errors.js";
import type { EventId, NearAttendance, NearGateway, NearSignedTx } from "../types.js";

/** The contract caps a page here. */
export const NEAR_PAGE = 100;

/** The contract's Attendance, as JSON. U64 fields arrive as strings. */
interface RawAttendance {
  event_id: number;
  account_id: string;
  token_id: string;
  block_height: string;
  minted_at_ms: string;
  burned_at_ms: string | null;
}

function toNumber(value: unknown, field: string): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) {
    throw new XrplLayerError("LEDGER_QUERY_FAILED", `The badge contract returned an unreadable ${field}.`, {
      field,
      value,
    });
  }
  return n;
}

export function parseAttendance(raw: unknown): NearAttendance {
  const r = raw as Partial<RawAttendance> | null;
  if (!r || typeof r.account_id !== "string" || typeof r.token_id !== "string") {
    throw new XrplLayerError("LEDGER_QUERY_FAILED", "The badge contract returned an unreadable attendance record.", {
      raw,
    });
  }
  return {
    eventId: toNumber(r.event_id, "event_id"),
    accountId: r.account_id,
    tokenId: r.token_id,
    blockHeight: toNumber(r.block_height, "block_height"),
    mintedAt: new Date(toNumber(r.minted_at_ms, "minted_at_ms")),
    burnedAt: r.burned_at_ms == null ? null : new Date(toNumber(r.burned_at_ms, "burned_at_ms")),
  };
}

/** The contract's own id for a badge. A NEAR account id never contains a colon. */
export function nearTokenId(eventId: EventId, accountId: string): string {
  return `${eventId}:${accountId}`;
}

/** Did this account attend this event? From the record, so a burned badge still says yes. */
export async function nearAttendance(
  near: NearGateway,
  eventId: EventId,
  accountId: string,
): Promise<NearAttendance | null> {
  const raw = await near.view<unknown>("attendance", { event_id: eventId, account_id: accountId });
  return raw == null ? null : parseAttendance(raw);
}

/**
 * Every attendance record for the event, in mint order, a page at a time.
 * `max` bounds the reads: a roster for the organiser's console, not an export.
 */
export async function nearRoster(
  near: NearGateway,
  eventId: EventId,
  opts: { max?: number } = {},
): Promise<NearAttendance[]> {
  const max = opts.max ?? 5_000;
  const out: NearAttendance[] = [];
  for (let from = 0; out.length < max; from += NEAR_PAGE) {
    const page = await near.view<unknown[]>("event_attendees", {
      event_id: eventId,
      from_index: from,
      limit: NEAR_PAGE,
    });
    if (!Array.isArray(page) || page.length === 0) break;
    for (const raw of page) out.push(parseAttendance(raw));
    if (page.length < NEAR_PAGE) break;
  }
  return out.slice(0, max);
}

/** Signs `nft_mint` for one attendee. Nothing is sent. */
/** The contract takes an event title of at most this many UTF-8 bytes. */
export const MAX_TITLE_BYTES = 200;

/**
 * `text` cut to at most `max` UTF-8 bytes, never inside a character. The
 * console allows 200 characters, which in Chinese or with accents is more
 * than 200 bytes; the contract would refuse every mint for such an event.
 */
export function fitBytes(text: string, max: number): string {
  if (Buffer.byteLength(text, "utf8") <= max) return text;
  let out = "";
  let used = 0;
  for (const ch of text) {
    const n = Buffer.byteLength(ch, "utf8");
    if (used + n > max) break;
    out += ch;
    used += n;
  }
  return out;
}

export function signNearMint(
  near: NearGateway,
  input: { eventId: EventId; accountId: string; eventTitle: string },
): Promise<NearSignedTx> {
  return near.signCall("nft_mint", {
    event_id: input.eventId,
    receiver_id: input.accountId,
    event_title: fitBytes(input.eventTitle, MAX_TITLE_BYTES),
  });
}

/** `nft_mint`'s return value. `already` means nothing was minted: the record was there. */
export function parseMintResult(value: unknown): { already: boolean; attendance: NearAttendance } {
  const v = value as { already?: unknown; attendance?: unknown } | null;
  if (!v || typeof v.already !== "boolean") {
    throw new XrplLayerError("LEDGER_QUERY_FAILED", "nft_mint returned something other than a mint result.", {
      value,
    });
  }
  return { already: v.already, attendance: parseAttendance(v.attendance) };
}
