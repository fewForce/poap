/**
 * Building a pass: pass.json from the registration, its event and where the
 * badge is, then the bundle Apple Wallet installs — pass.json, the images,
 * manifest.json (SHA-1 of every file) and the signature over the manifest —
 * zipped as a .pkpass. The same steps as tessera's WalletPassService, as an
 * event ticket rather than a generic card.
 *
 * Nothing here touches a store or the network: the caller hands in what the
 * pass should say, and gets bytes back.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderBadgeArt } from "../metadata/badge-art.js";
import { svgToPng } from "../metadata/rasterise.js";
import type { EventRecord, RegistrationRecord, WalletPassRecord } from "../types.js";
import { signManifest, type PassCertificate } from "./signing.js";
import { zipStored } from "./zip.js";

/** What the pass's QR carries before the token, so the desk can tell a pass from an address. */
export const PASS_CODE_PREFIX = "POAP-PASS:";

export const PKPASS_CONTENT_TYPE = "application/vnd.apple.pkpass";

export interface PassStyle {
  /** Shown on the lock screen and in notifications. */
  organizationName: string;
  backgroundColor: string;
  foregroundColor: string;
  labelColor: string;
}

export const DEFAULT_PASS_STYLE: PassStyle = {
  organizationName: "feooh",
  backgroundColor: "#faf9f7",
  foregroundColor: "#1c1b1a",
  labelColor: "#57544f",
};

export interface PassContent {
  pass: WalletPassRecord;
  registration: RegistrationRecord;
  event: EventRecord;
  /** True once the attendee's badge is recorded. */
  badgeIssued: boolean;
}

export interface PassIdentity {
  passTypeIdentifier: string;
  teamIdentifier: string;
  /**
   * `https://…/api/passes/` — where the phone asks for updates. Only an https
   * address: Wallet refuses a pass whose webServiceURL is http or localhost,
   * so without one the pass installs but never updates.
   */
  webServiceUrl?: string;
}

const STATUS_WORD: Partial<Record<WalletPassRecord["status"], string>> = {
  suspended: "SUSPENDED",
  revoked: "REVOKED",
  expired: "EXPIRED",
};

function rgb(hex: string, factor = 1): string {
  const h = hex.replace(/^#/, "");
  const full = h.length === 3 ? h.replace(/./g, (c) => c + c) : h;
  const n = (i: number) => Math.round(parseInt(full.slice(i, i + 2), 16) * factor);
  return `rgb(${n(0)}, ${n(2)}, ${n(4)})`;
}

function chainName(event: EventRecord): string {
  return event.chain === "near" ? "NEAR" : "XRP Ledger";
}

export function passCode(token: string): string {
  return `${PASS_CODE_PREFIX}${token}`;
}

/** The token out of a scanned code, or null when the code is not a pass. */
export function tokenFromPassCode(code: string): string | null {
  const t = code.trim();
  if (!t.startsWith(PASS_CODE_PREFIX)) return null;
  const token = t.slice(PASS_CODE_PREFIX.length);
  return /^[A-Za-z0-9_-]{16,128}$/.test(token) ? token : null;
}

export function buildPassJson(content: PassContent, identity: PassIdentity, style: PassStyle = DEFAULT_PASS_STYLE): Record<string, unknown> {
  const { pass, registration, event, badgeIssued } = content;
  const statusWord = STATUS_WORD[pass.status];
  const inactive = statusWord !== undefined;
  const voided = pass.status === "revoked" || pass.status === "expired";

  const headerFields = [
    statusWord
      ? { key: "status", label: "STATUS", value: statusWord }
      : { key: "badge", label: "BADGE", value: badgeIssued ? "Issued" : "At the desk" },
  ];

  const secondaryFields: Array<Record<string, unknown>> = [
    { key: "name", label: "NAME", value: registration.displayName?.trim() || "Attendee" },
  ];
  if (event.eventDate && /^\d{4}-\d{2}-\d{2}$/.test(event.eventDate)) {
    secondaryFields.push({
      key: "date",
      label: "DATE",
      value: `${event.eventDate}T12:00:00Z`,
      dateStyle: "PKDateStyleMedium",
      timeStyle: "PKDateStyleNone",
      ignoresTimeZone: true,
    });
  }

  const auxiliaryFields: Array<Record<string, unknown>> = [];
  if (event.venue?.trim()) auxiliaryFields.push({ key: "venue", label: "VENUE", value: event.venue.trim() });
  auxiliaryFields.push({ key: "chain", label: "BADGE ON", value: chainName(event) });

  const backFields: Array<Record<string, unknown>> = [
    {
      key: "how",
      label: "AT THE DESK",
      value:
        "Show this pass. The volunteer scans it and your badge is issued to the account below. " +
        "The code changes after every scan, so a screenshot of it will not work.",
    },
    { key: "account", label: event.chain === "near" ? "NEAR ACCOUNT" : "XRPL ADDRESS", value: registration.address },
    { key: "event", label: "EVENT", value: `${event.name} (${event.eventId})` },
  ];
  if (event.description?.trim()) backFields.push({ key: "about", label: "ABOUT", value: event.description.trim() });

  const json: Record<string, unknown> = {
    formatVersion: 1,
    passTypeIdentifier: identity.passTypeIdentifier,
    teamIdentifier: identity.teamIdentifier,
    serialNumber: pass.serialNumber,
    organizationName: style.organizationName,
    description: `${event.name} attendance pass`,
    logoText: "POAP",
    backgroundColor: rgb(style.backgroundColor, inactive ? 0.55 : 1),
    foregroundColor: rgb(inactive ? "#ffffff" : style.foregroundColor),
    labelColor: rgb(inactive ? "#e8e6e1" : style.labelColor),
    eventTicket: { headerFields, primaryFields: [{ key: "event", label: "EVENT", value: event.name }], secondaryFields, auxiliaryFields, backFields },
    barcodes: [
      {
        format: "PKBarcodeFormatQR",
        message: passCode(pass.authenticationToken),
        messageEncoding: "iso-8859-1",
        altText: "Show at the desk",
      },
    ],
    voided,
    sharingProhibited: true,
  };
  if (identity.webServiceUrl) {
    json.webServiceURL = identity.webServiceUrl;
    json.authenticationToken = pass.authenticationToken;
  }
  return json;
}

const HERE = dirname(fileURLToPath(import.meta.url));

/** src/wallet/assets, or dist/wallet/assets once built; the source tree as a last resort. */
export function passAssetsDir(): string {
  const candidates = [resolve(HERE, "assets"), resolve(process.cwd(), "src/wallet/assets")];
  const found = candidates.find((dir) => existsSync(resolve(dir, "icon.png")));
  if (!found) throw new Error(`Wallet pass images not found. Looked in: ${candidates.join(", ")}`);
  return found;
}

export interface PassAssets {
  images: Map<string, Buffer>;
  wwdrPem: string;
}

export function loadPassAssets(dir = passAssetsDir()): PassAssets {
  const images = new Map<string, Buffer>();
  for (const name of readdirSync(dir)) {
    if (name.endsWith(".png")) images.set(name, readFileSync(resolve(dir, name)));
  }
  return { images, wwdrPem: readFileSync(resolve(dir, "wwdr-g4.pem"), "utf8") };
}

/** The attendee's own badge art, small, for the pass face: the same picture the badge carries. */
function thumbnails(content: PassContent): Array<{ name: string; data: Buffer }> {
  const { svg } = renderBadgeArt({
    address: content.registration.address,
    eventId: content.event.eventId,
    eventName: content.event.name.slice(0, 40),
    ...(content.event.chain === "near" ? { chain: "near" as const } : {}),
  });
  return [
    { name: "thumbnail.png", data: svgToPng(svg, { width: 90 }) },
    { name: "thumbnail@2x.png", data: svgToPng(svg, { width: 180 }) },
    { name: "thumbnail@3x.png", data: svgToPng(svg, { width: 270 }) },
  ];
}

export function sha1Hex(data: Uint8Array): string {
  return createHash("sha1").update(data).digest("hex");
}

/**
 * The .pkpass. Unsigned when `certificate` is absent, which only a local test
 * should ever do: Wallet refuses an unsigned pass.
 */
export function buildPkpass(
  content: PassContent,
  identity: PassIdentity,
  assets: PassAssets,
  certificate: PassCertificate | undefined,
  style: PassStyle = DEFAULT_PASS_STYLE,
): Buffer {
  const files: Array<{ name: string; data: Buffer }> = [
    { name: "pass.json", data: Buffer.from(JSON.stringify(buildPassJson(content, identity, style), null, 2), "utf8") },
    ...[...assets.images.entries()].map(([name, data]) => ({ name, data })),
    ...thumbnails(content),
  ];
  const manifest: Record<string, string> = {};
  for (const f of files) manifest[f.name] = sha1Hex(f.data);
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");
  files.push({ name: "manifest.json", data: manifestBytes });
  if (certificate) files.push({ name: "signature", data: signManifest(manifestBytes, certificate, assets.wwdrPem) });
  return zipStored(files);
}
