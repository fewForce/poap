/**
 * Telling a phone its pass changed: an empty push through Apple's push
 * service (APNs), after which Wallet asks the web service for the new pass.
 *
 * As in tessera (docs/03-rotating-tokens.md): HTTP/2, authenticated with the
 * pass's own certificate, the topic is the pass type identifier, and always
 * the production endpoint — Pass Type ID certificates have no sandbox.
 */
import { connect, type ClientHttp2Session } from "node:http2";
import type { PassCertificate } from "./signing.js";

export interface ApnsResult {
  /** 200 when Apple took it. Null when Apple never answered. */
  statusCode: number | null;
  reason: string | null;
}

export interface ApnsGateway {
  /** Pushes to every token over one connection. Never throws: each result says what happened. */
  pushAll(pushTokens: string[]): Promise<Map<string, ApnsResult>>;
}

export const APNS_PRODUCTION = "https://api.push.apple.com";
const TIMEOUT_MS = 10_000;

export class Http2ApnsGateway implements ApnsGateway {
  constructor(
    private readonly certificate: PassCertificate,
    private readonly origin: string = APNS_PRODUCTION,
  ) {}

  async pushAll(pushTokens: string[]): Promise<Map<string, ApnsResult>> {
    const results = new Map<string, ApnsResult>();
    const tokens = [...new Set(pushTokens)].filter((t) => {
      // A token goes into the request path: hex only.
      const ok = /^[0-9a-fA-F]{8,200}$/.test(t);
      if (!ok) results.set(t, { statusCode: null, reason: "MalformedToken" });
      return ok;
    });
    if (tokens.length === 0) return results;

    let session: ClientHttp2Session;
    try {
      session = connect(this.origin, { cert: this.certificate.certificatePem, key: this.certificate.privateKeyPem });
    } catch (err) {
      for (const t of tokens) results.set(t, { statusCode: null, reason: (err as Error).message });
      return results;
    }
    session.on("error", () => undefined);
    try {
      await Promise.all(tokens.map(async (t) => results.set(t, await this.pushOne(session, t))));
    } finally {
      session.close();
    }
    return results;
  }

  private pushOne(session: ClientHttp2Session, token: string): Promise<ApnsResult> {
    return new Promise((resolveResult) => {
      let settled = false;
      const done = (r: ApnsResult) => {
        if (!settled) {
          settled = true;
          resolveResult(r);
        }
      };
      let req;
      try {
        req = session.request({
          ":method": "POST",
          ":path": `/3/device/${token}`,
          "apns-topic": this.certificate.passTypeIdentifier,
          "content-type": "application/json",
        });
      } catch (err) {
        done({ statusCode: null, reason: (err as Error).message });
        return;
      }
      let status: number | null = null;
      let body = "";
      req.setTimeout(TIMEOUT_MS, () => {
        req.close();
        done({ statusCode: null, reason: "Timeout" });
      });
      req.on("response", (headers) => {
        status = Number(headers[":status"]) || null;
      });
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => {
        body += chunk;
      });
      req.on("end", () => {
        let reason: string | null = null;
        if (status !== 200 && body) {
          try {
            reason = (JSON.parse(body) as { reason?: string }).reason ?? null;
          } catch {
            reason = body.slice(0, 200);
          }
        }
        done({ statusCode: status, reason });
      });
      req.on("error", (err) => done({ statusCode: status, reason: err.message }));
      req.end("{}");
    });
  }
}
