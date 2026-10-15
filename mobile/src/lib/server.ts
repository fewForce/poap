/**
 * Which poap.live the app talks to: the real one on mainnet, or its testnet
 * twin. Mainnet unless someone turns on the network options in Settings.
 *
 * The wallets are the same on both — a key works on either ledger — but what
 * the phone remembers about events is not: registrations made on testnet mean
 * nothing on mainnet. So those lists are kept per server, through scoped().
 *
 * Kept in a module rather than a React context because the API client and the
 * ledger reader need it outside any component. Settings sets it once at launch,
 * before anything is fetched, and again whenever it is changed.
 */

export type Server = "mainnet" | "testnet";

export const SERVERS: Record<Server, { label: string; host: string; url: string }> = {
  mainnet: {
    label: "Mainnet",
    host: "poap.live",
    // A local poap.live for development, when EXPO_PUBLIC_API_URL says so.
    url: (process.env.EXPO_PUBLIC_API_URL ?? "https://poap.live").replace(/\/+$/, ""),
  },
  testnet: { label: "Testnet", host: "testnet.poap.live", url: "https://testnet.poap.live" },
};

let current: Server = "mainnet";

export function setServer(server: Server): void {
  current = server;
}

export function server(): Server {
  return current;
}

/** The base URL every API request goes to. */
export function apiBase(): string {
  return SERVERS[current].url;
}

/**
 * A storage key for something that belongs to one server. Mainnet keeps the
 * names it has always had, so nothing stored before testnet existed moves.
 */
export function scoped(key: string, on: Server = current): string {
  return on === "mainnet" ? key : `${on}.${key}`;
}

/** The same key on every server, for forgetting a wallet everywhere. */
export function everywhere(key: string): string[] {
  return (Object.keys(SERVERS) as Server[]).map((s) => scoped(key, s));
}
