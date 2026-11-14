/**
 * Signing a pass: the Pass Type ID certificate, and the detached PKCS #7
 * signature over manifest.json that Apple Wallet checks before it adds a pass.
 *
 * The certificate comes as the PEM pair tessera keeps (certificate, and the
 * private key encrypted with a passphrase) or as the .p12 that Keychain Access
 * exports. Either way the pass type identifier and the team id are read off
 * the certificate itself, as tessera's Pkcs12Reader does, so they cannot
 * disagree with what signs.
 *
 * The key is held decrypted in memory only. Never log a PassCertificate.
 */
import { createPrivateKey, X509Certificate } from "node:crypto";
import forge from "node-forge";
import { ConfigError } from "../errors.js";

export interface PassCertificate {
  certificatePem: string;
  /** Unencrypted PKCS #8. In memory only. */
  privateKeyPem: string;
  /** e.g. pass.octodev.tessera — from the certificate's "Pass Type ID:" common name. */
  passTypeIdentifier: string;
  /** The 10-character Apple team id — the certificate's OU. */
  teamIdentifier: string;
  /** The certificate's O, e.g. Octo Development Inc. */
  organization: string | null;
  expiresAt: Date;
}

function subjectField(subject: string, field: string): string | null {
  for (const line of subject.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0 && line.slice(0, eq) === field) return line.slice(eq + 1);
  }
  return null;
}

function describe(certificatePem: string, privateKeyPem: string): PassCertificate {
  const cert = new X509Certificate(certificatePem);
  const cn = subjectField(cert.subject, "CN") ?? "";
  if (!cn.startsWith("Pass Type ID:")) {
    throw new ConfigError(`This is not a Pass Type ID certificate (its name is "${cn}").`);
  }
  const passTypeIdentifier = cn.slice("Pass Type ID:".length).trim();
  const teamIdentifier = subjectField(cert.subject, "OU") ?? "";
  if (!/^[A-Z0-9]{10}$/.test(teamIdentifier)) {
    throw new ConfigError(`The pass certificate carries no Apple team id (OU is "${teamIdentifier}").`);
  }
  const key = createPrivateKey(privateKeyPem);
  if (!cert.checkPrivateKey(key)) throw new ConfigError("The pass certificate's private key does not match it.");
  return {
    certificatePem,
    privateKeyPem,
    passTypeIdentifier,
    teamIdentifier,
    organization: subjectField(cert.subject, "O"),
    expiresAt: new Date(cert.validTo),
  };
}

/** The PEM pair, the key optionally encrypted with `passphrase`. */
export function passCertificateFromPem(certificatePem: string, privateKeyPem: string, passphrase?: string): PassCertificate {
  let plain: string;
  try {
    plain = createPrivateKey({ key: privateKeyPem, ...(passphrase ? { passphrase } : {}) })
      .export({ format: "pem", type: "pkcs8" })
      .toString();
  } catch {
    // Never echo the passphrase or the key.
    throw new ConfigError("The pass certificate's private key could not be read: check APPLE_PASS_KEY_PASSWORD.");
  }
  return describe(certificatePem, plain);
}

/**
 * A .p12 as Keychain Access exports it. node-forge reads the RC2 / 3DES these
 * files are still encrypted with, which OpenSSL 3 refuses by default (the
 * "legacy provider" note in tessera's docs/01-pass-signing.md).
 */
export function passCertificateFromP12(p12: Buffer, password: string): PassCertificate {
  let p12Asn1: forge.pkcs12.Pkcs12Pfx;
  try {
    p12Asn1 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(p12.toString("binary")), password);
  } catch {
    throw new ConfigError("The .p12 could not be opened: check APPLE_PASS_P12_PASSWORD.");
  }
  const bag = (oid: string | undefined) => (oid ? p12Asn1.getBags({ bagType: oid })[oid]?.[0] : undefined);
  const certBag = bag(forge.pki.oids.certBag);
  const keyBag = bag(forge.pki.oids.pkcs8ShroudedKeyBag) ?? bag(forge.pki.oids.keyBag);
  if (!certBag?.cert || !keyBag?.key) throw new ConfigError("The .p12 must hold the certificate and its private key.");
  return passCertificateFromPem(
    forge.pki.certificateToPem(certBag.cert),
    forge.pki.privateKeyInfoToPem(forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(keyBag.key as forge.pki.rsa.PrivateKey))),
  );
}

/**
 * The detached PKCS #7 signature over manifest.json, in DER: what goes in the
 * pass as `signature`. Chained to Apple's WWDR intermediate, as Wallet wants.
 */
export function signManifest(manifest: Buffer, cert: PassCertificate, wwdrPem: string, signingTime = new Date()): Buffer {
  const signer = forge.pki.certificateFromPem(cert.certificatePem);
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(manifest.toString("binary"));
  p7.addCertificate(signer);
  p7.addCertificate(forge.pki.certificateFromPem(wwdrPem));
  p7.addSigner({
    key: forge.pki.privateKeyFromPem(cert.privateKeyPem),
    certificate: signer,
    digestAlgorithm: forge.pki.oids.sha256!,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType!, value: forge.pki.oids.data! },
      { type: forge.pki.oids.messageDigest! },
      // forge's types say string; it takes the Date and encodes UTCTime.
      { type: forge.pki.oids.signingTime!, value: signingTime as unknown as string },
    ],
  });
  p7.sign({ detached: true });
  return Buffer.from(forge.asn1.toDer(p7.toAsn1()).getBytes(), "binary");
}
