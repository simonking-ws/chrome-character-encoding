// Verify the built-in ISO-8859-16 fallback table works, by simulating a
// browser that does not implement that encoding.
//
// The reference values in tools/fixture_iso8859_16.json come from Chrome's
// native ISO-8859-16 decoder, which was verified to agree with Python's
// iso8859_16 codec for all 256 byte values.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const LIB_DIR = path.join(__dirname, '..', 'src', 'lib');
const sandbox = { console, TextDecoder, TextEncoder, Map, Set, Uint8Array, ArrayBuffer, DataView, Object, Math, JSON };
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);
for (const f of ['charsets.js', 'legacy-tables.js', 'gb18030-4byte.js', 'text-codec.js', 'detect.js']) {
  vm.runInContext(fs.readFileSync(path.join(LIB_DIR, f), 'utf8'), sandbox, { filename: f });
}
const CE = sandbox.CE;

// Simulate a browser without ISO-8859-16 by making TextDecoder reject it.
const RealTextDecoder = sandbox.TextDecoder;
sandbox.TextDecoder = class extends RealTextDecoder {
  constructor(label, options) {
    if (label === 'iso-8859-16') throw new Error('not supported');
    super(label, options);
  }
};
// Re-evaluate the codec with the patched TextDecoder.
vm.runInContext(fs.readFileSync(path.join(LIB_DIR, 'text-codec.js'), 'utf8'), sandbox, { filename: 'text-codec.js' });

const EURO = '\u20AC';
const ZCaron = '\u017D';
const TComma = '\u021B';

const bytes = Uint8Array.from([0xa4, 0xb4, 0xfe, 0x41]);
const text = CE.codec.decode(bytes, 'iso-8859-16');
console.log('解码结果:', JSON.stringify(text), '码点:', Array.from(text).map((c) => c.codePointAt(0).toString(16)));

const enc = CE.codec.encode(EURO + ZCaron + TComma, 'iso-8859-16');
console.log('编码结果:', Array.from(enc).map((b) => b.toString(16)).join(' '));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  [PASS] ' + name); }
  else { fail++; console.log('  [FAIL] ' + name + (detail ? ' -> ' + detail : '')); }
}

// 逐字节与 Chrome 原生实现比对
const reference = require('./fixture_iso8859_16.json');
let mismatches = 0;
for (let b = 0; b < 256; b++) {
  const decoded = CE.codec.decode(Uint8Array.from([b]), 'iso-8859-16');
  if (decoded.codePointAt(0) !== reference[b]) mismatches++;
}
check('自带码表与 Chrome 原生实现逐字节一致', mismatches === 0, mismatches + ' 处不一致');

check('ISO-8859-16 回退解码正确', text === EURO + ZCaron + TComma + 'A', JSON.stringify(text));
check('ISO-8859-16 回退编码正确',
  Array.from(enc).map((b) => b.toString(16)).join(' ') === 'a4 b4 fe',
  Array.from(enc).map((b) => b.toString(16)).join(' '));
check('回退模式下往返一致', CE.codec.decode(enc, 'iso-8859-16') === EURO + ZCaron + TComma);

console.log('\n通过: ' + pass + '  失败: ' + fail);
process.exit(fail ? 1 : 0);
