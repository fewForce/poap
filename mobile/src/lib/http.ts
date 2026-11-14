/**
 * The one place the app talks to poap.live.
 *
 * Every response body is JSON, and every failure is an ApiError carrying the
 * server's own words: the API writes messages for people, so the screens show
 * them rather than inventing their own.
 *
 * Only public routes are called — the same ones poap.live's own pages call —
 * so there is nothing to sign in to and no token to keep.
 */

import { apiBase, SERVERS, server } from "./server";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    /** `details` from the server, when it gave any. */
    readonly details?: Record<string, unknown>,
    /** The whole response body, for the answers that carry more than an error. */
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** The server could not be reached at all. */
  get offline(): boolean {
    return this.status === 0;
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
}

export async function request<T>(method: string, path: string, opts: { body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.body !== undefined) headers["content-type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(apiBase() + path, {
      method,
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
  } catch {
    throw new ApiError(`We can't reach ${SERVERS[server()].host}. Check your connection and try again.`, 0, "OFFLINE");
  }

  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  if (!res.ok) {
    const e = (json as ErrorBody | null)?.error;
    throw new ApiError(
      e?.message ?? "Something went wrong. Try again in a moment.",
      res.status,
      e?.code ?? "HTTP_" + res.status,
      e?.details,
      json,
    );
  }
  return json as T;
}

/** A path the server gave us (`/badge/...`), made absolute for an <Image>. */
export function absolute(path: string): string {
  return /^https?:\/\//.test(path) ? path : apiBase() + path;
}
