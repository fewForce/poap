/**
 * A NearGateway with the badge contract simulated in memory.
 *
 * It behaves like contracts/near-badges where the server can tell: one record
 * per (event, account), `nft_mint` returns `already: true` for a second mint,
 * views answer from the records, and a transaction sent twice runs once — the
 * second send returns the first outcome, as NEAR does for the same hash.
 *
 * What a test needs to steer is queued: `failNextSend("Minting is paused")`,
 * `expireNextSend()`, `throwOnNextSend()`, `failNextSign()`. Nothing here
 * touches the network.
 */
import type { NearGateway, NearNetwork, NearSignedTx, NearTxOutcome } from "../../src/types.js";

interface Record_ {
  blockHeight: number;
  mintedAtMs: number;
  burnedAtMs: number | null;
}

type SendStep =
  | { kind: "expired" }
  | { kind: "failure"; error: string }
  /** The send fails and the transaction never ran. */
  | { kind: "throw"; error: string }
  /** The transaction ran; the answer was lost on the way back. */
  | { kind: "lose" };

export class MockNearGateway implements NearGateway {
  readonly network: NearNetwork;
  readonly rpcUrl = "https://rpc.mock.near";
  readonly contractId: string;
  readonly minterAccountId: string;

  /** Named accounts that exist. Implicit ones need not be listed. */
  readonly accounts = new Set<string>();
  readonly records = new Map<string, Record_>();
  readonly titles = new Map<number, string>();
  readonly signed: Array<{ method: string; args: Record<string, unknown>; hash: string }> = [];
  readonly sent: string[] = [];
  height = 1_000;

  #nonce = 0;
  #steps: SendStep[] = [];
  #signFailures: string[] = [];
  #ran = new Map<string, NearTxOutcome>();

  constructor(opts: { network?: NearNetwork; contractId?: string } = {}) {
    this.network = opts.network ?? "testnet";
    this.contractId = opts.contractId ?? "badges.feooh.testnet";
    this.minterAccountId = this.contractId;
  }

  failNextSend(error: string): void {
    this.#steps.push({ kind: "failure", error });
  }

  expireNextSend(): void {
    this.#steps.push({ kind: "expired" });
  }

  /** The next signCall throws before anything is signed: the node is down, say. */
  failNextSign(error = "fetch failed"): void {
    this.#signFailures.push(error);
  }

  throwOnNextSend(error = "socket hang up"): void {
    this.#steps.push({ kind: "throw", error });
  }

  loseNextResponse(): void {
    this.#steps.push({ kind: "lose" });
  }

  /** A record minted outside the server: by a script, or another server. */
  mintedElsewhere(eventId: number, accountId: string): void {
    this.records.set(`${eventId}:${accountId}`, { blockHeight: ++this.height, mintedAtMs: Date.now(), burnedAtMs: null });
  }

  burn(eventId: number, accountId: string): void {
    const r = this.records.get(`${eventId}:${accountId}`);
    if (r) r.burnedAtMs = Date.now();
  }

  async view<T>(method: string, args: Record<string, unknown>): Promise<T> {
    if (method === "attendance") {
      const key = `${args.event_id}:${args.account_id}`;
      const r = this.records.get(key);
      return (r ? this.#raw(Number(args.event_id), String(args.account_id), r) : null) as T;
    }
    if (method === "event_attendees") {
      const prefix = `${args.event_id}:`;
      const all = [...this.records.entries()].filter(([k]) => k.startsWith(prefix));
      const from = Number(args.from_index ?? 0);
      const limit = Number(args.limit ?? 100);
      return all
        .slice(from, from + limit)
        .map(([k, r]) => this.#raw(Number(args.event_id), k.slice(prefix.length), r)) as T;
    }
    throw new Error(`MockNearGateway: no view ${method}`);
  }

  async accountExists(accountId: string): Promise<boolean> {
    return this.accounts.has(accountId);
  }

  async signCall(method: string, args: Record<string, unknown>): Promise<NearSignedTx> {
    const failure = this.#signFailures.shift();
    if (failure) throw new Error(failure);
    const nonce = ++this.#nonce;
    const hash = `MockTx${nonce}${"x".repeat(38)}`.slice(0, 44);
    this.signed.push({ method, args, hash });
    return { hash, signedTx: Buffer.from(JSON.stringify({ method, args, nonce })).toString("base64") };
  }

  async send(signed: NearSignedTx): Promise<NearTxOutcome> {
    this.sent.push(signed.hash);
    const ran = this.#ran.get(signed.hash);
    if (ran) return ran;

    const step = this.#steps.shift();
    if (step?.kind === "throw") throw new Error(step.error);
    if (step?.kind === "expired") return { status: "expired", hash: signed.hash };
    if (step?.kind === "failure") {
      const outcome: NearTxOutcome = { status: "failure", hash: signed.hash, error: step.error };
      this.#ran.set(signed.hash, outcome);
      return outcome;
    }

    const { method, args } = JSON.parse(Buffer.from(signed.signedTx, "base64").toString("utf8")) as {
      method: string;
      args: { event_id: number; receiver_id: string; event_title: string };
    };
    if (method !== "nft_mint") throw new Error(`MockNearGateway: cannot run ${method}`);
    const key = `${args.event_id}:${args.receiver_id}`;
    const existing = this.records.get(key);
    let value: unknown;
    if (existing) {
      value = { already: true, attendance: this.#raw(args.event_id, args.receiver_id, existing) };
    } else {
      if (!this.titles.has(args.event_id)) this.titles.set(args.event_id, args.event_title);
      const record = { blockHeight: ++this.height, mintedAtMs: 1_760_000_000_000 + this.height, burnedAtMs: null };
      this.records.set(key, record);
      value = { already: false, attendance: this.#raw(args.event_id, args.receiver_id, record) };
    }
    const outcome: NearTxOutcome = { status: "success", hash: signed.hash, value };
    this.#ran.set(signed.hash, outcome);
    if (step?.kind === "lose") throw new Error("socket hang up after the transaction ran");
    return outcome;
  }

  #raw(eventId: number, accountId: string, r: Record_): unknown {
    return {
      event_id: eventId,
      account_id: accountId,
      token_id: `${eventId}:${accountId}`,
      block_height: String(r.blockHeight),
      minted_at_ms: String(r.mintedAtMs),
      burned_at_ms: r.burnedAtMs === null ? null : String(r.burnedAtMs),
    };
  }
}
