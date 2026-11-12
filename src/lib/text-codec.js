/**
 * 字符编解码核心。
 *
 * 解码（字节 -> 文本）直接使用浏览器内置的 TextDecoder，支持全部 WHATWG
 * 编码标准标签，覆盖 GBK/GB18030/Big5/Shift_JIS/EUC-JP/EUC-KR 以及各单字节编码。
 *
 * 编码（文本 -> 字节）需要反向码表。浏览器的 TextEncoder 只会输出 UTF-8，
 * 因此这里在运行时用同一个 TextDecoder 反向扫描字节空间，构建码点到字节
 * 序列的映射。这样得到的编码表与浏览器解码器严格自洽，不存在两份数据
 * 对不上的问题，并且无需打包数十万条目的静态码表。
 */
(function (root) {
  'use strict';

  var CE = (root.CE = root.CE || {});

  var cache = Object.create(null);

  /**
   * GB18030 四字节区的编码辅助。
   *
   * 浏览器内置的 TextDecoder 已经能完整解码 GB18030 四字节区（含 U+10000
   * 以上的扩展区），解码方向直接用它即可。这里只保留编码方向需要的
   * 反向查询：码点 -> 四字节序列。
   */
  function encodeGb18030Quad(codePoint) {
    if (!CE.gb18030 || !CE.gb18030.encodeQuad) return null;
    return CE.gb18030.encodeQuad(codePoint);
  }

  /** 按需创建解码器 */
  function decoderFor(id) {
    if (cache[id]) return cache[id];
    var entry = CE.charsets.get(id);
    if (!entry) return null;
    var dec;
    if (entry.kind === 'replacement') {
      dec = new TextDecoder('utf-8');
    } else {
      try {
        dec = new TextDecoder(entry.whatwg);
      } catch (e) {
        dec = null;
      }
    }
    cache[id] = dec;
    return dec;
  }

  /** 该编码是否需要走自带码表（浏览器尚未实现时） */
  function usesLegacyTable(id) {
    var entry = CE.charsets.get(id);
    if (!entry || !entry.fallback) return false;
    return !decoderFor(id);
  }

  /** 单字节编码：逐字节建立码表 */
  function buildSingleByteTable(id) {
    var map = new Map();
    var legacy = usesLegacyTable(id);
    if (legacy) {
      var table = CE.legacyTables[id];
      for (var lb = 0; lb < 256; lb++) {
        var lcp = table[lb];
        if (lcp === 0xfffd) continue;
        if (!map.has(lcp)) map.set(lcp, [lb]);
      }
      return map;
    }
    var dec = decoderFor(id);
    if (!dec) return map;
    var buf = new Uint8Array(1);
    for (var b = 0; b < 256; b++) {
      buf[0] = b;
      var ch = dec.decode(buf);
      if (!ch || ch === '\uFFFD') continue;
      var cp = ch.codePointAt(0);
      if (cp === 0xFFFD) continue;
      if (!map.has(cp)) map.set(cp, [b]);
    }
    return map;
  }

  /** 多字节编码：遍历 前导字节 x 后继字节 的组合 */
  function buildMultiByteTable(id, leadRanges, trailRanges) {
    var dec = decoderFor(id);
    var map = new Map();
    if (!dec) return map;
    var buf = new Uint8Array(2);
    for (var li = 0; li < leadRanges.length; li++) {
      var lead = leadRanges[li];
      for (var ti = 0; ti < trailRanges.length; ti++) {
        var trail = trailRanges[ti];
        buf[0] = lead;
        buf[1] = trail;
        var ch = dec.decode(buf);
        if (!ch || ch.length !== 1) continue;
        var cp = ch.codePointAt(0);
        if (cp === 0xFFFD) continue;
        // 保留最先出现的字节序列，保证结果稳定
        if (!map.has(cp)) map.set(cp, [lead, trail]);
      }
    }
    return map;
  }

  function range(from, to) {
    var out = [];
    for (var i = from; i <= to; i++) out.push(i);
    return out;
  }

  /** 各多字节编码的字节空间布局，键名与注册表 id 一致 */
  var LAYOUT = {
    gbk: {
      leads: range(0x81, 0xfe),
      trails: range(0x40, 0xfe).filter(function (t) { return t !== 0x7f; })
    },
    big5: {
      leads: range(0x81, 0xfe),
      trails: range(0x40, 0x7e).concat(range(0xa1, 0xfe))
    },
    shift_jis: {
      leads: range(0x81, 0x9f).concat(range(0xe0, 0xfc)),
      trails: range(0x40, 0xfc).filter(function (t) { return t !== 0x7f; })
    },
    'euc-jp': {
      leads: range(0xa1, 0xfe),
      trails: range(0xa1, 0xfe)
    },
    'euc-kr': {
      leads: range(0xa1, 0xfe),
      trails: range(0xa1, 0xfe)
    }
  };

  var tableCache = Object.create(null);

  /** 取得（或构建）某编码的码点 -> 字节数组映射 */
  function tableFor(id) {
    if (tableCache[id]) return tableCache[id];
    var entry = CE.charsets.get(id);
    var map;
    if (!entry) {
      map = new Map();
    } else if (entry.kind === 'single') {
      map = buildSingleByteTable(id);
    } else if (entry.kind === 'multi') {
      var layout = LAYOUT[id];
      map = buildMultiByteTable(id, layout.leads, layout.trails);
      addAscii(map, id);
    } else if (entry.kind === 'gb18030') {
      // GB18030 的双字节区：直接用 gb18030 的解码器建表，
      // 保证与浏览器解码结果一致（gbk 与 gb18030 在少数双字节位上有差异）
      map = buildMultiByteTable('gb18030', LAYOUT.gbk.leads, LAYOUT.gbk.trails);
      addAscii(map, 'gb18030');
    } else {
      map = new Map();
    }
    tableCache[id] = map;
    return map;
  }

  /**
   * 多字节编码里 ASCII 区间仍然按单字节编码，另外 0x80 在 GB 系列里是欧元符号。
   */
  function addAscii(map, id) {
    for (var b = 0; b < 0x80; b++) {
      if (!map.has(b)) map.set(b, [b]);
    }
    var dec = decoderFor(id);
    if (!dec) return;
    var one = new Uint8Array(1);
    one[0] = 0x80;
    var ch = dec.decode(one);
    if (ch && ch.length === 1 && ch.charCodeAt(0) !== 0xfffd) {
      if (!map.has(ch.codePointAt(0))) map.set(ch.codePointAt(0), [0x80]);
    }
  }

  /**
   * 解码字节序列为文本。
   * @param {Uint8Array|ArrayBuffer} input
   * @param {string} id 编码 id
   * @param {{stripBom?: boolean}} [options]
   */
  function decode(input, id, options) {
    var bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    var entry = CE.charsets.get(id);
    if (!entry) return new TextDecoder('utf-8').decode(bytes);

    // UTF-8 BOM
    if (entry.kind === 'utf8' && bytes.length >= 3 &&
        bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      bytes = bytes.subarray(3);
    }
    // UTF-16 BOM
    if (entry.kind === 'utf16le' && bytes.length >= 2 &&
        bytes[0] === 0xff && bytes[1] === 0xfe) {
      bytes = bytes.subarray(2);
    }
    if (entry.kind === 'utf16be' && bytes.length >= 2 &&
        bytes[0] === 0xfe && bytes[1] === 0xff) {
      bytes = bytes.subarray(2);
    }

    if (entry.kind === 'replacement') {
      // 每个字节都变成替换字符，用于观察乱码原始形态
      var out = '';
      for (var i = 0; i < bytes.length; i++) out += '\uFFFD';
      return out;
    }

    // 浏览器尚未实现该编码时，使用扩展自带的码表
    if (usesLegacyTable(id)) {
      var chars = '';
      var table = CE.legacyTables[id];
      for (var j = 0; j < bytes.length; j++) {
        var cp = table[bytes[j]];
        chars += cp === 0xfffd ? '\uFFFD' : String.fromCodePoint(cp);
      }
      return chars;
    }

    var dec = decoderFor(id);
    if (!dec) {
      // 浏览器不支持该编码时退回 UTF-8
      return new TextDecoder('utf-8').decode(bytes);
    }
    return dec.decode(bytes);
  }

  /** 编码文本为字节序列 */
  function encode(text, id) {
    var entry = CE.charsets.get(id);
    if (!entry) return new TextEncoder().encode(text);

    if (entry.kind === 'utf8') return new TextEncoder().encode(text);
    if (entry.kind === 'utf16le' || entry.kind === 'utf16be') {
      return encodeUtf16(text, entry.kind === 'utf16le');
    }
    if (entry.kind === 'replacement') {
      var rep = new Uint8Array(text.length);
      rep.fill(0x3f);
      return rep;
    }
    if (entry.kind === 'stateful') {
      throw new Error('不支持编码为 ' + entry.label);
    }

    var map = tableFor(id);
    var out = [];
    var unmappable = 0;

    for (var i = 0; i < text.length; i++) {
      var cp = text.codePointAt(i);
      if (cp > 0xffff) i++; // 跳过代理对低位
      var bytes = map.get(cp);
      if (bytes) {
        for (var b = 0; b < bytes.length; b++) out.push(bytes[b]);
        continue;
      }
      // GB18030 四字节区
      if (entry.kind === 'gb18030') {
        var quad = encodeGb18030Quad(cp);
        if (quad) {
          out.push(quad[0], quad[1], quad[2], quad[3]);
          continue;
        }
      }
      unmappable++;
      out.push(0x3f); // '?'
    }

    return new Uint8Array(out);
  }

  function encodeUtf16(text, littleEndian) {
    var size = 2 * text.length;
    var buf = new Uint8Array(size);
    var view = new DataView(buf.buffer);
    for (var i = 0; i < text.length; i++) {
      view.setUint16(i * 2, text.charCodeAt(i), littleEndian);
    }
    return buf;
  }

  /**
   * 判断一段文本能否完整编码为指定编码。
   * @returns {{ok: boolean, missing: number, samples: string[]}}
   */
  function checkEncodable(text, id) {
    var entry = CE.charsets.get(id);
    if (!entry) return { ok: false, missing: 0, samples: [] };
    if (entry.kind === 'utf8' || entry.kind === 'utf16le' || entry.kind === 'utf16be') {
      return { ok: true, missing: 0, samples: [] };
    }
    if (entry.kind === 'stateful' || entry.kind === 'replacement') {
      return { ok: false, missing: text.length, samples: [] };
    }

    var map = tableFor(id);
    var missing = 0;
    var samples = [];
    var seen = Object.create(null);
    for (var i = 0; i < text.length; i++) {
      var cp = text.codePointAt(i);
      if (cp > 0xffff) i++;
      if (map.has(cp)) continue;
      if (entry.kind === 'gb18030' && CE.gb18030 && CE.gb18030.canEncode(cp)) continue;      missing++;
      if (!seen[cp] && samples.length < 8) {
        seen[cp] = true;
        samples.push(String.fromCodePoint(cp));
      }
    }
    return { ok: missing === 0, missing: missing, samples: samples };
  }

  CE.codec = {
    decode: decode,
    encode: encode,
    checkEncodable: checkEncodable,
    tableFor: tableFor,
    decoderFor: decoderFor
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
