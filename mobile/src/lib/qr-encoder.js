/* eslint-disable */
/**
 * The QR encoder from poap.live's attendee pass (src/api/public/attend.html in
 * the poap repo), carried over unchanged so the app draws exactly the code the
 * web pass draws for the same address. Byte mode, error correction M, versions
 * 1 to 10 — an XRPL address lands in version 2 or 3.
 *
 * Kept as plain JavaScript on purpose: a re-typed copy would be a second
 * encoder to keep in step with the first. Types are in qr-encoder.d.ts.
 */
var QR = (function () {

    /* ---- GF(256), primitive polynomial x^8+x^4+x^3+x^2+1 (0x11d) ---- */
    var EXP = new Uint8Array(512);
    var LOG = new Uint8Array(256);
    (function () {
      var x = 1;
      for (var i = 0; i < 255; i++) {
        EXP[i] = x;
        LOG[x] = i;
        x <<= 1;
        if (x & 0x100) x ^= 0x11d;
      }
      for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
    })();
    function mul(a, b) { return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]; }

    /* ---- ISO/IEC 18004 block structure, error-correction level M only.
       [totalCodewords, ecPerBlock, blocks1, dataPerBlock1, blocks2, dataPerBlock2] ---- */
    var SPEC = [
      null,
      [26, 10, 1, 16, 0, 0],
      [44, 16, 1, 28, 0, 0],
      [70, 26, 1, 44, 0, 0],
      [100, 18, 2, 32, 0, 0],
      [134, 24, 2, 43, 0, 0],
      [172, 16, 4, 27, 0, 0],
      [196, 18, 4, 31, 0, 0],
      [242, 22, 2, 38, 2, 39],
      [292, 22, 3, 36, 2, 37],
      [346, 26, 4, 43, 1, 44]
    ];
    var ALIGN = [
      null, [], [6, 18], [6, 22], [6, 26], [6, 30],
      [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]
    ];
    var MAX_VERSION = 10;

    function capacityBytes(version) {
      var s = SPEC[version];
      var dataCodewords = s[2] * s[3] + s[4] * s[5];
      var headerBits = 4 + (version < 10 ? 8 : 16);
      return Math.floor((dataCodewords * 8 - headerBits) / 8);
    }

    function utf8Bytes(str) {
      if (typeof TextEncoder === "function") return new TextEncoder().encode(str);
      var out = [];
      for (var i = 0; i < str.length; i++) {
        var c = str.charCodeAt(i);
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
        else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
      return new Uint8Array(out);
    }

    /* ---- Reed-Solomon ---- */
    function generatorPoly(degree) {
      var poly = [1];
      for (var d = 0; d < degree; d++) {
        var next = new Array(poly.length + 1);
        for (var k = 0; k < next.length; k++) next[k] = 0;
        for (var i = 0; i < poly.length; i++) {
          next[i] ^= poly[i];
          next[i + 1] ^= mul(poly[i], EXP[d]);
        }
        poly = next;
      }
      return poly;
    }
    function ecFor(block, ecLen) {
      var gen = generatorPoly(ecLen);
      var buf = new Uint8Array(block.length + ecLen);
      buf.set(block, 0);
      for (var i = 0; i < block.length; i++) {
        var factor = buf[i];
        if (factor === 0) continue;
        for (var j = 0; j < gen.length; j++) buf[i + j] ^= mul(gen[j], factor);
      }
      return buf.subarray(block.length);
    }

    /* ---- header + payload + padding, split into blocks, interleaved ---- */
    function codewords(bytes, version) {
      var s = SPEC[version];
      var ecLen = s[1], b1 = s[2], d1 = s[3], b2 = s[4], d2 = s[5];
      var blockCount = b1 + b2;
      var dataCodewords = b1 * d1 + b2 * d2;

      var bits = [];
      function push(value, len) {
        for (var i = len - 1; i >= 0; i--) bits.push((value >> i) & 1);
      }
      push(0x4, 4);                                 /* mode: byte */
      push(bytes.length, version < 10 ? 8 : 16);    /* character count */
      for (var i = 0; i < bytes.length; i++) push(bytes[i], 8);

      var capacity = dataCodewords * 8;
      var terminator = Math.min(4, capacity - bits.length);
      for (var t = 0; t < terminator; t++) bits.push(0);
      while (bits.length % 8 !== 0) bits.push(0);

      var data = new Uint8Array(dataCodewords);
      for (var b = 0; b < bits.length; b += 8) {
        var v = 0;
        for (var k = 0; k < 8; k++) v = (v << 1) | bits[b + k];
        data[b >> 3] = v;
      }
      for (var p = bits.length >> 3, alt = 0; p < dataCodewords; p++, alt++) {
        data[p] = alt % 2 === 0 ? 0xec : 0x11;      /* the two standard pad codewords */
      }

      var blocks = [], eccs = [], offset = 0;
      for (var n = 0; n < blockCount; n++) {
        var len = n < b1 ? d1 : d2;
        var blk = data.subarray(offset, offset + len);
        offset += len;
        blocks.push(blk);
        eccs.push(ecFor(blk, ecLen));
      }
      var out = new Uint8Array(s[0]);
      var w = 0, maxData = Math.max(d1, d2), col;
      for (col = 0; col < maxData; col++) {
        for (var q = 0; q < blockCount; q++) {
          if (col < blocks[q].length) out[w++] = blocks[q][col];
        }
      }
      for (col = 0; col < ecLen; col++) {
        for (var e = 0; e < blockCount; e++) out[w++] = eccs[e][col];
      }
      return out;
    }

    /* ---- function patterns, then the data snake ---- */
    function buildBase(version, cw) {
      var size = version * 4 + 17;
      var mods = new Uint8Array(size * size);
      var fn = new Uint8Array(size * size);
      function set(r, c, dark) { mods[r * size + c] = dark ? 1 : 0; fn[r * size + c] = 1; }

      var corners = [[0, 0], [0, size - 7], [size - 7, 0]];
      for (var f = 0; f < 3; f++) {
        var r0 = corners[f][0], c0 = corners[f][1];
        for (var dr = -1; dr <= 7; dr++) {
          for (var dc = -1; dc <= 7; dc++) {
            var r = r0 + dr, c = c0 + dc;
            if (r < 0 || r >= size || c < 0 || c >= size) continue;
            var ring = (dr >= 0 && dr <= 6 && (dc === 0 || dc === 6)) ||
                       (dc >= 0 && dc <= 6 && (dr === 0 || dr === 6));
            var core = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
            set(r, c, ring || core);                /* dr/dc of -1 or 7 is the separator */
          }
        }
      }

      for (var i = 8; i < size - 8; i++) {          /* timing */
        set(6, i, i % 2 === 0);
        set(i, 6, i % 2 === 0);
      }

      var pos = ALIGN[version];                     /* alignment */
      for (var a = 0; a < pos.length; a++) {
        for (var b = 0; b < pos.length; b++) {
          var atFinder = (a === 0 && b === 0) ||
                         (a === 0 && b === pos.length - 1) ||
                         (a === pos.length - 1 && b === 0);
          if (atFinder) continue;
          for (var y = -2; y <= 2; y++) {
            for (var x = -2; x <= 2; x++) {
              set(pos[a] + y, pos[b] + x, Math.max(Math.abs(y), Math.abs(x)) !== 1);
            }
          }
        }
      }

      set(size - 8, 8, true);                       /* the dark module */
      for (var k = 0; k <= 8; k++) {                /* format info, copy 1 */
        if (k !== 6) { set(8, k, false); set(k, 8, false); }
      }
      for (var m = size - 8; m < size; m++) set(8, m, false);   /* copy 2, horizontal */
      for (var n = size - 7; n < size; n++) set(n, 8, false);   /* copy 2, vertical */

      if (version >= 7) {                           /* version info blocks */
        for (var vi = 0; vi < 18; vi++) {
          var aa = size - 11 + (vi % 3), bb = Math.floor(vi / 3);
          set(aa, bb, false);
          set(bb, aa, false);
        }
      }

      /* Two columns at a time, right to left, alternating up and down, skipping
         the vertical timing column. Any leftover module is a remainder bit: 0. */
      var bitTotal = cw.length * 8, idx = 0, dir = -1, row = size - 1;
      for (var colPair = size - 1; colPair > 0; colPair -= 2) {
        if (colPair === 6) colPair--;
        for (;;) {
          for (var s2 = 0; s2 < 2; s2++) {
            var cc = colPair - s2;
            if (!fn[row * size + cc]) {
              var bit = 0;
              if (idx < bitTotal) bit = (cw[idx >> 3] >> (7 - (idx & 7))) & 1;
              idx++;
              mods[row * size + cc] = bit;
            }
          }
          row += dir;
          if (row < 0 || row >= size) { row -= dir; dir = -dir; break; }
        }
      }
      return { size: size, mods: mods, fn: fn, version: version };
    }

    var MASKS = [
      function (r, c) { return (r + c) % 2 === 0; },
      function (r) { return r % 2 === 0; },
      function (r, c) { return c % 3 === 0; },
      function (r, c) { return (r + c) % 3 === 0; },
      function (r, c) { return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; },
      function (r, c) { return ((r * c) % 2) + ((r * c) % 3) === 0; },
      function (r, c) { return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0; },
      function (r, c) { return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0; }
    ];

    /* BCH(15,5) over the 2-bit level and 3-bit mask, then the 0x5412 mask.
       Level M is 0b00, so the data word is just the mask number. */
    function formatBits(mask) {
      var data = mask;
      var rem = data;
      for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
      return ((data << 10) | rem) ^ 0x5412;
    }
    /* BCH(18,6). Only drawn from version 7 up. */
    function versionBits(version) {
      var rem = version;
      for (var i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >> 11) * 0x1f25);
      return (version << 12) | rem;
    }

    function applyMask(base, mask) {
      var size = base.size;
      var mods = new Uint8Array(base.mods);
      var fn = base.fn;
      for (var r = 0; r < size; r++) {
        for (var c = 0; c < size; c++) {
          if (fn[r * size + c]) continue;
          if (MASKS[mask](r, c)) mods[r * size + c] ^= 1;
        }
      }
      var bits = formatBits(mask);
      function bit(i) { return (bits >> i) & 1; }
      for (var i = 0; i <= 5; i++) mods[i * size + 8] = bit(i);
      mods[7 * size + 8] = bit(6);
      mods[8 * size + 8] = bit(7);
      mods[8 * size + 7] = bit(8);
      for (var j = 9; j <= 14; j++) mods[8 * size + (14 - j)] = bit(j);
      for (var k = 0; k <= 7; k++) mods[8 * size + (size - 1 - k)] = bit(k);
      for (var m = 8; m <= 14; m++) mods[(size - 15 + m) * size + 8] = bit(m);
      mods[(size - 8) * size + 8] = 1;
      if (base.version >= 7) {
        var vb = versionBits(base.version);
        for (var v = 0; v < 18; v++) {
          var val = (vb >> v) & 1;
          var a = size - 11 + (v % 3), b = Math.floor(v / 3);
          mods[a * size + b] = val;
          mods[b * size + a] = val;
        }
      }
      return mods;
    }

    var FINDERISH = [
      [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0],
      [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1]
    ];

    function penalty(mods, size) {
      var score = 0, r, c, i, h;

      for (r = 0; r < size; r++) {                  /* N1 rows */
        var rv = mods[r * size], rn = 1;
        for (c = 1; c < size; c++) {
          if (mods[r * size + c] === rv) rn++;
          else { if (rn >= 5) score += 3 + (rn - 5); rv = mods[r * size + c]; rn = 1; }
        }
        if (rn >= 5) score += 3 + (rn - 5);
      }
      for (c = 0; c < size; c++) {                  /* N1 columns */
        var cv = mods[c], cn = 1;
        for (r = 1; r < size; r++) {
          if (mods[r * size + c] === cv) cn++;
          else { if (cn >= 5) score += 3 + (cn - 5); cv = mods[r * size + c]; cn = 1; }
        }
        if (cn >= 5) score += 3 + (cn - 5);
      }
      for (r = 0; r < size - 1; r++) {              /* N2 blocks of 2x2 */
        for (c = 0; c < size - 1; c++) {
          var v = mods[r * size + c];
          if (v === mods[r * size + c + 1] && v === mods[(r + 1) * size + c] &&
              v === mods[(r + 1) * size + c + 1]) score += 3;
        }
      }
      for (r = 0; r < size; r++) {                  /* N3 finder-like, horizontal */
        for (c = 0; c + 10 < size; c++) {
          for (i = 0; i < 2; i++) {
            var okH = true;
            for (h = 0; h < 11; h++) {
              if (mods[r * size + c + h] !== FINDERISH[i][h]) { okH = false; break; }
            }
            if (okH) score += 40;
          }
        }
      }
      for (c = 0; c < size; c++) {                  /* N3 finder-like, vertical */
        for (r = 0; r + 10 < size; r++) {
          for (i = 0; i < 2; i++) {
            var okV = true;
            for (h = 0; h < 11; h++) {
              if (mods[(r + h) * size + c] !== FINDERISH[i][h]) { okV = false; break; }
            }
            if (okV) score += 40;
          }
        }
      }
      var dark = 0, total = size * size;            /* N4 dark proportion */
      for (i = 0; i < total; i++) dark += mods[i];
      score += Math.floor(Math.abs(dark * 100 / total - 50) / 5) * 10;
      return score;
    }

    function encode(text) {
      var bytes = utf8Bytes(String(text));
      var version = 0;
      for (var v = 1; v <= MAX_VERSION; v++) {
        if (bytes.length <= capacityBytes(v)) { version = v; break; }
      }
      if (!version) {
        throw new Error(
          "QR payload of " + bytes.length + " bytes exceeds version " + MAX_VERSION +
          " at level M (" + capacityBytes(MAX_VERSION) + " bytes). This encoder stops there on purpose."
        );
      }
      var base = buildBase(version, codewords(bytes, version));
      var best = null, bestScore = Infinity;
      for (var mask = 0; mask < 8; mask++) {
        var candidate = applyMask(base, mask);
        var s = penalty(candidate, base.size);
        if (s < bestScore) { bestScore = s; best = candidate; }
      }
      return { size: base.size, modules: best, version: version };
    }


    return { encode: encode, capacity: capacityBytes };
  })();

export function encodeQr(text) {
  return QR.encode(text);
}

export function qrCapacity(version) {
  return QR.capacity(version);
}
