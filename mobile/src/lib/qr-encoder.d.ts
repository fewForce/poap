/** A QR code as a square of modules: 1 is dark, 0 is light. */
export interface QrMatrix {
  size: number;
  modules: Uint8Array;
  version: number;
}

/** Encode text as a QR code. Throws above version 10 (about 213 bytes). */
export function encodeQr(text: string): QrMatrix;

/** How many bytes a version can hold at error correction M. */
export function qrCapacity(version: number): number;
