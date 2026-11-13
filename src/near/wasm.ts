/**
 * What a contract's wasm holds, read before it goes on chain.
 *
 * Two things are worth knowing before a deploy or an upgrade, and both are
 * cheaper to learn here than from a failed transaction or, worse, a
 * successful one:
 *
 *   - POST-MVP INSTRUCTIONS. The NEAR runtime accepts MVP WebAssembly only.
 *     Rust 1.82+ emits sign-extension operators and a padded `call_indirect`
 *     encoding unless std is rebuilt for the MVP (contracts/near-badges/
 *     build.sh). A module with either is refused at deploy time.
 *   - EXPORTS. An upgrade runs `migrate` on the new code, and the next upgrade
 *     needs `update_contract` on it. New code without them either fails to
 *     deploy (no `migrate`) or cannot be upgraded again by the owner (no
 *     `update_contract`).
 *
 * A reader of the binary format, not a validator: it walks the sections and
 * every function body's instructions, and reports what it finds.
 */

export interface WasmReport {
  exports: string[];
  /** One line per kind of post-MVP feature found, with a count. Empty for a clean module. */
  postMvp: string[];
}

class Reader {
  pos: number;
  constructor(
    readonly bytes: Uint8Array,
    start = 0,
    readonly end = bytes.length,
  ) {
    this.pos = start;
  }
  done(): boolean {
    return this.pos >= this.end;
  }
  byte(): number {
    if (this.pos >= this.end) throw new Error("wasm: unexpected end");
    return this.bytes[this.pos++] as number;
  }
  u32(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = this.byte();
      result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result >>> 0;
      shift += 7;
      if (shift > 35) throw new Error("wasm: LEB128 too long");
    }
  }
  /** Skips a signed LEB128 of any width. */
  sleb(): void {
    while (this.byte() & 0x80) {
      /* continue */
    }
  }
  skip(n: number): void {
    this.pos += n;
    if (this.pos > this.end) throw new Error("wasm: unexpected end");
  }
  name(): string {
    const len = this.u32();
    const s = Buffer.from(this.bytes.subarray(this.pos, this.pos + len)).toString("utf8");
    this.skip(len);
    return s;
  }
}

const MAGIC = [0x00, 0x61, 0x73, 0x6d];

export function inspectWasm(bytes: Uint8Array): WasmReport {
  if (bytes.length < 8 || MAGIC.some((b, i) => bytes[i] !== b)) throw new Error("not a wasm module");
  const r = new Reader(bytes, 8);
  const exports: string[] = [];
  const found = new Map<string, number>();
  const note = (what: string) => found.set(what, (found.get(what) ?? 0) + 1);

  while (!r.done()) {
    const id = r.byte();
    const size = r.u32();
    const start = r.pos;
    const s = new Reader(bytes, start, start + size);
    if (id === 7) {
      for (let n = s.u32(); n > 0; n--) {
        exports.push(s.name());
        s.byte(); // kind
        s.u32(); // index
      }
    } else if (id === 10) {
      for (let n = s.u32(); n > 0; n--) {
        const bodySize = s.u32();
        const body = new Reader(bytes, s.pos, s.pos + bodySize);
        for (let locals = body.u32(); locals > 0; locals--) {
          body.u32();
          body.byte();
        }
        scanBody(body, note);
        s.skip(bodySize);
      }
    } else if (id === 12) {
      note("data count section (bulk memory)");
    }
    r.pos = start + size;
  }

  return { exports, postMvp: [...found.entries()].map(([what, count]) => `${what} ×${count}`) };
}

/** The MVP opcodes that take no immediates. */
const NO_IMMEDIATES = (op: number): boolean =>
  op === 0x00 || op === 0x01 || op === 0x05 || op === 0x0b || op === 0x0f || op === 0x1a || op === 0x1b || (op >= 0x45 && op <= 0xbf);

function scanBody(r: Reader, note: (what: string) => void): void {
  while (!r.done()) {
    const op = r.byte();
    if (op === 0x02 || op === 0x03 || op === 0x04) {
      // MVP block types: empty (0x40) or one value type. Anything else is a
      // type index, which is multi-value.
      const bt = r.byte();
      if (bt !== 0x40 && !(bt >= 0x7c && bt <= 0x7f)) {
        note("multi-value block type");
        r.pos--;
        r.sleb();
      }
    } else if (op === 0x0c || op === 0x0d) r.u32();
    else if (op === 0x0e) {
      for (let n = r.u32(); n >= 0; n--) r.u32();
    } else if (op === 0x10) r.u32();
    else if (op === 0x11) {
      r.u32();
      // MVP: exactly one zero byte. A padded LEB (0x80 0x00) or a real table
      // index is the reference-types encoding NEAR refuses.
      if (r.byte() !== 0x00) {
        note("call_indirect with a table index (reference types)");
        r.pos--;
        r.u32();
      }
    } else if (op === 0x1c) {
      note("typed select (reference types)");
      for (let n = r.u32(); n > 0; n--) r.byte();
    } else if (op >= 0x20 && op <= 0x24) r.u32();
    else if (op === 0x25 || op === 0x26) {
      note("table.get/set (reference types)");
      r.u32();
    } else if (op >= 0x28 && op <= 0x3e) {
      r.u32();
      r.u32();
    } else if (op === 0x3f || op === 0x40) {
      if (r.byte() !== 0x00) note("memory index (multi-memory)");
    } else if (op === 0x41 || op === 0x42) r.sleb();
    else if (op === 0x43) r.skip(4);
    else if (op === 0x44) r.skip(8);
    else if (op >= 0xc0 && op <= 0xc4) note("sign-extension operator");
    else if (op >= 0xd0 && op <= 0xd2) {
      note("ref.* instruction (reference types)");
      if (op === 0xd0) r.byte();
      if (op === 0xd2) r.u32();
    } else if (op === 0xfc) {
      const sub = r.u32();
      note(sub <= 7 ? "saturating float-to-int" : "bulk memory / table instruction");
      // Immediates: 0–7 none; 8 memory.init (u32 + byte); 9 data.drop u32;
      // 10 memory.copy (2 bytes); 11 memory.fill (byte); 12 table.init (2 u32);
      // 13 elem.drop u32; 14 table.copy (2 u32); 15–17 u32.
      if (sub === 8) {
        r.u32();
        r.byte();
      } else if (sub === 9 || sub === 13 || (sub >= 15 && sub <= 17)) r.u32();
      else if (sub === 10) r.skip(2);
      else if (sub === 11) r.byte();
      else if (sub === 12 || sub === 14) {
        r.u32();
        r.u32();
      }
    } else if (op === 0xfd) {
      note("SIMD");
      return; // SIMD immediates vary; one is enough to refuse the module
    } else if (!NO_IMMEDIATES(op)) {
      // Exceptions, tail calls, GC and the rest: not MVP, and their immediates
      // are not worth decoding to refuse the module.
      note(`non-MVP opcode 0x${op.toString(16)}`);
      return;
    }
  }
}

/** Exports a badge contract must keep so it can be upgraded again. */
export const UPGRADE_EXPORTS = ["migrate", "update_contract", "version", "nft_mint"] as const;

/** Reasons this wasm should not go on chain as the badge contract; empty when it may. */
export function wasmProblems(bytes: Uint8Array): string[] {
  const report = inspectWasm(bytes);
  const problems = report.postMvp.map((p) => `post-MVP WebAssembly the NEAR runtime refuses: ${p}`);
  for (const name of UPGRADE_EXPORTS) {
    if (!report.exports.includes(name)) problems.push(`no \`${name}\` export`);
  }
  return problems;
}
