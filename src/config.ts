/**
 * Environment parsing plus the mainnet guard rail.
 *
 * Nothing here reads process.env at import time — call loadConfig() from an
 * entrypoint so tests can build a config object directly.
 */
import { config as loadDotenv } from "dotenv";
import { ConfigError, NetworkGuardError } from "./errors.js";
import { isXrpAmount, xrpToDropsBigInt } from "./money.js";
import { decodeMasterKey } from "./treasury/seal.js";
import type { NearNetwork, NetworkName } from "./types.js";
import { badgeReadyReserveXrp } from "./xrpl/reserve.js";

/**
 * The server-wide half of paying attendees. The per-event half — how much, and
 * how much in total — is set on each event in the console.
 */
export interface RewardConfig {
  /**
   * Seals every event's treasury seed. Server-side only, exactly like the
   * issuer seed: never log it, never serialise it, never ship it. Without it
   * no treasury can be created or opened, and nobody is paid.
   */
  treasuryMasterKey?: string;
  /**
   * The most one attendee can ever be sent, allowance and top-up together. An
   * organiser cannot set an allowance that would go past it.
   */
  maxPerAttendeeXrp: string;
  /**
   * Added to every payment so transaction fees never eat into what the
   * attendee can spend. Small: 0.01 XRP covers hundreds of transactions.
   */
  feeBufferXrp: string;
}

/**
 * NEAR, beside XRPL. Absent unless the operator sets it up: without it the
 * server is XRPL-only, exactly as before, and a NEAR event cannot be created.
 */
export interface NearConfig {
  network: NearNetwork;
  rpcUrl: string;
  /** The badge contract, contracts/near-badges. */
  contractId: string;
  /** Whose key mints: normally the contract's own account. */
  minterAccountId: string;
  /**
   * `ed25519:<base58>`, a function-call access key limited to nft_mint.
   * Server-side only. Never log this, never serialise it, never ship it.
   */
  minterPrivateKey: string;
}

/** Free public RPC; NEAR's own rpc.*.near.org endpoints are rate-limited. Override with NEAR_RPC_URL. */
export const NEAR_RPC_DEFAULTS: Record<NearNetwork, string> = {
  testnet: "https://rpc.testnet.fastnear.com",
  mainnet: "https://rpc.mainnet.fastnear.com",
};

/**
 * Where the Pass Type ID certificate is: a .p12 as Keychain Access exports
 * it, or the PEM pair (certificate, and the private key, encrypted or not).
 * Paths, read at startup; the passwords never leave this process.
 */
export interface WalletPassConfig {
  p12Path?: string;
  p12Password?: string;
  certificatePath?: string;
  privateKeyPath?: string;
  keyPassword?: string;
  /** Where the server is reached: download links, and the web service Wallet updates from (https only). */
  publicUrl: string;
  /** Shown on the lock screen and in Wallet's notifications. */
  organizationName: string;
}

export interface SmtpSettings {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  password?: string;
  from: string;
  fromName: string;
}

export interface AppConfig {
  endpoint: string;
  fallbackEndpoints: string[];
  network: NetworkName;
  issuerAddress: string;
  /** Server-side only. Never log this, never serialise it, never ship it. */
  issuerSeed: string;
  reward: RewardConfig;
  /** NEAR, when the operator has set it up. See NearConfig. */
  near?: NearConfig;
  /** Apple Wallet passes (src/wallet), when a Pass Type ID certificate is configured. */
  walletPasses?: WalletPassConfig;
  /** An SMTP server to email passes through. Optional even with passes: they can still be downloaded. */
  smtp?: SmtpSettings;
  pinata: { jwt?: string; gateway: string };
  xumm: { apiKey?: string; apiSecret?: string };
  databaseUrl?: string;
  /**
   * Fallback NFTokenMint URI when a claim request does not carry its own.
   * Points at the metadata JSON, not the image. Capped at 256 bytes.
   */
  defaultMetadataUri?: string;
  /**
   * Testnet-only click-through demo at /demo. Generates wallets, takes faucet
   * funds and signs on an attendee's behalf, so it refuses to boot on mainnet
   * rather than quietly disabling itself.
   */
  demoEnabled: boolean;
  /**
   * Label drawn on the badge artwork. Feeds BOTH the locally-rendered preview
   * and the copy pinned to IPFS — they must be the same string or the two stop
   * being byte-identical, which is the guarantee the UI makes to attendees.
   * Read once here so there is no second place to set it inconsistently.
   */
  eventName?: string;
  /**
   * SourceTag stamped on every transaction this app submits, and on the
   * accept payload the attendee signs. A uint32 used for attribution — it
   * moves no funds and changes no behaviour, it just makes our traffic
   * identifiable on the ledger.
   */
  sourceTag?: number;
  /**
   * What a badge's metadata points at for its image.
   *
   * "https" (default) uses the pinning gateway, which serves the bytes
   * immediately. "ipfs" is content-addressed but unfindable on public
   * gateways for hours after pinning — and the choice is permanent, because
   * the metadata CID lands in an immutable NFTokenMint URI. Use "ipfs" only
   * when you pre-pin well ahead of the event.
   */
  badgeImageUriMode: "ipfs" | "https";
  /**
   * What NFTokenMint's URI field points at. Defaults to "https".
   *
   * ipfs:// is the standard, and measured across Xaman, Bithomp and
   * testnet.xrpl.org it is also the one nothing renders — they show the raw
   * string and never resolve it. Permanent per badge.
   */
  badgeMetadataUriMode: "ipfs" | "https" | "selfhosted";
  /**
   * Public origin badge metadata and artwork are served from, when
   * badgeMetadataUriMode is "selfhosted". e.g. https://badges.example.com
   *
   * PERMANENT: this origin ends up inside an immutable NFTokenMint URI. Never
   * point it at a tunnel or a hostname you might not keep.
   */
  badgeBaseUrl?: string;
  admin: {
    email?: string;
    /** scrypt hash, produced by `npm run admin:hash`. Never a plaintext password. */
    passwordHash?: string;
    /** Signs the session cookie. Rotating it logs everyone out, which is the point. */
    sessionSecret?: string;
    sessionTtlHours: number;
  };
  api: {
    port: number;
    host: string;
    /**
     * Set the Secure flag on cookies. Must be true behind HTTPS and false on
     * plain-http localhost, because a Secure cookie is simply never sent over
     * http and the symptom is a login that silently does nothing.
     */
    secureCookies: boolean;
    /**
     * Whether to trust X-Forwarded-For. Rate limiting is keyed on the client
     * IP, so behind an ingress this must be set or every attendee shares one
     * bucket. Defaults to false — trusting a spoofable header by default would
     * hand an attacker unlimited buckets.
     */
    trustProxy: boolean | string | string[];
  };
}

const NETWORKS: NetworkName[] = ["testnet", "devnet", "mainnet"];

/**
 * `TRUST_PROXY` -> a Fastify trustProxy value. Booleans follow the same
 * vocabulary as bool(); anything else is passed through as an address or CIDR
 * list. There is deliberately no hop-count form: Fastify treats a numeric
 * trustProxy as fail-closed, so `TRUST_PROXY=1` would read as "trust one hop"
 * and silently mean "trust nothing".
 */
export function parseTrustProxy(raw: string | undefined): boolean | string {
  const v = raw?.trim();
  if (!v) return false;
  const lower = v.toLowerCase();
  if (["true", "1", "yes", "on"].includes(lower)) return true;
  if (["false", "0", "no", "off"].includes(lower)) return false;
  return v;
}

/** Substrings that can only ever appear in a non-production endpoint. */
const NON_MAINNET_MARKERS = ["altnet", "devnet", "rippletest", "sidechain", "localhost", "127.0.0.1"];

function env(key: string): string | undefined {
  const v = process.env[key];
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

function required(key: string): string {
  const v = env(key);
  if (!v) throw new ConfigError(`Missing required environment variable ${key}`, { key });
  return v;
}

function bool(key: string, fallback: boolean): boolean {
  const v = env(key);
  if (v === undefined) return fallback;
  if (["true", "1", "yes", "on"].includes(v.toLowerCase())) return true;
  if (["false", "0", "no", "off"].includes(v.toLowerCase())) return false;
  throw new ConfigError(`${key} must be a boolean, got "${v}"`, { key });
}

/**
 * SOURCE_TAG must fit a uint32 — the ledger rejects anything wider, and it
 * would be rejected at submit time rather than at boot, which is the wrong
 * place to find out.
 */
function sourceTag(): number | undefined {
  const raw = env("SOURCE_TAG");
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 4_294_967_295) {
    throw new ConfigError(
      `SOURCE_TAG must be an integer in [0, 4294967295] (uint32), got "${raw}"`,
      { sourceTag: raw },
    );
  }
  return n;
}

/**
 * REWARD_* and TREASURY_MASTER_KEY.
 *
 * Checked here rather than at the first payment, which is in front of an
 * attendee: a master key that is not 32 bytes, or a ceiling too low to switch
 * on even an empty wallet, stops the server at boot.
 */
function rewardConfig(): RewardConfig {
  const treasuryMasterKey = env("TREASURY_MASTER_KEY");
  // Throws ConfigError without ever repeating the value.
  if (treasuryMasterKey !== undefined) decodeMasterKey(treasuryMasterKey);

  const xrp = (key: string, fallback: string): string => {
    const v = env(key) ?? fallback;
    if (!isXrpAmount(v)) {
      throw new ConfigError(
        `${key} must be a plain XRP amount with at most six decimal places, got "${v}"`,
        { key },
      );
    }
    return v;
  };

  const maxPerAttendeeXrp = xrp("REWARD_MAX_PER_ATTENDEE_XRP", "10");
  const feeBufferXrp = xrp("REWARD_FEE_BUFFER_XRP", "0.01");

  const floor = xrpToDropsBigInt(badgeReadyReserveXrp()) + xrpToDropsBigInt(feeBufferXrp);
  if (xrpToDropsBigInt(maxPerAttendeeXrp) < floor) {
    throw new ConfigError(
      `REWARD_MAX_PER_ATTENDEE_XRP is ${maxPerAttendeeXrp}, which is less than an empty wallet needs ` +
        `just to hold a badge (${badgeReadyReserveXrp()} XRP) plus the fee buffer ` +
        `(${feeBufferXrp} XRP). Nobody could be paid.`,
      { maxPerAttendeeXrp, feeBufferXrp },
    );
  }

  return {
    ...(treasuryMasterKey === undefined ? {} : { treasuryMasterKey }),
    maxPerAttendeeXrp,
    feeBufferXrp,
  };
}

function int(key: string, fallback: number): number {
  const v = env(key);
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isInteger(n)) throw new ConfigError(`${key} must be an integer, got "${v}"`, { key });
  return n;
}

/**
 * The guard rail from section 3. Cheap insurance against demoing on the wrong
 * chain — in either direction.
 */
export function assertNetworkMatchesEndpoint(network: NetworkName, endpoint: string): void {
  const lower = endpoint.toLowerCase();

  if (!/^wss?:\/\//.test(lower)) {
    throw new ConfigError(
      `XRPL_ENDPOINT must be a ws:// or wss:// URL, got "${endpoint}"`,
      { endpoint },
    );
  }

  const marker = NON_MAINNET_MARKERS.find((m) => lower.includes(m));

  if (network === "mainnet" && marker) {
    throw new NetworkGuardError(
      `XRPL_NETWORK=mainnet but endpoint "${endpoint}" looks like a test network (matched "${marker}"). Refusing to start.`,
      { network, endpoint, marker },
    );
  }

  if (network !== "mainnet" && !marker) {
    throw new NetworkGuardError(
      `XRPL_NETWORK=${network} but endpoint "${endpoint}" has no test-network marker. This looks like mainnet. Refusing to start.`,
      { network, endpoint },
    );
  }
}

export interface LoadConfigOptions {
  /** Skip reading a .env file. Useful in tests. */
  skipDotenv?: boolean;
  /** Issuer credentials are not needed by read-only entrypoints. */
  requireIssuer?: boolean;
}

export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const { skipDotenv = false, requireIssuer = true } = options;
  if (!skipDotenv) loadDotenv({ quiet: true });

  const endpoint = required("XRPL_ENDPOINT");
  const networkRaw = (env("XRPL_NETWORK") ?? "testnet").toLowerCase();
  if (!NETWORKS.includes(networkRaw as NetworkName)) {
    throw new ConfigError(
      `XRPL_NETWORK must be one of ${NETWORKS.join(" | ")}, got "${networkRaw}"`,
    );
  }
  const network = networkRaw as NetworkName;

  assertNetworkMatchesEndpoint(network, endpoint);

  const fallbackEndpoints = (env("XRPL_FALLBACK_ENDPOINTS") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const fb of fallbackEndpoints) assertNetworkMatchesEndpoint(network, fb);

  const issuerSeed = requireIssuer ? required("ISSUER_SEED") : (env("ISSUER_SEED") ?? "");
  const issuerAddress = requireIssuer ? required("ISSUER_ADDRESS") : (env("ISSUER_ADDRESS") ?? "");

  return {
    endpoint,
    fallbackEndpoints,
    network,
    issuerAddress,
    issuerSeed,
    reward: rewardConfig(),
    ...nearConfigOrNothing(),
    ...walletPassConfigOrNothing(),
    ...smtpConfigOrNothing(),
    pinata: { jwt: env("PINATA_JWT"), gateway: env("PINATA_GATEWAY") ?? "https://gateway.pinata.cloud" },
    xumm: { apiKey: env("XUMM_API_KEY"), apiSecret: env("XUMM_API_SECRET") },
    databaseUrl: env("DATABASE_URL"),
    defaultMetadataUri: env("EVENT_METADATA_URI"),
    demoEnabled: bool("DEMO_ENABLED", false),
    eventName: env("EVENT_NAME"),
    sourceTag: sourceTag(),
    badgeImageUriMode: env("BADGE_IMAGE_URI_MODE") === "ipfs" ? "ipfs" : "https",
    badgeMetadataUriMode: ((): "ipfs" | "https" | "selfhosted" => {
      const m = env("BADGE_METADATA_URI_MODE");
      if (m === "ipfs" || m === "selfhosted") return m;
      return "https";
    })(),
    badgeBaseUrl: env("BADGE_BASE_URL"),
    admin: {
      email: env("ADMIN_EMAIL"),
      passwordHash: env("ADMIN_PASSWORD_HASH"),
      sessionSecret: env("SESSION_SECRET"),
      sessionTtlHours: int("SESSION_TTL_HOURS", 12),
    },
    api: {
      port: int("PORT", 3000),
      host: env("HOST") ?? "127.0.0.1",
      secureCookies: bool("SECURE_COOKIES", false),
      trustProxy: parseTrustProxy(env("TRUST_PROXY")),
    },
  };
}

/**
 * NEAR_* settings. All or none: a server with a contract and no key would
 * accept NEAR events and then fail at the desk, so half a configuration is a
 * startup error, not a quiet XRPL-only server.
 */
function nearConfigOrNothing(): { near?: NearConfig } {
  const contractId = env("NEAR_CONTRACT_ID");
  const minterAccountId = env("NEAR_MINTER_ACCOUNT_ID");
  const minterPrivateKey = env("NEAR_MINTER_PRIVATE_KEY");
  const given = { NEAR_CONTRACT_ID: contractId, NEAR_MINTER_ACCOUNT_ID: minterAccountId, NEAR_MINTER_PRIVATE_KEY: minterPrivateKey };
  const missing = Object.entries(given).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length === 3) return {};
  if (missing.length > 0) {
    throw new ConfigError(`NEAR is half set up: ${missing.join(", ")} missing. Set all three, or none.`);
  }

  const networkRaw = (env("NEAR_NETWORK") ?? "testnet").toLowerCase();
  if (networkRaw !== "testnet" && networkRaw !== "mainnet") {
    throw new ConfigError(`NEAR_NETWORK must be testnet | mainnet, got "${networkRaw}"`);
  }
  const network = networkRaw as NearNetwork;

  // The same guard as XRPL's: a testnet contract on a mainnet server, or the
  // reverse, mints where nobody is looking.
  for (const [name, id] of [
    ["NEAR_CONTRACT_ID", contractId!],
    ["NEAR_MINTER_ACCOUNT_ID", minterAccountId!],
  ] as const) {
    const testnetName = id === "testnet" || id.endsWith(".testnet");
    if (/^[0-9a-f]{64}$/.test(id)) continue;
    if (network === "testnet" ? !testnetName : testnetName) {
      throw new NetworkGuardError(`${name} ${id} is not a ${network} account, and NEAR_NETWORK is ${network}.`);
    }
  }
  if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{40,100}$/.test(minterPrivateKey!)) {
    // Never echo the value.
    throw new ConfigError("NEAR_MINTER_PRIVATE_KEY must look like ed25519:<base58>.");
  }

  return {
    near: {
      network,
      rpcUrl: env("NEAR_RPC_URL") ?? NEAR_RPC_DEFAULTS[network],
      contractId: contractId!,
      minterAccountId: minterAccountId!,
      minterPrivateKey: minterPrivateKey!,
    },
  };
}

/**
 * APPLE_PASS_* settings. Either a .p12 (APPLE_PASS_P12_PATH and its password)
 * or the PEM pair (APPLE_PASS_CERTIFICATE_PATH, APPLE_PASS_PRIVATE_KEY_PATH,
 * and APPLE_PASS_KEY_PASSWORD when the key is encrypted). Half a pair is a
 * startup error. WALLET_PASS_PUBLIC_URL defaults to BADGE_BASE_URL.
 */
function walletPassConfigOrNothing(): { walletPasses?: WalletPassConfig } {
  const p12Path = env("APPLE_PASS_P12_PATH");
  const certificatePath = env("APPLE_PASS_CERTIFICATE_PATH");
  const privateKeyPath = env("APPLE_PASS_PRIVATE_KEY_PATH");
  if (!p12Path && !certificatePath && !privateKeyPath) return {};
  if (!p12Path && (!certificatePath || !privateKeyPath)) {
    throw new ConfigError(
      "Apple Wallet passes are half set up: set APPLE_PASS_CERTIFICATE_PATH and APPLE_PASS_PRIVATE_KEY_PATH together, or APPLE_PASS_P12_PATH.",
    );
  }
  const publicUrl = env("WALLET_PASS_PUBLIC_URL") ?? env("BADGE_BASE_URL");
  if (!publicUrl || !/^https?:\/\//.test(publicUrl)) {
    throw new ConfigError("Apple Wallet passes need WALLET_PASS_PUBLIC_URL (or BADGE_BASE_URL): where this server is reached.");
  }
  return {
    walletPasses: {
      ...(p12Path ? { p12Path, p12Password: env("APPLE_PASS_P12_PASSWORD") ?? "" } : {}),
      ...(certificatePath ? { certificatePath } : {}),
      ...(privateKeyPath ? { privateKeyPath } : {}),
      ...(env("APPLE_PASS_KEY_PASSWORD") ? { keyPassword: env("APPLE_PASS_KEY_PASSWORD") } : {}),
      publicUrl: publicUrl.replace(/\/+$/, ""),
      organizationName: env("WALLET_PASS_ORGANIZATION_NAME") ?? "feooh",
    },
  };
}

/** SMTP_HOST and MAIL_FROM, or neither. */
function smtpConfigOrNothing(): { smtp?: SmtpSettings } {
  const host = env("SMTP_HOST");
  const from = env("MAIL_FROM");
  if (!host && !from) return {};
  if (!host || !from) throw new ConfigError("Email is half set up: set SMTP_HOST and MAIL_FROM together.");
  const port = int("SMTP_PORT", 587);
  return {
    smtp: {
      host,
      port,
      secure: bool("SMTP_SECURE", port === 465),
      ...(env("SMTP_USER") ? { user: env("SMTP_USER") } : {}),
      ...(env("SMTP_PASSWORD") ? { password: env("SMTP_PASSWORD") } : {}),
      from,
      fromName: env("MAIL_FROM_NAME") ?? "POAP",
    },
  };
}

/** Redacted view, safe to log. */
export function describeConfig(cfg: AppConfig): Record<string, unknown> {
  return {
    endpoint: cfg.endpoint,
    fallbackEndpoints: cfg.fallbackEndpoints,
    network: cfg.network,
    issuerAddress: cfg.issuerAddress,
    issuerSeed: cfg.issuerSeed ? "[redacted]" : "[unset]",
    reward: {
      treasuryMasterKey: cfg.reward.treasuryMasterKey ? "[redacted]" : "[unset]",
      maxPerAttendeeXrp: cfg.reward.maxPerAttendeeXrp,
      feeBufferXrp: cfg.reward.feeBufferXrp,
    },
    near: cfg.near
      ? {
          network: cfg.near.network,
          rpcUrl: cfg.near.rpcUrl,
          contractId: cfg.near.contractId,
          minterAccountId: cfg.near.minterAccountId,
          minterPrivateKey: "[redacted]",
        }
      : "[unset]",
    walletPasses: cfg.walletPasses
      ? {
          source: cfg.walletPasses.p12Path ? "p12" : "pem",
          publicUrl: cfg.walletPasses.publicUrl,
          organizationName: cfg.walletPasses.organizationName,
          password: cfg.walletPasses.p12Password || cfg.walletPasses.keyPassword ? "[redacted]" : "[unset]",
        }
      : "[unset]",
    smtp: cfg.smtp
      ? { host: cfg.smtp.host, port: cfg.smtp.port, secure: cfg.smtp.secure, from: cfg.smtp.from, password: cfg.smtp.password ? "[redacted]" : "[unset]" }
      : "[unset]",
    pinata: { jwt: cfg.pinata.jwt ? "[redacted]" : "[unset]", gateway: cfg.pinata.gateway },
    xumm: {
      apiKey: cfg.xumm.apiKey ? "[redacted]" : "[unset]",
      apiSecret: cfg.xumm.apiSecret ? "[redacted]" : "[unset]",
    },
    databaseUrl: cfg.databaseUrl ? "[redacted]" : "[unset]",
    defaultMetadataUri: cfg.defaultMetadataUri ?? "[unset]",
    admin: {
      email: cfg.admin.email ?? "[unset]",
      passwordHash: cfg.admin.passwordHash ? "[redacted]" : "[unset]",
      sessionSecret: cfg.admin.sessionSecret ? "[redacted]" : "[unset]",
      sessionTtlHours: cfg.admin.sessionTtlHours,
    },
    demoEnabled: cfg.demoEnabled,
    eventName: cfg.eventName ?? "[unset]",
    sourceTag: cfg.sourceTag ?? "[unset]",
    badgeImageUriMode: cfg.badgeImageUriMode,
    badgeMetadataUriMode: cfg.badgeMetadataUriMode,
    badgeBaseUrl: cfg.badgeBaseUrl ?? "[unset]",
    api: cfg.api,
  };
}
