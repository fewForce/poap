/**
 * The pieces of a pass, on their own: the zip, pass.json, the QR's code, the
 * certificate and the signature. Nothing touches a network.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import forge from "node-forge";
import { describe, expect, it } from "vitest";
import { testPassCertificate, TEST_PASS_TYPE, TEST_TEAM } from "../../test/helpers/pass-certificate.js";
import type { EventRecord, RegistrationRecord, WalletPassRecord } from "../types.js";
import {
  buildPassJson,
  buildPkpass,
  loadPassAssets,
  passCode,
  PASS_CODE_PREFIX,
  sha1Hex,
  tokenFromPassCode,
  type PassContent,
} from "./pass.js";
import { passCertificateFromP12, passCertificateFromPem, signManifest } from "./signing.js";
import { crc32, unzipStored, zipStored } from "./zip.js";

const TOKEN = "tok_abcdefghijklmnopqrstuvwxyz012345";

function content(overrides: Partial<WalletPassRecord> = {}, event: Partial<EventRecord> = {}): PassContent {
  const pass: WalletPassRecord = {
    id: "1",
    registrationId: "7",
    eventId: 9101,
    serialNumber: "0b6d3a2e-1c5f-4f9a-9a57-2d4f6b8e1c00",
    authenticationToken: TOKEN,
    previousAuthenticationToken: null,
    downloadKey: "dl_abcdefghijklmnopqrstuv",
    status: "issued",
    issuedAt: new Date(),
    suspendedAt: null,
    revokedAt: null,
    expiredAt: null,
    deliveredAt: null,
    deliveryError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  const registration: RegistrationRecord = {
    id: "7",
    eventId: 9101,
    address: "d67f283fd3a5b2911ded6855cbb6307e74947cf2ce4ad3a3cb972cbb3e230ce5",
    addressProof: "near_signature",
    displayName: "Ada Lovelace",
    email: "ada@example.com",
  };
  return {
    pass,
    registration,
    event: { eventId: 9101, name: "NEAR Testnet Night", status: "live", chain: "near", eventDate: "2026-11-20", venue: "Toronto", ...event },
    badgeIssued: false,
  };
}

const identity = { passTypeIdentifier: TEST_PASS_TYPE, teamIdentifier: TEST_TEAM };

describe("the zip", () => {
  it("round-trips flat entries byte for byte", () => {
    const files = [
      { name: "pass.json", data: Buffer.from('{"a":1}') },
      { name: "icon.png", data: Buffer.from([0, 1, 2, 255]) },
    ];
    const back = unzipStored(zipStored(files));
    expect([...back.keys()]).toEqual(["pass.json", "icon.png"]);
    expect(back.get("icon.png")).toEqual(Buffer.from([0, 1, 2, 255]));
  });

  it("computes the standard CRC-32", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });

  it("is a zip the system's unzip reads", () => {
    const dir = mkdtempSync(join(tmpdir(), "pkpass-"));
    writeFileSync(join(dir, "t.zip"), zipStored([{ name: "pass.json", data: Buffer.from("{}") }]));
    const listing = execFileSync("unzip", ["-l", join(dir, "t.zip")]).toString();
    expect(listing).toContain("pass.json");
  });

  it("refuses a nested path", () => {
    expect(() => zipStored([{ name: "a/b.png", data: Buffer.alloc(1) }])).toThrow(/flat/);
  });
});

describe("the pass's code", () => {
  it("prefixes the token so the desk can tell a pass from an address", () => {
    expect(passCode(TOKEN)).toBe(`${PASS_CODE_PREFIX}${TOKEN}`);
    expect(tokenFromPassCode(` ${passCode(TOKEN)} `)).toBe(TOKEN);
  });

  it("reads nothing else as a pass", () => {
    expect(tokenFromPassCode("rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe")).toBeNull();
    expect(tokenFromPassCode("POAP-PASS:short")).toBeNull();
    expect(tokenFromPassCode("POAP-PASS:has spaces in it here ok")).toBeNull();
  });
});

describe("pass.json", () => {
  it("is an event ticket with the event, the attendee and the QR", () => {
    const json = buildPassJson(content(), identity) as Record<string, any>;
    expect(json).toMatchObject({ formatVersion: 1, passTypeIdentifier: TEST_PASS_TYPE, teamIdentifier: TEST_TEAM, voided: false });
    expect(json.serialNumber).toBe("0b6d3a2e-1c5f-4f9a-9a57-2d4f6b8e1c00");
    expect(json.eventTicket.primaryFields[0].value).toBe("NEAR Testnet Night");
    expect(json.eventTicket.secondaryFields[0].value).toBe("Ada Lovelace");
    expect(json.eventTicket.headerFields[0]).toMatchObject({ label: "BADGE", value: "At the desk" });
    expect(json.barcodes[0]).toMatchObject({ format: "PKBarcodeFormatQR", message: passCode(TOKEN) });
    expect(json.backgroundColor).toMatch(/^rgb\(/);
  });

  it("names the web service only when it is https", () => {
    const plain = buildPassJson(content(), identity) as Record<string, any>;
    expect(plain.webServiceURL).toBeUndefined();
    expect(plain.authenticationToken).toBeUndefined();
    const live = buildPassJson(content(), { ...identity, webServiceUrl: "https://poap.example/api/passes/" }) as Record<string, any>;
    expect(live).toMatchObject({ webServiceURL: "https://poap.example/api/passes/", authenticationToken: TOKEN });
  });

  it("says when the badge is issued", () => {
    const json = buildPassJson({ ...content(), badgeIssued: true }, identity) as Record<string, any>;
    expect(json.eventTicket.headerFields[0]).toMatchObject({ value: "Issued" });
  });

  it("marks a suspended pass and voids a revoked or expired one", () => {
    const suspended = buildPassJson(content({ status: "suspended" }), identity) as Record<string, any>;
    expect(suspended.voided).toBe(false);
    expect(suspended.eventTicket.headerFields[0]).toMatchObject({ label: "STATUS", value: "SUSPENDED" });
    for (const status of ["revoked", "expired"] as const) {
      const json = buildPassJson(content({ status }), identity) as Record<string, any>;
      expect(json.voided).toBe(true);
      expect(json.eventTicket.headerFields[0].value).toBe(status.toUpperCase());
    }
  });

  it("names the account the way its chain does", () => {
    const near = buildPassJson(content(), identity) as Record<string, any>;
    expect(near.eventTicket.backFields.find((f: any) => f.key === "account").label).toBe("NEAR ACCOUNT");
    const xrpl = buildPassJson(content({}, { chain: "xrpl" }), identity) as Record<string, any>;
    expect(xrpl.eventTicket.backFields.find((f: any) => f.key === "account").label).toBe("XRPL ADDRESS");
  });
});

describe("the certificate", () => {
  it("reads the pass type and team off the PEM pair, decrypting the key", () => {
    const t = testPassCertificate();
    const cert = passCertificateFromPem(t.certificatePem, t.encryptedKeyPem, t.passphrase);
    expect(cert).toMatchObject({ passTypeIdentifier: TEST_PASS_TYPE, teamIdentifier: TEST_TEAM, organization: "Test Org" });
    expect(cert.privateKeyPem).toContain("BEGIN PRIVATE KEY");
  });

  it("reads a .p12", () => {
    const t = testPassCertificate();
    expect(passCertificateFromP12(t.p12, t.passphrase).passTypeIdentifier).toBe(TEST_PASS_TYPE);
  });

  it("refuses a wrong passphrase without echoing it", () => {
    const t = testPassCertificate();
    expect(() => passCertificateFromPem(t.certificatePem, t.encryptedKeyPem, "nope")).toThrow(/APPLE_PASS_KEY_PASSWORD/);
    expect(() => passCertificateFromP12(t.p12, "nope")).toThrow(/APPLE_PASS_P12_PASSWORD/);
  });

  it("refuses a certificate that is not a Pass Type ID", () => {
    const t = testPassCertificate();
    // The WWDR stand-in is a perfectly good certificate of the wrong kind.
    expect(() => passCertificateFromPem(t.wwdrPem, t.encryptedKeyPem, t.passphrase)).toThrow(/not a Pass Type ID/);
  });
});

describe("the signed bundle", () => {
  it("holds pass.json, the images, a manifest of their SHA-1s and a detached signature over it", () => {
    const t = testPassCertificate();
    const cert = passCertificateFromPem(t.certificatePem, t.encryptedKeyPem, t.passphrase);
    const assets = { ...loadPassAssets(), wwdrPem: t.wwdrPem };
    const files = unzipStored(buildPkpass(content(), identity, assets, cert));

    for (const name of ["pass.json", "manifest.json", "signature", "icon.png", "icon@2x.png", "logo.png", "thumbnail.png"]) {
      expect(files.has(name), name).toBe(true);
    }
    const manifest = JSON.parse(files.get("manifest.json")!.toString()) as Record<string, string>;
    for (const [name, hash] of Object.entries(manifest)) expect(sha1Hex(files.get(name)!), name).toBe(hash);
    expect(Object.keys(manifest)).not.toContain("signature");

    const p7 = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(files.get("signature")!.toString("binary"))) as any;
    expect(p7.certificates).toHaveLength(2);
    // The signed digest is the manifest's.
    const digestAttr = p7.rawCapture.authenticatedAttributes.find(
      (a: any) => forge.asn1.derToOid(a.value[0].value) === forge.pki.oids.messageDigest,
    );
    const signedDigest = Buffer.from(digestAttr.value[1].value[0].value, "binary").toString("hex");
    expect(signedDigest).toBe(createHash("sha256").update(files.get("manifest.json")!).digest("hex"));
  });

  it("verifies with OpenSSL against the manifest", () => {
    const t = testPassCertificate();
    const cert = passCertificateFromPem(t.certificatePem, t.encryptedKeyPem, t.passphrase);
    const manifest = Buffer.from('{"pass.json":"0000"}');
    const dir = mkdtempSync(join(tmpdir(), "sig-"));
    writeFileSync(join(dir, "manifest.json"), manifest);
    writeFileSync(join(dir, "signature"), signManifest(manifest, cert, t.wwdrPem));
    writeFileSync(join(dir, "ca.pem"), t.wwdrPem);
    const out = execFileSync(
      "openssl",
      ["cms", "-verify", "-binary", "-inform", "DER", "-in", join(dir, "signature"), "-content", join(dir, "manifest.json"), "-CAfile", join(dir, "ca.pem"), "-purpose", "any"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    expect(out.toString()).toBe(manifest.toString());
  });

  it("can be built unsigned, for tests only", () => {
    const files = unzipStored(buildPkpass(content(), identity, loadPassAssets(), undefined));
    expect(files.has("signature")).toBe(false);
  });
});
