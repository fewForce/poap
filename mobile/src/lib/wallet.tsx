/**
 * The wallets on this phone, and which one is in use.
 *
 * A person can keep several: each has a name, an address and its own key in
 * the keychain. One is ACTIVE, and everything else in the app — the pass,
 * registering, collecting, the badges — uses that one until they switch.
 *
 * THE KEYS NEVER LEAVE THE PHONE. They are not sent to poap.live or anywhere
 * else, and are stored "this device only": not synced to iCloud or a Google
 * account and not in a device backup. The person's own written backup is the
 * only copy that can leave — on purpose, and by them.
 */
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { isSeed, newSeed, signerFromSeed, type Signer } from "./keys";
import { registrationsKey } from "./registrations";
import { everywhere, scoped } from "./server";

const STORE: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

const INDEX_KEY = "poap.wallets";
const ACTIVE_KEY = "poap.wallets.active";
const seedKey = (id: string) => `poap.wallets.seed.${id}`;
/** Kept per server, like registrations: a badge recorded on testnet is not one on mainnet. */
const recordedKey = (address: string) => scoped(`poap.recorded.${address}`);

// Before there could be several wallets: one key and two lists, under these names.
const LEGACY_SEED = "poap.wallet.seed";
const LEGACY_RECORDED = "poap.wallet.recorded";
const LEGACY_REGISTRATIONS = "poap.wallet.registrations";

export interface WalletMeta {
  id: string;
  name: string;
  address: string;
  createdAt: string;
}

const get = (key: string) => SecureStore.getItemAsync(key, STORE);
const set = (key: string, value: string) => SecureStore.setItemAsync(key, value, STORE);
const del = (key: string) => SecureStore.deleteItemAsync(key, STORE);

async function readIndex(): Promise<WalletMeta[]> {
  try {
    const raw = await get(INDEX_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as WalletMeta[]) : [];
  } catch {
    return [];
  }
}

const writeIndex = (list: WalletMeta[]) => set(INDEX_KEY, JSON.stringify(list));

function newId(): string {
  return Array.from(Crypto.getRandomBytes(6), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The single wallet older versions of the app kept becomes the first in the list. */
async function migrateLegacy(): Promise<void> {
  const seed = await get(LEGACY_SEED);
  if (!seed) return;
  const { address } = signerFromSeed(seed);
  const index = await readIndex();
  if (!index.some((w) => w.address === address)) {
    const id = newId();
    await set(seedKey(id), seed);
    await writeIndex([...index, { id, name: "My wallet", address, createdAt: new Date().toISOString() }]);
    if (!(await get(ACTIVE_KEY))) await set(ACTIVE_KEY, id);
  }
  // Everything before testnet existed was mainnet.
  const recorded = await get(LEGACY_RECORDED);
  if (recorded) await set(`poap.recorded.${address}`, recorded);
  const registrations = await get(LEGACY_REGISTRATIONS);
  if (registrations) await set(registrationsKey(address, "mainnet"), registrations);
  await Promise.all([del(LEGACY_RECORDED), del(LEGACY_REGISTRATIONS), del(LEGACY_SEED)]);
}

/** A wallet's key, for the person to write down. Shown only when they ask. */
export function revealSeed(id: string): Promise<string | null> {
  return get(seedKey(id));
}

// ---- which badges poap.live already has on record, per wallet ----------------------
//
// Telling poap.live about an accept makes it read the ledger, so it is done
// once per badge rather than every time a pass opens. Losing this list costs
// one repeat report per badge, nothing more: reports are idempotent.

async function recordedEvents(address: string): Promise<number[]> {
  try {
    const raw = await get(recordedKey(address));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((n): n is number => typeof n === "number") : [];
  } catch {
    return [];
  }
}

export async function isRecorded(address: string, eventId: number): Promise<boolean> {
  return (await recordedEvents(address)).includes(eventId);
}

export async function markRecorded(address: string, eventId: number): Promise<void> {
  const list = await recordedEvents(address);
  if (!list.includes(eventId)) await set(recordedKey(address), JSON.stringify([...list, eventId]));
}

// ---- the context the screens use ------------------------------------------------

interface WalletValue {
  status: "loading" | "ready" | "failed";
  wallets: WalletMeta[];
  /** The wallet in use, or null before the first one is made. */
  active: WalletMeta | null;
  wallet: Signer | null;
  /** A brand-new wallet, made active. The key comes back once, to be written down. */
  create(name?: string): Promise<{ meta: WalletMeta; seed: string }>;
  /** A wallet the person already has, from its key, made active. */
  importKey(seed: string, name?: string): Promise<WalletMeta>;
  switchTo(id: string): Promise<void>;
  /** Forget a wallet on this phone. Its badges stay with its address on the ledger. */
  remove(id: string): Promise<void>;
  /** Forget every wallet: the way back in after a forgotten passcode. */
  removeAll(): Promise<void>;
  retry(): void;
}

const WalletContext = createContext<WalletValue | null>(null);

/** A wallet's key and everything kept about it, on every server. */
function forget(w: WalletMeta): Promise<unknown> {
  return Promise.all([
    del(seedKey(w.id)),
    ...everywhere(`poap.recorded.${w.address}`).map(del),
    ...everywhere(registrationsKey(w.address, "mainnet")).map(del),
  ]);
}

async function signerFor(id: string): Promise<Signer | null> {
  const seed = await get(seedKey(id));
  return seed ? signerFromSeed(seed) : null;
}

async function loadAll(): Promise<{ wallets: WalletMeta[]; active: WalletMeta | null; signer: Signer | null }> {
  await migrateLegacy();
  const wallets = await readIndex();
  const activeId = await get(ACTIVE_KEY);
  const active = wallets.find((w) => w.id === activeId) ?? wallets[0] ?? null;
  const signer = active ? await signerFor(active.id) : null;
  return { wallets, active, signer };
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<WalletValue["status"]>("loading");
  const [wallets, setWallets] = useState<WalletMeta[]>([]);
  const [active, setActive] = useState<WalletMeta | null>(null);
  const [wallet, setWallet] = useState<Signer | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    loadAll().then(
      (r) => {
        if (!live) return;
        setWallets(r.wallets);
        setActive(r.active);
        setWallet(r.signer);
        setStatus("ready");
      },
      () => {
        if (live) setStatus("failed");
      },
    );
    return () => {
      live = false;
    };
  }, [attempt]);

  const activate = useCallback(async (list: WalletMeta[], meta: WalletMeta | null) => {
    if (meta) await set(ACTIVE_KEY, meta.id);
    else await del(ACTIVE_KEY);
    setWallets(list);
    setActive(meta);
    setWallet(meta ? await signerFor(meta.id) : null);
  }, []);

  const add = useCallback(
    async (seed: string, name: string | undefined): Promise<WalletMeta> => {
      const list = await readIndex();
      const { address } = signerFromSeed(seed);
      const existing = list.find((w) => w.address === address);
      if (existing) {
        await activate(list, existing);
        return existing;
      }
      const meta: WalletMeta = {
        id: newId(),
        name: name?.trim() || `Wallet ${list.length + 1}`,
        address,
        createdAt: new Date().toISOString(),
      };
      await set(seedKey(meta.id), seed);
      const next = [...list, meta];
      await writeIndex(next);
      await activate(next, meta);
      return meta;
    },
    [activate],
  );

  const value = useMemo<WalletValue>(
    () => ({
      status,
      wallets,
      active,
      wallet,
      async create(name) {
        const seed = newSeed(Crypto.getRandomBytes(16));
        const meta = await add(seed, name);
        return { meta, seed };
      },
      async importKey(seed, name) {
        const clean = seed.trim();
        if (!isSeed(clean)) throw new Error("That is not a wallet key. Check it against your backup and try again.");
        return add(clean, name);
      },
      async switchTo(id) {
        const list = await readIndex();
        const meta = list.find((w) => w.id === id);
        if (meta) await activate(list, meta);
      },
      async remove(id) {
        const list = await readIndex();
        const gone = list.find((w) => w.id === id);
        if (!gone) return;
        const next = list.filter((w) => w.id !== id);
        await writeIndex(next);
        await forget(gone);
        await activate(next, active?.id === id ? (next[0] ?? null) : active);
      },
      async removeAll() {
        const list = await readIndex();
        await Promise.all(list.map((w) => forget(w)));
        await del(INDEX_KEY);
        await activate([], null);
      },
      retry: () => {
        setStatus("loading");
        setAttempt((n) => n + 1);
      },
    }),
    [status, wallets, active, wallet, add, activate],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWalletState(): WalletValue {
  const value = useContext(WalletContext);
  if (!value) throw new Error("useWallet outside <WalletProvider>");
  return value;
}

/** The wallet in use, for screens that render only once there is one. */
export function useWallet(): Signer {
  const { wallet } = useWalletState();
  if (!wallet) throw new Error("there is no wallet yet");
  return wallet;
}
