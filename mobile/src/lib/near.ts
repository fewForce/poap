/**
 * NEAR, asked directly — never through poap.live — like the XRP Ledger in
 * ledger.ts.
 *
 * NEAR badges come from one contract (contracts/near-badges in poap), which
 * poap.live names in GET /health along with a node to ask. The app only reads
 * it: `nft_tokens_for_owner` for the wallet's NEAR account. Nothing here signs:
 * a NEAR badge is minted straight into the account, with nothing to accept.
 *
 * A server without NEAR names no contract, and every function here answers
 * "nothing" without a network call.
 */
import { api, type Health } from "./api";
import { apiBase } from "./server";

export class NearError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NearError";
  }
}

export interface NearBadge {
  /** `"{eventId}:{account}"` — the contract's token id. */
  tokenId: string;
  eventId: number;
  /** The contract, e.g. badges.feooh.testnet. */
  contractId: string;
  title: string | null;
  description: string | null;
  /** https only. */
  media: string | null;
  /** The metadata JSON the token points at, https only. */
  reference: string | null;
  mintedAt: string | null;
}

let nearFor: string | null = null;
let nearInfo: Promise<Health["near"] | null> | null = null;

/** The NEAR contract and node this server uses, or null when it has none. Asked once per server. */
export function nearOf(): Promise<Health["near"] | null> {
  if (nearFor !== apiBase()) {
    nearFor = apiBase();
    nearInfo = null;
  }
  nearInfo ??= api
    .health()
    // https, or plain http to this machine for a development server.
    .then((h) => (h.near && h.near.contractId && /^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)[:/])/.test(h.near.rpcUrl) ? h.near : null))
    .catch((err: unknown) => {
      nearInfo = null; // offline at launch must not stick
      throw err;
    });
  return nearInfo;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Base64 of ASCII text, by hand: not every Hermes build has btoa. */
function base64(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 3) {
    const a = text.charCodeAt(i);
    const b = i + 1 < text.length ? text.charCodeAt(i + 1) : NaN;
    const c = i + 2 < text.length ? text.charCodeAt(i + 2) : NaN;
    const n = (a << 16) | ((b || 0) << 8) | (c || 0);
    out += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63);
    out += Number.isNaN(b) ? "=" : B64.charAt((n >> 6) & 63);
    out += Number.isNaN(c) ? "=" : B64.charAt(n & 63);
  }
  return out;
}

/** UTF-8 bytes to a string, by hand: not every Hermes build has TextDecoder. */
function fromBytes(bytes: number[]): string {
  let out = "";
  for (let i = 0; i < bytes.length; ) {
    const b0 = bytes[i++] ?? 0;
    let cp = b0;
    if (b0 >= 0xf0) cp = ((b0 & 0x07) << 18) | (((bytes[i++] ?? 0) & 0x3f) << 12) | (((bytes[i++] ?? 0) & 0x3f) << 6) | ((bytes[i++] ?? 0) & 0x3f);
    else if (b0 >= 0xe0) cp = ((b0 & 0x0f) << 12) | (((bytes[i++] ?? 0) & 0x3f) << 6) | ((bytes[i++] ?? 0) & 0x3f);
    else if (b0 >= 0xc0) cp = ((b0 & 0x1f) << 6) | ((bytes[i++] ?? 0) & 0x3f);
    out += String.fromCodePoint(cp);
  }
  return out;
}

async function view<T>(rpcUrl: string, contractId: string, method: string, args: Record<string, unknown>): Promise<T> {
  const request = JSON.stringify({
    jsonrpc: "2.0",
    id: "poap",
    method: "query",
    params: {
      request_type: "call_function",
      finality: "final",
      account_id: contractId,
      method_name: method,
      args_base64: base64(JSON.stringify(args)),
    },
  });
  let res: Response;
  try {
    res = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: request });
  } catch {
    throw new NearError("We can't reach NEAR. Check your connection and try again.");
  }
  if (!res.ok) throw new NearError(`NEAR is busy (${res.status}). Trying again shortly.`);
  const body = (await res.json()) as { result?: { result?: number[]; error?: string }; error?: { message?: string } };
  if (body.error || !body.result || body.result.error || !Array.isArray(body.result.result)) {
    throw new NearError("NEAR did not answer that question.");
  }
  return JSON.parse(fromBytes(body.result.result)) as T;
}

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const https = (v: unknown): string | null => {
  const t = text(v);
  return t && /^https:\/\/\S+$/.test(t) ? t : null;
};

/** Every badge the NEAR account holds on this server's contract. Burned ones are gone from here. */
export async function nearBadges(accountId: string): Promise<NearBadge[]> {
  if (!accountId) return [];
  const near = await nearOf();
  if (!near) return [];
  const out: NearBadge[] = [];
  // The contract pages at 100; a person with more than 500 badges sees the first 500.
  for (let from = 0; from < 500; from += 100) {
    const page = await view<{ token_id: string; metadata?: Record<string, unknown> }[]>(
      near.rpcUrl,
      near.contractId,
      "nft_tokens_for_owner",
      { account_id: accountId, from_index: String(from), limit: 100 },
    );
    for (const t of page) {
      const m = /^(\d+):/.exec(t.token_id);
      if (!m) continue;
      const md = t.metadata ?? {};
      const issued = Number(text(md.issued_at));
      out.push({
        tokenId: t.token_id,
        eventId: Number(m[1]),
        contractId: near.contractId,
        title: text(md.title),
        description: text(md.description),
        media: https(md.media),
        reference: https(md.reference),
        mintedAt: Number.isFinite(issued) && issued > 0 ? new Date(issued).toISOString() : null,
      });
    }
    if (page.length < 100) break;
  }
  return out;
}

/** True for a NEAR token id as the contract makes them. */
export const isNearTokenId = (id: string): boolean => /^\d+:[a-z0-9._-]{2,64}$/.test(id);
