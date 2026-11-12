// Test harness: loads the extension's shared libraries into Node and
// exercises the codec + detector.
//
//   node tools/test_libs.js
//
// The libraries are plain scripts that attach to globalThis.CE, so they can
// be loaded here exactly as the content script loads them.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const LIB_DIR = path.join(__dirname, '..', 'src', 'lib');
const FILES = [
  'charsets.js',
  'legacy-tables.js',
  'gb18030-4byte.js',
  'text-codec.js',
  'detect.js'
];

const sandbox = { console, TextDecoder, TextEncoder, Map, Set, Uint8Array, ArrayBuffer, DataView, Object, Math, JSON };
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);

for (const f of FILES) {
  vm.runInContext(fs.readFileSync(path.join(LIB_DIR, f), 'utf8'), sandbox, { filename: f });
}

const CE = sandbox.CE;

let pass = 0;
let fail = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    pass++;
  } else {
    fail++;
    failures.push(name + (detail ? ' -> ' + detail : ''));
    console.log('  FAIL ' + name + (detail ? ' -> ' + detail : ''));
  }
}

function section(title) {
  console.log('\n=== ' + title + ' ===');
}

function bytes(...vals) {
  return Uint8Array.from(vals);
}

/* ------------------------------------------------------------------ */
section('registry');

check('charsets registry loaded', CE.charsets && CE.charsets.list.length > 30,
  CE.charsets ? CE.charsets.list.length + ' entries' : 'missing');
check('every entry has kind', CE.charsets.list.every((e) => !!e.kind));
check('alias lookup gb2312 -> gbk', CE.charsets.fromAlias('gb2312')?.id === 'gbk');
check('alias lookup GB2312 (case)', CE.charsets.fromAlias('GB2312')?.id === 'gbk');
check('alias lookup shift-jis', CE.charsets.fromAlias('shift-jis')?.id === 'shift_jis');
check('alias lookup utf8', CE.charsets.fromAlias('utf8')?.id === 'utf-8');
check('alias lookup windows-1252', CE.charsets.fromAlias('Windows-1252')?.id === 'windows-1252');
check('alias lookup unknown returns null', CE.charsets.fromAlias('nonsense-xyz') === null);
check('grouped covers all entries',
  CE.charsets.grouped().reduce((n, g) => n + g.items.length, 0) === CE.charsets.list.length);

/* ------------------------------------------------------------------ */
section('decode');

check('utf-8 decode', CE.codec.decode(bytes(0xe4, 0xb8, 0xad), 'utf-8') === '中');
check('utf-8 BOM stripped', CE.codec.decode(bytes(0xef, 0xbb, 0xbf, 0xe4, 0xb8, 0xad), 'utf-8') === '中');
check('gbk decode', CE.codec.decode(bytes(0xd6, 0xd0, 0xce, 0xc4), 'gbk') === '中文');
check('big5 decode', CE.codec.decode(bytes(0xa4, 0xa4, 0xa4, 0xe5), 'big5') === '中文');
check('shift_jis decode', CE.codec.decode(bytes(0x93, 0xfa, 0x96, 0x7b), 'shift_jis') === '日本');
check('euc-jp decode', CE.codec.decode(bytes(0xc6, 0xfc, 0xcb, 0xdc), 'euc-jp') === '日本');
check('euc-kr decode', CE.codec.decode(bytes(0xc7, 0xd1, 0xb1, 0xb9), 'euc-kr') === '한국');
check('windows-1251 decode', CE.codec.decode(bytes(0xcf, 0xf0, 0xe8, 0xe2), 'windows-1251') === 'Прив');
check('koi8-r decode', CE.codec.decode(bytes(0xd0, 0xd2, 0xc9, 0xd7, 0xc5, 0xd4), 'koi8-r') === 'привет');
check('utf-16le decode', CE.codec.decode(bytes(0x2d, 0x4e), 'utf-16le') === '中');
check('utf-16be decode', CE.codec.decode(bytes(0x4e, 0x2d), 'utf-16be') === '中');
check('utf-16le BOM stripped', CE.codec.decode(bytes(0xff, 0xfe, 0x2d, 0x4e), 'utf-16le') === '中');

/* ------------------------------------------------------------------ */
section('encode (reverse tables)');

function encodeEq(id, text, expectedHex) {
  const got = Buffer.from(CE.codec.encode(text, id)).toString('hex');
  check('encode ' + id + ' ' + JSON.stringify(text),
    expectedHex === null || got === expectedHex, got + ' (expected ' + expectedHex + ')');
}

encodeEq('gbk', '中文', 'd6d0cec4');
encodeEq('gb18030', '中文', 'd6d0cec4');
encodeEq('big5', '中文', 'a4a4a4e5');
encodeEq('shift_jis', '日本', '93fa967b');
encodeEq('euc-jp', '日本', 'c6fccbdc');
encodeEq('euc-kr', '한국', 'c7d1b1b9');
encodeEq('windows-1251', 'Прив', 'cff0e8e2');
encodeEq('koi8-r', 'привет', 'd0d2c9d7c5d4');
encodeEq('utf-16le', '中', '2d4e');
encodeEq('utf-16be', '中', '4e2d');
encodeEq('utf-8', '中', 'e4b8ad');

/* ------------------------------------------------------------------ */
section('round trip');

const SAMPLES = {
  gbk: '中文简体测试，软件开发工程师。',
  big5: '繁體中文測試，軟體開發工程師。',
  shift_jis: '日本語のテストです。ソフトウェア開発。',
  euc_jp: '日本語のテストです。ソフトウェア開発。',
  euc_kr: '한국어 테스트입니다. 소프트웨어 개발.',
  windows_1251: 'Привет, мир! Программист.',
  koi8_r: 'Привет, мир! Программист.',
  iso_8859_5: 'Привет, мир! Программист.',
  ibm866: 'Привет, мир! Программист.',
  x_mac_cyrillic: 'Привет, мир! Программист.',
  windows_1253: 'Γειά σου Κόσμε! Προγραμματιστής.',
  iso_8859_7: 'Γειά σου Κόσμε! Προγραμματιστής.',
  windows_1256: 'مرحبا بالعالم! مبرمج.',
  iso_8859_6: 'مرحبا بالعالم! مبرمج.',
  windows_1255: 'שלום עולם! מתכנת.',
  iso_8859_8: 'שלום עולם! מתכנת.',
  windows_1254: 'Merhaba Dünya! Yazılımcı.',
  windows_1250: 'Příliš žluťoučký kůň úpěl ďábelské ódy.',
  iso_8859_2: 'Příliš žluťoučký kůň úpěl ďábelské ódy.',
  windows_1258: 'Xin chào thế giới! Lập trình viên.',
  windows_1252: 'Héllo wörld! Déveloper.',
  iso_8859_15: 'Héllo wörld! Déveloper.',
  macintosh: 'Héllo wörld! Déveloper.',
  utf_8: 'Hello 世界! 😀'
};

for (const [id, text] of Object.entries(SAMPLES)) {
  const enc = CE.codec.encode(text, id);
  const dec = CE.codec.decode(enc, id);
  check('round trip ' + id, dec === text, JSON.stringify(dec.slice(0, 30)));
}

/* ------------------------------------------------------------------ */
section('gb18030 four byte area');

// A CJK extension B character that GBK cannot represent.
const rare = '\u{20000}';
const rareBytes = CE.codec.encode(rare, 'gb18030');
check('gb18030 encodes rare char to 4 bytes', rareBytes.length === 4, rareBytes.length + ' bytes');
check('gb18030 round trips rare char',
  CE.codec.decode(rareBytes, 'gb18030') === rare,
  JSON.stringify(CE.codec.decode(rareBytes, 'gb18030')));
check('gb18030 run table present', !!(CE.gb18030 && CE.gb18030.runs && CE.gb18030.runs.length));

/* ------------------------------------------------------------------ */
section('detection');

function detectHex(hex, httpCharset) {
  const buf = Buffer.from(hex, 'hex');
  return CE.detect.analyze(new Uint8Array(buf), { httpCharset });
}

// UTF-8 with BOM
check('detect utf-8 BOM', detectHex('efbbbf4e2d4e2d').charset === 'utf-8');
// UTF-8 no BOM
check('detect utf-8 plain', detectHex('48656c6c6fe4b896e7958c').charset === 'utf-8');
// GBK bytes, no declaration -> statistical
check('detect gbk statistically',
  detectHex('d6d0cec4').charset === 'gbk', detectHex('d6d0cec4').charset);
// GBK declared via HTTP header
check('detect gbk via http header',
  detectHex('d6d0cec4', 'gb2312').charset === 'gbk');
// Big5 declared
check('detect big5 via http header',
  detectHex('a4a4a4e5', 'big5').charset === 'big5');
// Shift_JIS declared
check('detect shift_jis via http header',
  detectHex('93fa967b', 'shift_jis').charset === 'shift_jis');
// meta charset detection
const metaHtml = Buffer.from('<html><head><meta charset="gb2312"></head><body>x</body></html>', 'latin1');
check('detect meta charset',
  CE.detect.analyze(new Uint8Array(metaHtml)).charset === 'gbk');
// http-equiv form
const metaHttp = Buffer.from('<meta http-equiv="Content-Type" content="text/html; charset=big5">', 'latin1');
check('detect http-equiv meta charset',
  CE.detect.analyze(new Uint8Array(metaHttp)).charset === 'big5');
// BOM wins over header
check('BOM beats http header',
  detectHex('efbbbf4e2d4e2d', 'gbk').charset === 'utf-8');
// invalid declared charset falls back to statistical
check('invalid declaration falls back',
  detectHex('93fa967b93fa967b', 'utf-8').charset !== 'utf-8',
  detectHex('93fa967b93fa967b', 'utf-8').charset);
/* ------------------------------------------------------------------ */
section('statistical detection accuracy');

// Build realistic documents in each encoding and check that the detector
// finds them without any declaration.
function buildDoc(text, charsetId) {
  const enc = CE.codec.encode(text, charsetId);
  const head = CE.codec.encode('<html><head><title>t</title></head><body>', charsetId);
  const tail = CE.codec.encode('</body></html>', charsetId);
  const out = new Uint8Array(head.length + enc.length + tail.length);
  out.set(head, 0);
  out.set(enc, head.length);
  out.set(tail, head.length + enc.length);
  return out;
}

const DETECT_CASES = [
  ['gbk', '这是一段中文网页内容，用于测试字符编码检测功能是否正常工作。'],
  ['gb18030', '这是一段中文网页内容，用于测试字符编码检测功能是否正常工作。'],
  ['big5', '這是一段繁體中文網頁內容，用於測試字元編碼偵測功能是否正常運作。'],
  ['shift_jis', 'これは日本語のウェブページコンテンツです。文字コードの検出機能をテストします。'],
  ['euc-jp', 'これは日本語のウェブページコンテンツです。文字コードの検出機能をテストします。'],
  ['euc-kr', '이것은 한국어 웹 페이지 콘텐츠입니다. 문자 인코딩 감지 기능을 테스트합니다.'],
  ['windows-1251', 'Это содержимое веб-страницы на русском языке для проверки определения кодировки.'],
  ['koi8-r', 'Это содержимое веб-страницы на русском языке для проверки определения кодировки.'],
  ['windows-1253', 'Αυτό είναι το περιεχόμενο μιας ιστοσελίδας για τον έλεγχο κωδικοποίησης χαρακτήρων.'],
  ['windows-1256', 'هذا محتوى صفحة ويب باللغة العربية لاختبار اكتشاف ترميز الأحرف بشكل صحيح.'],
  ['windows-1255', 'זהו תוכן של דף אינטרנט בעברית לבדיקת זיהוי קידוד תווים.'],
  ['windows-1254', 'Bu bir karakter kodlaması algılama özelliğini test etmek için web sayfası içeriğidir.'],
  ['windows-874', 'นี่คือเนื้อหาของหน้าเว็บสำหรับทดสอบการตรวจจับการเข้ารหัสอักขระ'],
  ['windows-1252', 'Grüße aus München! Änderung für größere Straßen und schöne Wörter.'],
  ['iso-8859-2', 'Toto je obsah webové stránky v češtině pro testování detekce kódování znaků.'],
  ['windows-1258', 'Đây là nội dung trang web bằng tiếng Việt để kiểm tra việc phát hiện mã hóa ký tự.']
];

// A few encodings are genuinely indistinguishable from another one, so the
// detector is allowed to report either:
//   * gb18030 vs gbk   -- identical byte sequences for any BMP text
//   * koi8-r vs koi8-u -- differ in only 8 byte values (box drawing chars)
const AMBIGUOUS = {
  gb18030: ['gbk', 'gb18030'],
  'koi8-r': ['koi8-r', 'koi8-u'],
  'koi8-u': ['koi8-r', 'koi8-u']
};

for (const [id, text] of DETECT_CASES) {
  const doc = buildDoc(text, id);
  const result = CE.detect.analyze(doc);
  const acceptable = AMBIGUOUS[id] || [id];
  check('statistical detect ' + id, acceptable.includes(result.charset),
    'got ' + result.charset + ' (conf ' + result.confidence.toFixed(2) + ', candidates ' +
    (result.candidates || []).slice(0, 3).map((c) => c.charset).join(',') + ')');
}

/* ------------------------------------------------------------------ */
section('encodability check');

const check1 = CE.codec.checkEncodable('中文', 'gbk');
check('checkEncodable gbk ok', check1.ok === true, JSON.stringify(check1));
const check2 = CE.codec.checkEncodable('\u{20000}', 'gbk');
check('checkEncodable gbk rejects rare char', check2.ok === false && check2.missing === 1);
const check3 = CE.codec.checkEncodable('\u{20000}', 'gb18030');
check('checkEncodable gb18030 accepts rare char', check3.ok === true);

/* ------------------------------------------------------------------ */
section('summary');
console.log('\npass: ' + pass + '  fail: ' + fail);
if (fail) {
  console.log('\nfailures:');
  failures.forEach((f) => console.log('  - ' + f));
}
process.exit(fail ? 1 : 0);
