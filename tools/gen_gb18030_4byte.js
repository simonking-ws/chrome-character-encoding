// Generate src/lib/gb18030-4byte.js from real Chrome.
//
// Why the table exists
// --------------------
// Encoding to a legacy charset needs a reverse map (code point -> bytes).
// The browser's TextEncoder only emits UTF-8, so the extension builds its own
// reverse tables.  Every other charset can be scanned at runtime (a few
// thousand byte sequences), but GB18030's four byte area holds 1.58 million
// sequences, so it is generated here and shipped instead.
//
// Chrome is the source of truth
// -----------------------------
// The table is generated from Chrome's own TextDecoder, so encoding with the
// table and decoding with the browser round-trip exactly.  (Chrome's WHATWG
// gb18030 differs from other implementations such as Python's codec for a
// small number of code points; matching the browser is what matters here.)
//
// Table layout
// ------------
// The four byte space is walked in lexicographic order over
// (b1, b2, b3, b4), with b1 in 0x81..0xFE, b2 in 0x30..0x39,
// b3 in 0x81..0xFE and b4 in 0x30..0x39:
//
//   index = ((b1 - 0x81) * 10 + (b2 - 0x30)) * 1260 + (b3 - 0x81) * 10 + (b4 - 0x30)
//
// Inside that space the mapping consists of linear runs: a stretch of
// consecutive indices whose code points also advance by one.  Each run is
//
//   [firstIndex, firstCodePoint, length]
//
// Two orderings are emitted because the two directions search differently:
//
//   RUNS_BY_INDEX      sorted by firstIndex      -> decoding (bytes -> cp)
//   RUNS_BY_CODEPOINT  sorted by firstCodePoint  -> encoding (cp -> bytes)
//
// Code points are not monotonic in index order, so one sorted array cannot
// serve both directions.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-gen-gb-'));

const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><pre id="out">pending</pre>
<script>
const dec = new TextDecoder('gb18030');
const TOTAL = 126 * 10 * 126 * 10;

// Lexicographic order over (b1, b2, b3, b4).
const bytesAt = (i) => {
  const b4 = i % 10; i = (i - b4) / 10;
  const b3 = i % 126; i = (i - b3) / 126;
  const b2 = i % 10; i = (i - b2) / 10;
  return [0x81 + i, 0x30 + b2, 0x81 + b3, 0x30 + b4];
};
const indexOf = (b1, b2, b3, b4) =>
  ((b1 - 0x81) * 10 + (b2 - 0x30)) * 1260 + (b3 - 0x81) * 10 + (b4 - 0x30);

// bytesAt and indexOf must be inverses.
let invBad = 0;
for (let i = 0; i < TOTAL; i += 101) {
  const b = bytesAt(i);
  if (indexOf(b[0], b[1], b[2], b[3]) !== i) invBad++;
}

const buf = new Uint8Array(4);
const runs = [];
let cur = null;
let mapped = 0;
for (let i = 0; i < TOTAL; i++) {
  const b = bytesAt(i);
  buf[0] = b[0]; buf[1] = b[1]; buf[2] = b[2]; buf[3] = b[3];
  const cp = dec.decode(buf).codePointAt(0);
  if (cp === 0xfffd) { cur = null; continue; }
  mapped++;
  if (cur && cur[0] + cur[2] === i && cur[1] + cur[2] === cp) cur[2]++;
  else { cur = [i, cp, 1]; runs.push(cur); }
}

// Independent verification of both directions.
let checked = 0, bad = 0;
for (const [i0, c0, len] of runs) {
  for (let k = 0; k < len; k++) {
    const b = bytesAt(i0 + k);
    buf[0] = b[0]; buf[1] = b[1]; buf[2] = b[2]; buf[3] = b[3];
    checked++;
    if (dec.decode(buf).codePointAt(0) !== c0 + k) bad++;
  }
}

document.getElementById('out').textContent = JSON.stringify({
  runs, checked, bad, mapped, invBad
});
</script></body></html>`;

const probeFile = path.join(os.tmpdir(), 'ce-gen-gb-probe.html');
fs.writeFileSync(probeFile, html);

const child = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--user-data-dir=' + profile, '--virtual-time-budget=300000', '--dump-dom',
  'file:///' + probeFile.replace(/\\/g, '/')
], { stdio: ['ignore', 'pipe', 'pipe'] });

let out = '';
child.stdout.on('data', (d) => (out += d));

child.on('close', () => {
  fs.rmSync(profile, { recursive: true, force: true });
  const m = out.match(/<pre id="out">([\s\S]*?)<\/pre>/);
  if (!m) {
    console.error('probe failed');
    process.exit(1);
  }
  const data = JSON.parse(
    m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  );
  if (data.bad !== 0 || data.invBad !== 0) {
    console.error('run table failed self-verification:', data.bad, data.invBad);
    process.exit(1);
  }

  const runs = data.runs;
  const byCp = runs.slice().sort((a, b) => a[1] - b[1]);
  // Code point ranges must not overlap, otherwise encoding is ambiguous.
  for (let i = 1; i < byCp.length; i++) {
    if (byCp[i - 1][1] + byCp[i - 1][2] > byCp[i][1]) {
      console.error('overlapping code point ranges');
      process.exit(1);
    }
  }

  const emit = (arr) => {
    const lines = [];
    for (let i = 0; i < arr.length; i += 8) {
      lines.push('    ' + arr.slice(i, i + 8).map((r) => '[' + r.join(',') + ']').join(', ') + ',');
    }
    return lines.join('\n');
  };

  const js = `/**
 * GB18030 four byte area, generated by tools/gen_gb18030_4byte.js from real
 * Chrome.
 *
 * Chrome's TextEncoder only emits UTF-8, so encoding to GB18030 needs a
 * reverse map.  The table is generated from Chrome's own TextDecoder, so
 * encoding with the table and decoding with the browser round-trip exactly.
 *
 * Each entry is [firstIndex, firstCodePoint, length] describing a run of
 * consecutive code points that map to consecutive byte sequences.
 */
(function (root) {
  'use strict';
  var CE = (root.CE = root.CE || {});

  // Sorted by flat index; used when decoding bytes -> code point.
  var RUNS_BY_INDEX = [
${emit(runs)}
  ];

  // Sorted by code point; used when encoding code point -> bytes.
  var RUNS_BY_CODEPOINT = [
${emit(byCp)}
  ];

  /**
   * Convert a flat index in the four byte space into its four bytes.
   * The space is walked in lexicographic order over (b1, b2, b3, b4), with
   * b1 in 0x81..0xFE, b2 in 0x30..0x39, b3 in 0x81..0xFE, b4 in 0x30..0x39.
   */
  function bytesAt(index) {
    var b4 = index % 10;
    index = (index - b4) / 10;
    var b3 = index % 126;
    index = (index - b3) / 126;
    var b2 = index % 10;
    index = (index - b2) / 10;
    return [0x81 + index, 0x30 + b2, 0x81 + b3, 0x30 + b4];
  }

  /** Flat index of a four byte sequence. */
  function indexOf(b1, b2, b3, b4) {
    return ((b1 - 0x81) * 10 + (b2 - 0x30)) * 1260 + (b3 - 0x81) * 10 + (b4 - 0x30);
  }

  /**
   * Decode a four byte sequence to a code point.
   * Returns -1 when the sequence is not part of the mapping.
   */
  function decodeQuad(b1, b2, b3, b4) {
    var index = indexOf(b1, b2, b3, b4);
    var lo = 0;
    var hi = RUNS_BY_INDEX.length - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      var run = RUNS_BY_INDEX[mid];
      var start = run[0];
      var end = start + run[2] - 1;
      if (index < start) {
        hi = mid - 1;
      } else if (index > end) {
        lo = mid + 1;
      } else {
        return run[1] + (index - start);
      }
    }
    return -1;
  }

  /**
   * Encode a code point to its four byte sequence.
   * Returns an array of four byte values, or null when unavailable.
   */
  function encodeQuad(codePoint) {
    var lo = 0;
    var hi = RUNS_BY_CODEPOINT.length - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      var run = RUNS_BY_CODEPOINT[mid];
      var first = run[1];
      var last = first + run[2] - 1;
      if (codePoint < first) {
        hi = mid - 1;
      } else if (codePoint > last) {
        lo = mid + 1;
      } else {
        return bytesAt(run[0] + (codePoint - first));
      }
    }
    return null;
  }

  /** True when the code point has a four byte representation. */
  function canEncode(codePoint) {
    var lo = 0;
    var hi = RUNS_BY_CODEPOINT.length - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      var run = RUNS_BY_CODEPOINT[mid];
      var first = run[1];
      var last = first + run[2] - 1;
      if (codePoint < first) {
        hi = mid - 1;
      } else if (codePoint > last) {
        lo = mid + 1;
      } else {
        return true;
      }
    }
    return false;
  }

  CE.gb18030 = {
    runs: RUNS_BY_INDEX,
    bytesAt: bytesAt,
    indexOf: indexOf,
    decodeQuad: decodeQuad,
    encodeQuad: encodeQuad,
    canEncode: canEncode
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
`;

  fs.writeFileSync(path.join('src', 'lib', 'gb18030-4byte.js'), js);
  console.log(
    'wrote src/lib/gb18030-4byte.js:',
    runs.length, 'runs,',
    data.mapped, 'code points,',
    data.checked, 'verified,',
    fs.statSync(path.join('src', 'lib', 'gb18030-4byte.js')).size, 'bytes'
  );
});
