/* Compact QR Code encoder (byte mode, error correction level M, versions 1–10).
   Used to show the Telegram login QR without any external library or network request.
   Algorithm follows ISO/IEC 18004; verified by decoding generated codes with OpenCV (tests/qr_decode_check.py). */
(function (root) {
  'use strict';

  // [data codewords per block group..., ecc codewords per block] for level M, versions 1..10
  // each entry: { ec: ecc codewords per block, groups: [[blockCount, dataCodewordsPerBlock], ...] }
  var M_TABLE = [null,
    { ec: 10, groups: [[1, 16]] }, { ec: 16, groups: [[1, 28]] }, { ec: 26, groups: [[1, 44]] },
    { ec: 18, groups: [[2, 32]] }, { ec: 24, groups: [[2, 43]] }, { ec: 16, groups: [[4, 27]] },
    { ec: 18, groups: [[4, 31]] }, { ec: 22, groups: [[2, 38], [2, 39]] },
    { ec: 22, groups: [[3, 36], [2, 37]] }, { ec: 26, groups: [[4, 43], [1, 44]] }
  ];

  var EXP = new Array(512), LOG = new Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();
  function gfMul(a, b) { return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]; }

  function rsGenerator(degree) {
    var poly = [1];
    for (var i = 0; i < degree; i++) {
      var next = new Array(poly.length + 1).fill(0);
      for (var j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= gfMul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly; // highest degree first, leading coefficient 1
  }

  function rsRemainder(data, degree) {
    var gen = rsGenerator(degree);
    var rem = new Array(degree).fill(0);
    for (var i = 0; i < data.length; i++) {
      var factor = data[i] ^ rem[0];
      rem.shift(); rem.push(0);
      for (var j = 0; j < degree; j++) rem[j] ^= gfMul(gen[j + 1], factor);
    }
    return rem;
  }

  function utf8(text) {
    var out = [];
    var enc = unescape(encodeURIComponent(text));
    for (var i = 0; i < enc.length; i++) out.push(enc.charCodeAt(i));
    return out;
  }

  function dataCapacity(version) {
    var t = M_TABLE[version], n = 0;
    for (var i = 0; i < t.groups.length; i++) n += t.groups[i][0] * t.groups[i][1];
    return n;
  }

  function encodeCodewords(bytes) {
    var version = 0;
    for (var v = 1; v <= 10; v++) {
      var countBits = v < 10 ? 8 : 16;
      if (4 + countBits + bytes.length * 8 <= dataCapacity(v) * 8) { version = v; break; }
    }
    if (!version) throw new Error('QR: text too long');
    var bits = [];
    function push(value, len) { for (var i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1); }
    push(4, 4); // byte mode
    push(bytes.length, version < 10 ? 8 : 16);
    bytes.forEach(function (b) { push(b, 8); });
    var capBits = dataCapacity(version) * 8;
    for (var t = 0; t < 4 && bits.length < capBits; t++) bits.push(0);
    while (bits.length % 8) bits.push(0);
    var words = [];
    for (var i = 0; i < bits.length; i += 8) {
      var w = 0; for (var k = 0; k < 8; k++) w = (w << 1) | bits[i + k];
      words.push(w);
    }
    for (var pad = 0xec; words.length < dataCapacity(version); pad ^= 0xec ^ 0x11) words.push(pad);

    var info = M_TABLE[version], blocks = [], pos = 0;
    info.groups.forEach(function (g) {
      for (var b = 0; b < g[0]; b++) { blocks.push(words.slice(pos, pos + g[1])); pos += g[1]; }
    });
    var eccBlocks = blocks.map(function (blk) { return rsRemainder(blk, info.ec); });
    var out = [], maxLen = Math.max.apply(null, blocks.map(function (b) { return b.length; }));
    for (var c = 0; c < maxLen; c++) blocks.forEach(function (blk) { if (c < blk.length) out.push(blk[c]); });
    for (var e = 0; e < info.ec; e++) eccBlocks.forEach(function (blk) { out.push(blk[e]); });
    return { version: version, codewords: out };
  }

  function alignmentPositions(version) {
    if (version === 1) return [];
    var n = Math.floor(version / 7) + 2, size = version * 4 + 17;
    var step = Math.ceil((version * 4 + 4) / (n * 2 - 2)) * 2;
    var res = [6];
    for (var p = size - 7; res.length < n; p -= step) res.splice(1, 0, p);
    return res;
  }

  function bit(value, i) { return ((value >>> i) & 1) !== 0; }

  function build(version, codewords, mask) {
    var size = version * 4 + 17;
    var mod = [], fn = [];
    for (var y = 0; y < size; y++) { mod.push(new Array(size).fill(false)); fn.push(new Array(size).fill(false)); }
    function setFn(x, y, dark) { mod[y][x] = dark; fn[y][x] = true; }

    for (var i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }
    function finder(cx, cy) {
      for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) {
        var dist = Math.max(Math.abs(dx), Math.abs(dy)), xx = cx + dx, yy = cy + dy;
        if (xx >= 0 && xx < size && yy >= 0 && yy < size) setFn(xx, yy, dist !== 2 && dist !== 4);
      }
    }
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    var ap = alignmentPositions(version);
    for (var a = 0; a < ap.length; a++) for (var b = 0; b < ap.length; b++) {
      if ((a === 0 && b === 0) || (a === 0 && b === ap.length - 1) || (a === ap.length - 1 && b === 0)) continue;
      for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++) setFn(ap[a] + dx, ap[b] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }

    function drawFormat(m) {
      var data = (0 << 3) | m; // level M = 0b00
      var rem = data;
      for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      var bits = ((data << 10) | rem) ^ 0x5412;
      for (var i2 = 0; i2 <= 5; i2++) setFn(8, i2, bit(bits, i2));
      setFn(8, 7, bit(bits, 6)); setFn(8, 8, bit(bits, 7)); setFn(7, 8, bit(bits, 8));
      for (var i3 = 9; i3 < 15; i3++) setFn(14 - i3, 8, bit(bits, i3));
      for (var i4 = 0; i4 < 8; i4++) setFn(size - 1 - i4, 8, bit(bits, i4));
      for (var i5 = 8; i5 < 15; i5++) setFn(8, size - 15 + i5, bit(bits, i5));
      setFn(8, size - 8, true);
    }
    drawFormat(0); // reserve area; real mask written later

    if (version >= 7) {
      var rem = version;
      for (var r = 0; r < 12; r++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      var vbits = (version << 12) | rem;
      for (var k = 0; k < 18; k++) {
        var color = bit(vbits, k), p = size - 11 + (k % 3), q = Math.floor(k / 3);
        setFn(p, q, color); setFn(q, p, color);
      }
    }

    var idx = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) for (var j = 0; j < 2; j++) {
        var x = right - j, upward = ((right + 1) & 2) === 0, y2 = upward ? size - 1 - vert : vert;
        if (!fn[y2][x] && idx < codewords.length * 8) { mod[y2][x] = bit(codewords[idx >>> 3], 7 - (idx & 7)); idx++; }
      }
    }

    for (var yy = 0; yy < size; yy++) for (var xx = 0; xx < size; xx++) {
      var inv;
      switch (mask) {
        case 0: inv = (xx + yy) % 2 === 0; break;
        case 1: inv = yy % 2 === 0; break;
        case 2: inv = xx % 3 === 0; break;
        case 3: inv = (xx + yy) % 3 === 0; break;
        case 4: inv = (Math.floor(xx / 3) + Math.floor(yy / 2)) % 2 === 0; break;
        case 5: inv = (xx * yy) % 2 + (xx * yy) % 3 === 0; break;
        case 6: inv = ((xx * yy) % 2 + (xx * yy) % 3) % 2 === 0; break;
        default: inv = ((xx + yy) % 2 + (xx * yy) % 3) % 2 === 0;
      }
      if (inv && !fn[yy][xx]) mod[yy][xx] = !mod[yy][xx];
    }
    drawFormat(mask);
    return mod;
  }

  function penalty(m) {
    var size = m.length, score = 0, i, j;
    for (i = 0; i < size; i++) {
      var runR = 1, runC = 1;
      for (j = 1; j < size; j++) {
        if (m[i][j] === m[i][j - 1]) { runR++; if (runR === 5) score += 3; else if (runR > 5) score++; } else runR = 1;
        if (m[j][i] === m[j - 1][i]) { runC++; if (runC === 5) score += 3; else if (runC > 5) score++; } else runC = 1;
      }
    }
    for (i = 0; i < size - 1; i++) for (j = 0; j < size - 1; j++) {
      var c = m[i][j];
      if (c === m[i][j + 1] && c === m[i + 1][j] && c === m[i + 1][j + 1]) score += 3;
    }
    var pat = [true, false, true, true, true, false, true, false, false, false, false];
    for (i = 0; i < size; i++) for (j = 0; j + 11 <= size; j++) {
      var okH = true, okH2 = true, okV = true, okV2 = true;
      for (var k = 0; k < 11; k++) {
        if (m[i][j + k] !== pat[k]) okH = false;
        if (m[i][j + k] !== pat[10 - k]) okH2 = false;
        if (m[j + k][i] !== pat[k]) okV = false;
        if (m[j + k][i] !== pat[10 - k]) okV2 = false;
      }
      if (okH) score += 40; if (okH2) score += 40; if (okV) score += 40; if (okV2) score += 40;
    }
    var dark = 0;
    for (i = 0; i < size; i++) for (j = 0; j < size; j++) if (m[i][j]) dark++;
    score += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
    return score;
  }

  function matrix(text) {
    var enc = encodeCodewords(utf8(String(text)));
    var best = null, bestScore = Infinity;
    for (var mask = 0; mask < 8; mask++) {
      var m = build(enc.version, enc.codewords, mask), s = penalty(m);
      if (s < bestScore) { bestScore = s; best = m; }
    }
    return best;
  }

  function svg(text, opts) {
    opts = opts || {};
    var m = matrix(text), quiet = opts.quiet == null ? 4 : opts.quiet, n = m.length + quiet * 2;
    var path = [];
    for (var y = 0; y < m.length; y++) for (var x = 0; x < m.length; x++) {
      if (m[y][x]) path.push('M' + (x + quiet) + ' ' + (y + quiet) + 'h1v1h-1z');
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + n + ' ' + n + '" shape-rendering="crispEdges" role="img" aria-label="QR-код входа в Telegram">' +
      '<rect width="' + n + '" height="' + n + '" fill="' + (opts.bg || '#ffffff') + '"/>' +
      '<path d="' + path.join('') + '" fill="' + (opts.fg || '#000000') + '"/></svg>';
  }

  root.QR = { matrix: matrix, svg: svg };
})(typeof window !== 'undefined' ? window : globalThis);
