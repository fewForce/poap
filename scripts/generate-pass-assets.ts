/**
 * Makes the images every Apple Wallet pass carries, into src/wallet/assets/:
 *
 *   icon.png  icon@2x.png  icon@3x.png   29, 58, 87 px square — the lock screen and notifications
 *   logo.png  logo@2x.png  logo@3x.png   at most 160×50 at 1x — top left of the pass
 *
 * From the POAP app's icon and the feooh wordmark, scaled with resvg (already
 * a dependency for badge art). The results are committed; run this again only
 * when those images change. The WWDR certificate beside them is Apple's own
 * public intermediate (tessera's resources/pass-assets/wwdr-g4.pem), the same
 * for every pass in the world.
 *
 * RUN:
 *   npx tsx scripts/generate-pass-assets.ts [--icon=path.png] [--logo=path.png]
 * Defaults to ../poap-wallet/assets/icon.png and ../poap-wallet/assets/feooh.png.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Resvg } from "@resvg/resvg-js";

function arg(name: string, fallback: string): string {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return resolve(hit ? hit.slice(name.length + 3) : fallback);
}

function pngSize(png: Buffer): { width: number; height: number } {
  // IHDR: width and height at bytes 16 and 20.
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function scaled(png: Buffer, width: number, height: number): Buffer {
  const href = `data:image/png;base64,${png.toString("base64")}`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<image xlink:href="${href}" x="0" y="0" width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet"/></svg>`;
  return Buffer.from(new Resvg(svg, { fitTo: { mode: "original" } }).render().asPng());
}

const out = resolve("src/wallet/assets");
mkdirSync(out, { recursive: true });

const icon = readFileSync(arg("icon", "../poap-wallet/assets/icon.png"));
for (const [name, size] of [["icon.png", 29], ["icon@2x.png", 58], ["icon@3x.png", 87]] as const) {
  writeFileSync(resolve(out, name), scaled(icon, size, size));
}

const logo = readFileSync(arg("logo", "../poap-wallet/assets/feooh.png"));
const { width, height } = pngSize(logo);
// Fit inside 160×50 at 1x, keeping the wordmark's proportions.
const scale = Math.min(160 / width, 50 / height);
const w1 = Math.round(width * scale);
const h1 = Math.round(height * scale);
for (const [name, k] of [["logo.png", 1], ["logo@2x.png", 2], ["logo@3x.png", 3]] as const) {
  writeFileSync(resolve(out, name), scaled(logo, w1 * k, h1 * k));
}

console.log(`wrote icon (29/58/87) and logo (${w1}×${h1} at 1x) to ${out}`);
