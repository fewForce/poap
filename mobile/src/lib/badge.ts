/**
 * What a badge says about itself: the metadata its NFTokenMint URI points at.
 *
 * poap.live's badges point at https://poap.live/badge/<event>/<address>.json —
 * a name, a description, the artwork and a list of traits (XLS-24d). Older
 * badges may point at ipfs://, read here through a public gateway.
 *
 * Read-only and best effort: a badge whose metadata cannot be fetched is still
 * a badge, and the screen falls back to the art poap.live renders for it.
 */

export interface BadgeTrait {
  /** The trait's own name, e.g. event_name. */
  key: string;
  label: string;
  value: string;
}

export interface BadgeContents {
  name: string | null;
  description: string | null;
  /** The artwork, https only. */
  image: string | null;
  traits: BadgeTrait[];
}

const GATEWAY = "https://ipfs.io/ipfs/";
const TIMEOUT_MS = 10_000;

/** poap.live's trait names, in words. Anything else is shown with its own name, tidied. */
const LABELS: Record<string, string> = {
  event_name: "Event",
  event_id: "Event number",
  event_date: "Date",
  venue: "Venue",
  attendee: "Holder",
  art_palette: "Palette",
  art_core: "Core",
  art_traces: "Traces",
  art_density: "Density",
};

function label(trait: string): string {
  const known = LABELS[trait];
  if (known) return known;
  const words = trait.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Trait";
}

function httpsUrl(uri: string): string | null {
  if (uri.startsWith("ipfs://")) return GATEWAY + uri.slice("ipfs://".length).replace(/^ipfs\//, "");
  return /^https:\/\/\S+$/.test(uri) ? uri : null;
}

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export async function badgeContents(uri: string): Promise<BadgeContents> {
  const url = httpsUrl(uri);
  if (!url) throw new Error("This badge's details are not at a web address.");
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: abort.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`The badge's details did not load (${res.status}).`);
    const doc = (await res.json()) as Record<string, unknown>;
    const traits = Array.isArray(doc.attributes)
      ? doc.attributes.flatMap((a: unknown) => {
          const t = a as { trait_type?: unknown; value?: unknown };
          const value = typeof t.value === "number" ? String(t.value) : text(t.value);
          const name = text(t.trait_type);
          return name && value ? [{ key: name, label: label(name), value }] : [];
        })
      : [];
    const image = text(doc.image);
    return {
      name: text(doc.name),
      description: text(doc.description),
      image: image ? httpsUrl(image) : null,
      traits,
    };
  } finally {
    clearTimeout(timer);
  }
}
