/**
 * A throwaway Pass Type ID certificate, issued by a throwaway "WWDR", for
 * tests that sign passes. Shaped like Apple's: "Pass Type ID: …" as the common
 * name, the team id as the OU. Keys from node's crypto (native, fast); the
 * certificates from node-forge.
 */
import { generateKeyPairSync } from "node:crypto";
import forge from "node-forge";

export const TEST_PASS_TYPE = "pass.test.poap";
export const TEST_TEAM = "TEAM123456";

function key(): forge.pki.rsa.KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return {
    privateKey: forge.pki.privateKeyFromPem(privateKey) as forge.pki.rsa.PrivateKey,
    publicKey: forge.pki.publicKeyFromPem(publicKey) as forge.pki.rsa.PublicKey,
  };
}

function certificate(
  subject: forge.pki.CertificateField[],
  issuer: forge.pki.CertificateField[],
  publicKey: forge.pki.PublicKey,
  signingKey: forge.pki.rsa.PrivateKey,
  serial: string,
  isCa = false,
): forge.pki.Certificate {
  const cert = forge.pki.createCertificate();
  if (isCa) {
    cert.setExtensions([
      { name: "basicConstraints", cA: true },
      { name: "keyUsage", keyCertSign: true, cRLSign: true, digitalSignature: true },
    ]);
  }
  cert.publicKey = publicKey;
  cert.serialNumber = serial;
  cert.validity.notBefore = new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 86_400_000);
  cert.setSubject(subject);
  cert.setIssuer(issuer);
  cert.sign(signingKey, forge.md.sha256.create());
  return cert;
}

export interface TestPassCertificate {
  certificatePem: string;
  /** Encrypted with `passphrase`, as tessera stores it. */
  encryptedKeyPem: string;
  passphrase: string;
  wwdrPem: string;
  /** A .p12 holding both, with `passphrase`. */
  p12: Buffer;
}

let cached: TestPassCertificate | undefined;

export function testPassCertificate(): TestPassCertificate {
  if (cached) return cached;
  const caKeys = key();
  const caName = [{ name: "commonName", value: "Test WWDR" }, { shortName: "OU", value: "G4" }];
  const wwdr = certificate(caName, caName, caKeys.publicKey, caKeys.privateKey, "01", true);

  const passKeys = key();
  const pass = certificate(
    [
      { name: "commonName", value: `Pass Type ID: ${TEST_PASS_TYPE}` },
      { shortName: "OU", value: TEST_TEAM },
      { name: "organizationName", value: "Test Org" },
    ],
    caName,
    passKeys.publicKey,
    caKeys.privateKey,
    "02",
  );

  const passphrase = "test-passphrase";
  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(passKeys.privateKey, [pass], passphrase, { algorithm: "3des" });
  cached = {
    certificatePem: forge.pki.certificateToPem(pass),
    encryptedKeyPem: forge.pki.encryptRsaPrivateKey(passKeys.privateKey, passphrase, { algorithm: "aes256" }),
    passphrase,
    wwdrPem: forge.pki.certificateToPem(wwdr),
    p12: Buffer.from(forge.asn1.toDer(p12Asn1).getBytes(), "binary"),
  };
  return cached;
}
