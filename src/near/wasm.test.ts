import { describe, expect, it } from "vitest";
import { inspectWasm, wasmProblems } from "./wasm.js";

/** A module with one `() -> ()` function, these exports, and this body (locals already declared). */
function module(body: number[], exports: string[] = []): Uint8Array {
  const section = (id: number, content: number[]) => [id, content.length, ...content];
  const name = (s: string) => [s.length, ...Buffer.from(s)];
  const fnBody = [0x00, ...body, 0x0b];
  return Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, [0x01, 0x60, 0x00, 0x00]),
    ...section(3, [0x01, 0x00]),
    ...section(7, [exports.length, ...exports.flatMap((e) => [...name(e), 0x00, 0x00])]),
    ...section(10, [0x01, fnBody.length, ...fnBody]),
  ]);
}

const KEEP = ["migrate", "update_contract", "version", "nft_mint"];

describe("inspectWasm", () => {
  it("reads the exports of a plain MVP module and finds nothing wrong", () => {
    // i32.const 1; drop; call_indirect type 0 table 0 (one zero byte)
    const bytes = module([0x41, 0x01, 0x1a, 0x41, 0x00, 0x11, 0x00, 0x00], KEEP);
    expect(inspectWasm(bytes)).toEqual({ exports: KEEP, postMvp: [] });
    expect(wasmProblems(bytes)).toEqual([]);
  });

  it("finds a sign-extension operator", () => {
    const report = inspectWasm(module([0x41, 0x01, 0xc0, 0x1a]));
    expect(report.postMvp).toEqual(["sign-extension operator ×1"]);
  });

  it("finds the padded call_indirect stable Rust emits", () => {
    const report = inspectWasm(module([0x41, 0x00, 0x11, 0x00, 0x80, 0x00]));
    expect(report.postMvp).toEqual(["call_indirect with a table index (reference types) ×1"]);
  });

  it("finds bulk memory", () => {
    // i32.const 0 ×3; memory.fill 0
    const report = inspectWasm(module([0x41, 0x00, 0x41, 0x00, 0x41, 0x00, 0xfc, 0x0b, 0x00]));
    expect(report.postMvp).toEqual(["bulk memory / table instruction ×1"]);
  });

  it("names the exports an upgrade cannot do without", () => {
    expect(wasmProblems(module([], ["nft_mint", "version"]))).toEqual(["no `migrate` export", "no `update_contract` export"]);
  });

  it("refuses something that is not wasm at all", () => {
    expect(() => inspectWasm(Buffer.from('{"code":"oops"}'))).toThrow(/not a wasm module/);
  });
});
