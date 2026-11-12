/**
 * 本地测试服务器：按不同编码提供同一份页面内容。
 *
 * 用来验证扩展的核心链路：浏览器把页面按“错误”的编码渲染成乱码之后，
 * 扩展能否取回原始字节、重新解码并把文本替换正确。
 *
 *   node tools/test_server.js [port]
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const vm = require('vm');

// 复用扩展的编解码库，保证测试用的字节与扩展处理的是同一套编码
const LIB_DIR = path.join(__dirname, '..', 'src', 'lib');
const sandbox = { console, TextDecoder, TextEncoder, Map, Set, Uint8Array, ArrayBuffer, DataView, Object, Math, JSON };
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);
for (const f of ['charsets.js', 'legacy-tables.js', 'gb18030-4byte.js', 'text-codec.js', 'detect.js']) {
  vm.runInContext(fs.readFileSync(path.join(LIB_DIR, f), 'utf8'), sandbox, { filename: f });
}
const CE = sandbox.CE;

const PORT = Number(process.argv[2] || 8931);

const SAMPLES = {
  'zh-cn': '这是一段中文网页内容，用于测试字符编码检测功能是否正常工作。页面应当显示正确的文字。',
  'zh-tw': '這是一段繁體中文網頁內容，用於測試字元編碼偵測功能是否正常運作。頁面應當顯示正確的文字。',
  ja: 'これは日本語のウェブページコンテンツです。文字コードの検出機能をテストします。ページは正しく表示されるはずです。',
  ko: '이것은 한국어 웹 페이지 콘텐츠입니다. 문자 인코딩 감지 기능을 테스트합니다. 페이지가 올바르게 표시되어야 합니다.',
  ru: 'Это содержимое веб-страницы на русском языке для проверки определения кодировки. Страница должна отображаться правильно.',
  el: 'Αυτό είναι το περιεχόμενο μιας ιστοσελίδας για τον έλεγχο κωδικοποίησης χαρακτήρων. Η σελίδα πρέπει να εμφανίζεται σωστά.',
  ar: 'هذا محتوى صفحة ويب باللغة العربية لاختبار اكتشاف ترميز الأحرف بشكل صحيح. يجب أن تعرض الصفحة بشكل صحيح.',
  he: 'זהו תוכן של דף אינטרנט בעברית לבדיקת זיהוי קידוד תווים. הדף צריך להוצג בצורה נכונה.',
  th: 'นี่คือเนื้อหาของหน้าเว็บสำหรับทดสอบการตรวจจับการเข้ารหัสอักขระ หน้านี้ควรแสดงผลได้อย่างถูกต้อง',
  de: 'Grüße aus München! Änderung für größere Straßen und schöne Wörter. Die Seite soll richtig angezeigt werden.',
  cs: 'Toto je obsah webové stránky v češtině pro testování detekce kódování znaků. Stránka se má zobrazit správně.'
};

const ENCODING_OF = {
  'zh-cn': 'gbk',
  'zh-tw': 'big5',
  ja: 'shift_jis',
  ko: 'euc-kr',
  ru: 'windows-1251',
  el: 'windows-1253',
  ar: 'windows-1256',
  he: 'windows-1255',
  th: 'windows-874',
  de: 'windows-1252',
  cs: 'iso-8859-2'
};

function buildPage(lang) {
  const charsetId = ENCODING_OF[lang];
  const text = SAMPLES[lang];
  const body = [
    '<!DOCTYPE html>',
    '<html><head><meta charset="' + charsetId + '"><title>编码测试 - ' + lang + '</title></head>',
    '<body>',
    '<h1 id="head">' + text + '</h1>',
    '<p id="para">' + text + '</p>',
    '<ul id="list"><li>' + text + '</li><li>' + text + '</li></ul>',
    '<script>window.__marker = "script-ran";</script>',
    '</body></html>'
  ].join('\n');
  return CE.codec.encode(body, charsetId);
}

/**
 * /page?lang=zh-cn            -> 正常：响应头声明正确编码
 * /wrong?lang=zh-cn           -> 响应头声明 UTF-8，但实际是 GBK（制造乱码）
 * /noheader?lang=zh-cn        -> 响应头不含 charset，制造乱码
 */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost:' + PORT);
  const lang = url.searchParams.get('lang') || 'zh-cn';

  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!DOCTYPE html><meta charset="utf-8"><body><h1>测试服务器</h1><ul>' +
      Object.keys(SAMPLES).map((l) =>
        '<li><a href="/page?lang=' + l + '">/page?lang=' + l + '</a> ' +
        '<a href="/wrong?lang=' + l + '">/wrong</a> ' +
        '<a href="/noheader?lang=' + l + '">/noheader</a></li>').join('') +
      '</ul></body>');
    return;
  }

  let bytes;
  let headers;

  if (url.pathname === '/page') {
    bytes = buildPage(lang);
    headers = { 'content-type': 'text/html; charset=' + ENCODING_OF[lang] };
  } else if (url.pathname === '/wrong') {
    bytes = buildPage(lang);
    headers = { 'content-type': 'text/html; charset=utf-8' };
  } else if (url.pathname === '/noheader') {
    bytes = buildPage(lang);
    headers = { 'content-type': 'text/html' };
  } else if (url.pathname === '/csp') {
    // 严格的 CSP 会禁止页面自己发起的 connect 请求，用来验证扩展的兜底路径
    bytes = buildPage(lang);
    headers = {
      'content-type': 'text/html; charset=' + ENCODING_OF[lang],
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"
    };
  } else {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }

  res.writeHead(200, headers);
  res.end(Buffer.from(bytes));
});

server.listen(PORT, () => {
  console.log('test server on http://localhost:' + PORT);
});

module.exports = { server, PORT, SAMPLES, ENCODING_OF, CE };
