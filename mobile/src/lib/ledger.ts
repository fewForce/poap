/**
 * The XRP Ledger, asked directly — never through poap.live.
 *
 * The phone signs its own transactions, so it also submits them itself and
 * reads its own wallet, over JSON-RPC to a public node on whichever network
 * poap.live says it is on (GET /health). EXPO_PUBLIC_XRPL_RPC points it at a
 * node of your own instead.
 *
 * Only plain rippled methods: account_info, account_nfts, account_tx,
 * ledger_entry, fee, submit, tx, ledger. Any public node answers them.
 */
import { api, type Network } from "./api";
import { apiBase } from "./server";
import type { Signer } from "./keys";

const NODES: Record<Network, string> = {
  mainnet: "https://s1.ripple.com:51234/",
  testnet: "https://s.altnet.rippletest.net:51234/",
  devnet: "https://s.devnet.rippletest.net:51234/",
};

const OVERRIDE = process.env.EXPO_PUBLIC_XRPL_RPC?.trim() || undefined;

/** The most an accept may cost, in drops. A wallet holds little more than its reserve. */
const MAX_FEE_DROPS = 2_000;

/** Ledgers an accept stays valid for. Ledgers close every three to four seconds. */
const VALID_FOR_LEDGERS = 20;

export class LedgerError extends Error {
  constructor(
    message: string,
    /** rippled's own code (actNotFound, tecNO_ENTRY…), or offline / expired. */
    readonly code: string,
  ) {
    super(message);
    this.name = "LedgerError";
  }
}

let nodeUrl: Promise<string> | null = null;
/** The poap.live the cached answer came from: switching servers asks again. */
let nodeFor: string | null = null;

/** The node to ask, decided once per server from poap.live's own network. */
function node(): Promise<string> {
  if (OVERRIDE) return Promise.resolve(OVERRIDE);
  if (nodeFor !== apiBase()) {
    nodeFor = apiBase();
    nodeUrl = null;
  }
  nodeUrl ??= api
    .health()
    .then((h) => {
      const url = NODES[h.network];
      if (!url) throw new LedgerError(`poap.live is on a network this app does not know: ${h.network}.`, "network");
      return url;
    })
    .catch((err: unknown) => {
      nodeUrl = null; // Offline at launch must not stick.
      throw err;
    });
  return nodeUrl;
}

type Result = Record<string, any>;

async function rpc(method: string, params: Record<string, unknown>): Promise<Result> {
  const url = await node();
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method, params: [params] }),
    });
  } catch {
    throw new LedgerError("We can't reach the XRP Ledger. Check your connection and try again.", "offline");
  }
  if (!res.ok) throw new LedgerError(`The ledger is busy (${res.status}). Trying again shortly.`, `http_${res.status}`);
  const body = (await res.json()) as { result?: Result };
  const result = body.result;
  if (!result) throw new LedgerError("The ledger sent an empty answer.", "empty");
  if (result.status === "error" || typeof result.error === "string") {
    throw new LedgerError(String(result.error_message ?? result.error), String(result.error ?? "error"));
  }
  return result;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- reading the wallet ---------------------------------------------------------

export interface AccountState {
  /** False until the desk's top-up creates the account on the ledger. */
  exists: boolean;
  balanceDrops: string;
  sequence: number;
}

export async function account(address: string): Promise<AccountState> {
  try {
    const r = await rpc("account_info", { account: address, ledger_index: "current" });
    return { exists: true, balanceDrops: String(r.account_data.Balance), sequence: Number(r.account_data.Sequence) };
  } catch (err) {
    if (err instanceof LedgerError && err.code === "actNotFound") return { exists: false, balanceDrops: "0", sequence: 0 };
    throw err;
  }
}

export interface HeldToken {
  nftokenId: string;
  issuer: string;
  /** The event id: poap.live mints each event's badges under its own taxon. */
  taxon: number;
  /** Where the badge's metadata lives, as minted. Null if it has none or it is not text. */
  uri: string | null;
  serial: number;
  /** NFToken flags as minted: 0x0001 burnable, 0x0008 transferable. */
  flags: number;
}

/** tfTransferable on an NFToken. poap.live never sets it: badges stay where they land. */
export const TRANSFERABLE = 0x0008;

/** The ledger keeps an NFT's URI as hex. */
function textFromHex(hex: unknown): string | null {
  if (typeof hex !== "string" || !hex || hex.length % 2) return null;
  try {
    return decodeURIComponent(hex.replace(/../g, "%$&"));
  } catch {
    return null;
  }
}

/** Every NFT the wallet holds right now. */
export async function heldTokens(address: string): Promise<HeldToken[]> {
  const out: HeldToken[] = [];
  let marker: unknown;
  try {
    do {
      const r = await rpc("account_nfts", { account: address, limit: 400, ...(marker ? { marker } : {}) });
      for (const t of (r.account_nfts ?? []) as Result[]) {
        out.push({
          nftokenId: String(t.NFTokenID),
          issuer: String(t.Issuer),
          taxon: Number(t.NFTokenTaxon),
          uri: textFromHex(t.URI),
          serial: Number(t.nft_serial ?? 0),
          flags: Number(t.Flags ?? 0),
        });
      }
      marker = r.marker;
    } while (marker);
  } catch (err) {
    if (err instanceof LedgerError && err.code === "actNotFound") return [];
    throw err;
  }
  return out;
}

export interface LedgerOffer {
  /** Drops as a string for XRP; an object for anything else. */
  amount: unknown;
  destination: string | undefined;
  owner: string;
  flags: number;
  nftokenId: string;
}

/** The offer as the ledger has it, or null once it is gone (taken or cancelled). */
export async function offer(offerId: string): Promise<LedgerOffer | null> {
  try {
    const r = await rpc("ledger_entry", { nft_offer: offerId, ledger_index: "validated" });
    const n = r.node as Result;
    return {
      amount: n.Amount,
      destination: n.Destination,
      owner: String(n.Owner),
      flags: Number(n.Flags ?? 0),
      nftokenId: String(n.NFTokenID),
    };
  } catch (err) {
    if (err instanceof LedgerError && err.code === "entryNotFound") return null;
    throw err;
  }
}

/** tfSellNFToken on an NFTokenOffer. */
const SELL_OFFER = 0x0001;

/** A sell offer of nothing, for this wallet and nobody else: the only kind we accept. */
export function isFreeOfferTo(o: LedgerOffer, address: string): boolean {
  return (o.flags & SELL_OFFER) !== 0 && o.amount === "0" && o.destination === address;
}

export interface FoundAccept {
  hash: string;
  offerId: string;
  nftokenId: string | undefined;
  /** ISO time the ledger closed with it, when the node says. */
  at: string | undefined;
}

/** Ripple epoch: seconds since 2000-01-01. */
const RIPPLE_EPOCH = 946_684_800;

/**
 * An accept this wallet already made, found in its own history — by the offer
 * it took or the badge it got. How the app recovers from being closed between
 * signing and telling poap.live.
 */
export async function findAccept(
  address: string,
  match: { offerId?: string; nftokenId?: string },
): Promise<FoundAccept | null> {
  let r: Result;
  try {
    r = await rpc("account_tx", { account: address, ledger_index_min: -1, ledger_index_max: -1, limit: 200, forward: false });
  } catch (err) {
    if (err instanceof LedgerError && err.code === "actNotFound") return null;
    throw err;
  }
  const wantOffer = match.offerId?.toUpperCase();
  const wantToken = match.nftokenId?.toUpperCase();
  for (const entry of (r.transactions ?? []) as Result[]) {
    const tx = (entry.tx_json ?? entry.tx ?? {}) as Result;
    const meta = (entry.meta ?? {}) as Result;
    if (tx.TransactionType !== "NFTokenAcceptOffer" || meta.TransactionResult !== "tesSUCCESS") continue;
    const offerId = String(tx.NFTokenSellOffer ?? "").toUpperCase();
    const nftokenId = typeof meta.nftoken_id === "string" ? meta.nftoken_id.toUpperCase() : undefined;
    if ((wantOffer && offerId === wantOffer) || (wantToken && nftokenId === wantToken)) {
      const hash = String(entry.hash ?? tx.hash ?? "");
      const at =
        typeof entry.close_time_iso === "string"
          ? entry.close_time_iso
          : typeof tx.date === "number"
            ? new Date((tx.date + RIPPLE_EPOCH) * 1000).toISOString()
            : undefined;
      if (hash) return { hash, offerId, nftokenId, at };
    }
  }
  return null;
}

// ---- accepting -----------------------------------------------------------------

/**
 * Accept a sell offer, signed on this phone, and wait for a validated ledger
 * to say how it went. Throws unless it succeeded.
 */
export async function acceptOffer(
  signer: Signer,
  accept: { NFTokenSellOffer: string; SourceTag?: number },
): Promise<{ hash: string }> {
  let info: Result;
  try {
    info = await rpc("account_info", { account: signer.address, ledger_index: "current" });
  } catch (err) {
    if (err instanceof LedgerError && err.code === "actNotFound") {
      throw new LedgerError("This wallet has not been topped up yet, so it cannot accept a badge.", "not_funded");
    }
    throw err;
  }
  const fees = await rpc("fee", {});
  const fee = Math.min(
    Math.max(Number(fees.drops?.open_ledger_fee ?? 0), Number(fees.drops?.base_fee ?? 0), 12),
    MAX_FEE_DROPS,
  );
  const lastLedger = Number(info.ledger_current_index) + VALID_FOR_LEDGERS;

  const { txBlob, hash } = signer.sign({
    TransactionType: "NFTokenAcceptOffer",
    Account: signer.address,
    NFTokenSellOffer: accept.NFTokenSellOffer,
    ...(typeof accept.SourceTag === "number" ? { SourceTag: accept.SourceTag } : {}),
    Flags: 0,
    Fee: String(fee),
    Sequence: Number(info.account_data.Sequence),
    LastLedgerSequence: lastLedger,
  });

  const submitted = await rpc("submit", { tx_blob: txBlob });
  const prelim = String(submitted.engine_result ?? "");
  // tem: malformed. tef: cannot apply. tel: this node would not relay it. None
  // of them reach a ledger, so there is nothing to wait for.
  if (/^(tem|tef|tel)/.test(prelim)) {
    throw new LedgerError(String(submitted.engine_result_message ?? prelim), prelim);
  }

  const outcome = await waitForValidation(hash, lastLedger);
  if (outcome !== "tesSUCCESS") throw new LedgerError(`The ledger refused the accept (${outcome}).`, outcome);
  return { hash };
}

/** The final result of a submitted transaction, once a validated ledger has it. */
async function waitForValidation(hash: string, lastLedger: number): Promise<string> {
  for (;;) {
    await sleep(1_500);
    try {
      const r = await rpc("tx", { transaction: hash });
      if (r.validated === true) return String(r.meta?.TransactionResult ?? "unknown");
    } catch (err) {
      if (!(err instanceof LedgerError) || err.code !== "txnNotFound") throw err;
    }
    // Past its last ledger and still not in one: it never will be.
    const v = await rpc("ledger", { ledger_index: "validated" });
    const validated = Number(v.ledger_index ?? v.ledger?.ledger_index ?? 0);
    if (validated > lastLedger) throw new LedgerError("The accept did not make it into a ledger in time.", "expired");
  }
}
