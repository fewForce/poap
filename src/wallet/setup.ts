/**
 * Building the Wallet pass service from the configuration: the certificate
 * read off disk, the bundled images, APNs, and SMTP when it is set up.
 * Startup fails loudly on a certificate that cannot sign, rather than the
 * first attendee finding out.
 */
import { readFileSync } from "node:fs";
import type { SmtpSettings, WalletPassConfig } from "../config.js";
import { ConfigError } from "../errors.js";
import type { AttendanceRepository, EventRepository, RegistrationRepository, WalletPassRepository } from "../types.js";
import { Http2ApnsGateway } from "./apns.js";
import { SmtpMailer } from "./mailer.js";
import { DEFAULT_PASS_STYLE, loadPassAssets } from "./pass.js";
import { passCertificateFromP12, passCertificateFromPem, signManifest, type PassCertificate } from "./signing.js";
import { WalletPassService, type WalletPassLogger } from "./service.js";

function read(path: string, what: string): Buffer {
  try {
    return readFileSync(path);
  } catch {
    throw new ConfigError(`Could not read ${what} at ${path}.`);
  }
}

export function loadPassCertificate(config: WalletPassConfig): PassCertificate {
  if (config.p12Path) return passCertificateFromP12(read(config.p12Path, "APPLE_PASS_P12_PATH"), config.p12Password ?? "");
  return passCertificateFromPem(
    read(config.certificatePath!, "APPLE_PASS_CERTIFICATE_PATH").toString("utf8"),
    read(config.privateKeyPath!, "APPLE_PASS_PRIVATE_KEY_PATH").toString("utf8"),
    config.keyPassword,
  );
}

const consoleLogger: WalletPassLogger = {
  info: (obj, msg) => console.log(`[wallet] ${msg}`, JSON.stringify(obj)),
  warn: (obj, msg) => console.warn(`[wallet] ${msg}`, JSON.stringify(obj, (_k, v: unknown) => (v instanceof Error ? v.message : v))),
};

export function createWalletPassService(input: {
  config: WalletPassConfig;
  smtp?: SmtpSettings;
  repo: WalletPassRepository;
  registrations: RegistrationRepository;
  events: EventRepository;
  attendance: AttendanceRepository;
  log?: WalletPassLogger;
}): WalletPassService {
  const certificate = loadPassCertificate(input.config);
  const assets = loadPassAssets();
  // A test signature now: a certificate that cannot sign fails the start, not the first pass.
  signManifest(Buffer.from("{}"), certificate, assets.wwdrPem);
  if (certificate.expiresAt.getTime() < Date.now()) {
    throw new ConfigError(`The Apple pass certificate expired on ${certificate.expiresAt.toISOString().slice(0, 10)}.`);
  }
  return new WalletPassService({
    repo: input.repo,
    registrations: input.registrations,
    events: input.events,
    attendance: input.attendance,
    assets,
    certificate,
    passTypeIdentifier: certificate.passTypeIdentifier,
    teamIdentifier: certificate.teamIdentifier,
    publicUrl: input.config.publicUrl,
    apns: new Http2ApnsGateway(certificate),
    ...(input.smtp ? { mailer: new SmtpMailer(input.smtp) } : {}),
    style: { ...DEFAULT_PASS_STYLE, organizationName: input.config.organizationName },
    log: input.log ?? consoleLogger,
  });
}

/** One line at startup saying what passes can do here. */
export function announceWalletPasses(service: WalletPassService | undefined, config: WalletPassConfig | undefined): void {
  if (!service || !config) {
    console.warn("[api] Apple Wallet passes: NOT CONFIGURED (APPLE_PASS_*). Registering makes no pass.");
    return;
  }
  const { email, updates } = service.capabilities;
  console.warn(
    `[api] Apple Wallet passes: ${service.passTypeIdentifier}, from ${config.publicUrl}. ` +
      (email ? "Emailed on registration. " : "Email NOT set up (SMTP_HOST, MAIL_FROM): download only. ") +
      (updates
        ? "Passes update themselves; the code changes on every desk scan."
        : "Passes do NOT update themselves: Wallet only calls an https address, so the code stays as issued."),
  );
}
