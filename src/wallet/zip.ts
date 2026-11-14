/**
 * The smallest zip writer a .pkpass needs: flat, stored (no compression),
 * names in UTF-8. Apple Wallet reads stored entries, and pass files are a
 * few kilobytes of PNG and JSON that would not compress anyway.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 1980-01-01 00:00: zip has no time zones, and a fixed stamp keeps the bytes reproducible. */
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
/** Bit 11: the file name is UTF-8. */
const FLAGS = 0x0800;

export function zipStored(files: Array<{ name: string; data: Uint8Array }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    if (file.name.includes("/") || file.name.includes("\\")) throw new Error(`zip entries are flat: ${file.name}`);
    const name = Buffer.from(file.name, "utf8");
    const data = Buffer.from(file.data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0
    local.writeUInt16LE(FLAGS, 6);
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(FLAGS, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, ...centrals, end]);
}

/** Reads back what zipStored() wrote. For tests and for checking a pass before it is sent. */
export function unzipStored(zip: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let p = 0;
  while (p + 4 <= zip.length && zip.readUInt32LE(p) === 0x04034b50) {
    const method = zip.readUInt16LE(p + 8);
    if (method !== 0) throw new Error("only stored entries are read");
    const size = zip.readUInt32LE(p + 18);
    const nameLength = zip.readUInt16LE(p + 26);
    const extraLength = zip.readUInt16LE(p + 28);
    const name = zip.subarray(p + 30, p + 30 + nameLength).toString("utf8");
    const start = p + 30 + nameLength + extraLength;
    out.set(name, zip.subarray(start, start + size));
    p = start + size;
  }
  return out;
}
