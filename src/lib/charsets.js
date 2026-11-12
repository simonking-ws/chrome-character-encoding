/**
 * 字符编码注册表。
 *
 * 每条记录描述一种编码：
 *   id       内部唯一标识
 *   label    界面显示名称
 *   family   语系分组（用于界面分类与统计检测）
 *   whatwg   WHATWG Encoding Standard 标签（Chrome 的 TextDecoder 使用的名称）
 *   aliases  HTTP 头 / <meta charset> 中可能出现的别名
 *   script   该编码下期望出现的 Unicode 字符区间（统计检测用）
 *   encode   是否支持导出为该编码（需要反向码表）
 *   kind     编码结构，决定编码表的构建方式：
 *              utf8 / utf16le / utf16be / single（单字节）/ multi（多字节）
 *              gb18030（双字节 + 四字节）/ stateful（状态型，仅解码）
 *              replacement（替换字符）
 */
(function (root) {
  'use strict';

  var CE = (root.CE = root.CE || {});

  // Unicode 区间常量
  var R = {
    ascii: [0x00, 0x7f],
    latin1: [0xa0, 0xff],
    latinExt: [0x0100, 0x024f],
    cyrillic: [0x0400, 0x04ff],
    greek: [0x0370, 0x03ff],
    arabic: [0x0600, 0x06ff],
    hebrew: [0x0590, 0x05ff],
    thai: [0x0e00, 0x0e7f],
    cjk: [0x4e00, 0x9fff],
    cjkExt: [0x3400, 0x4dbf],
    kana: [0x3040, 0x30ff],
    hangul: [0xac00, 0xd7a3],
    cjkPunct: [0x3000, 0x303f],
    fullwidth: [0xff00, 0xffef],
    box: [0x2500, 0x257f],
    currency: [0x20a0, 0x20bf],
    punctuation: [0x2000, 0x206f]
  };

  /** 单字节 / 多字节编码的字符区间期望值 */
  var SCRIPT = {
    han: [R.cjk, R.cjkExt],
    kana: [R.kana],
    hangul: [R.hangul],
    cyrillic: [R.cyrillic],
    greek: [R.greek],
    arabic: [R.arabic],
    hebrew: [R.hebrew],
    thai: [R.thai],
    latin: [R.latin1, R.latinExt],
    none: []
  };

  var LIST = [
    // ---------- Unicode ----------
    { id: 'utf-8', label: 'UTF-8', family: 'unicode', whatwg: 'utf-8', aliases: ['utf8', 'u8', 'unicode-1-1-utf-8', 'utf-8'], kind: 'utf8', script: 'none', encode: true },
    { id: 'utf-16le', label: 'UTF-16 LE', family: 'unicode', whatwg: 'utf-16le', aliases: ['utf-16', 'utf16', 'utf16le', 'ucs-2', 'unicode', 'iso-10646-ucs-2'], kind: 'utf16le', script: 'none', encode: true },
    { id: 'utf-16be', label: 'UTF-16 BE', family: 'unicode', whatwg: 'utf-16be', aliases: ['utf16be', 'unicodefffe', 'utf-16be'], kind: 'utf16be', script: 'none', encode: true },

    // ---------- 简体中文 ----------
    { id: 'gbk', label: 'GBK / GB2312 (简体中文)', family: 'zh-cn', whatwg: 'gbk', aliases: ['gb2312', 'chinese', 'csgb2312', 'gb_2312', 'gb_2312-80', 'x-gbk', 'euc-cn', 'euccn', 'csiso58gb231280', 'gbk', 'ms936', 'cp936', 'windows-936'], kind: 'multi', script: 'han', encode: true },
    { id: 'gb18030', label: 'GB18030 (简体中文扩展)', family: 'zh-cn', whatwg: 'gb18030', aliases: ['gb18030', 'gb18030-2000', 'gb18030-2005'], kind: 'gb18030', script: 'han', encode: true },

    // ---------- 繁体中文 ----------
    { id: 'big5', label: 'Big5 (繁体中文)', family: 'zh-tw', whatwg: 'big5', aliases: ['big5', 'big-5', 'big5-hkscs', 'cn-big5', 'csbig5', 'x-x-big5', 'cp950'], kind: 'multi', script: 'han', encode: true },

    // ---------- 日文 ----------
    { id: 'shift_jis', label: 'Shift_JIS / CP932 (日文)', family: 'ja', whatwg: 'shift_jis', aliases: ['shift_jis', 'shift-jis', 'sjis', 'ms_kanji', 'ms932', 'cp932', 'windows-31j', 'x-sjis', 'csshiftjis'], kind: 'multi', script: 'kana', encode: true },
    { id: 'euc-jp', label: 'EUC-JP (日文)', family: 'ja', whatwg: 'euc-jp', aliases: ['euc-jp', 'eucjp', 'x-euc-jp', 'cseucpkdfmtjapanese', 'euc_jp'], kind: 'multi', script: 'kana', encode: true },
    { id: 'iso-2022-jp', label: 'ISO-2022-JP (日文)', family: 'ja', whatwg: 'iso-2022-jp', aliases: ['iso-2022-jp', 'iso2022jp', 'csiso2022jp', 'iso_2022_jp'], kind: 'stateful', script: 'kana', encode: false },

    // ---------- 韩文 ----------
    { id: 'euc-kr', label: 'EUC-KR / CP949 (韩文)', family: 'ko', whatwg: 'euc-kr', aliases: ['euc-kr', 'euckr', 'ksc5601', 'ks_c_5601-1987', 'ks_c_5601-1989', 'ksx1001', 'korean', 'csksc56011987', 'windows-949', 'uhc', 'cp949', '949'], kind: 'multi', script: 'hangul', encode: true },

    // ---------- 西里尔 ----------
    { id: 'windows-1251', label: 'Windows-1251 (西里尔)', family: 'cyrillic', whatwg: 'windows-1251', aliases: ['windows-1251', 'cp1251', '1251', 'ms-cyrl', 'x-cp1251'], kind: 'single', script: 'cyrillic', encode: true },
    { id: 'koi8-r', label: 'KOI8-R (西里尔)', family: 'cyrillic', whatwg: 'koi8-r', aliases: ['koi8-r', 'koi8r', 'cskoi8r'], kind: 'single', script: 'cyrillic', encode: true },
    { id: 'koi8-u', label: 'KOI8-U (西里尔)', family: 'cyrillic', whatwg: 'koi8-u', aliases: ['koi8-u', 'koi8u'], kind: 'single', script: 'cyrillic', encode: true },
    { id: 'iso-8859-5', label: 'ISO-8859-5 (西里尔)', family: 'cyrillic', whatwg: 'iso-8859-5', aliases: ['iso-8859-5', 'iso8859-5', 'iso_8859-5', 'cyrillic', 'csisolatincyrillic'], kind: 'single', script: 'cyrillic', encode: true },
    { id: 'ibm866', label: 'IBM866 / CP866 (西里尔)', family: 'cyrillic', whatwg: 'ibm866', aliases: ['ibm866', 'cp866', '866', 'csibm866'], kind: 'single', script: 'cyrillic', encode: true },
    { id: 'x-mac-cyrillic', label: 'Mac Cyrillic', family: 'cyrillic', whatwg: 'x-mac-cyrillic', aliases: ['x-mac-cyrillic', 'mac-cyrillic', 'maccyrillic'], kind: 'single', script: 'cyrillic', encode: true },

    // ---------- 希腊 / 土耳其 / 中东欧 ----------
    { id: 'windows-1253', label: 'Windows-1253 (希腊文)', family: 'el', whatwg: 'windows-1253', aliases: ['windows-1253', 'cp1253', '1253', 'ms-greek'], kind: 'single', script: 'greek', encode: true },
    { id: 'iso-8859-7', label: 'ISO-8859-7 (希腊文)', family: 'el', whatwg: 'iso-8859-7', aliases: ['iso-8859-7', 'iso8859-7', 'iso_8859-7', 'greek', 'greek8', 'ecma-118', 'elot_928'], kind: 'single', script: 'greek', encode: true },
    { id: 'windows-1254', label: 'Windows-1254 (土耳其文)', family: 'tr', whatwg: 'windows-1254', aliases: ['windows-1254', 'cp1254', '1254', 'ms-turk'], kind: 'single', script: 'latin', encode: true },
    { id: 'windows-1250', label: 'Windows-1250 (中东欧)', family: 'cee', whatwg: 'windows-1250', aliases: ['windows-1250', 'cp1250', '1250', 'ms-ee', 'x-cp1250'], kind: 'single', script: 'latin', encode: true },
    { id: 'iso-8859-2', label: 'ISO-8859-2 (中东欧)', family: 'cee', whatwg: 'iso-8859-2', aliases: ['iso-8859-2', 'iso8859-2', 'iso_8859-2', 'latin2', 'l2', 'csisolatin2'], kind: 'single', script: 'latin', encode: true },

    // ---------- 阿拉伯 / 希伯来 / 泰语 / 越南 ----------
    { id: 'windows-1256', label: 'Windows-1256 (阿拉伯文)', family: 'ar', whatwg: 'windows-1256', aliases: ['windows-1256', 'cp1256', '1256', 'ms-arab', 'asmo-708'], kind: 'single', script: 'arabic', encode: true },
    { id: 'iso-8859-6', label: 'ISO-8859-6 (阿拉伯文)', family: 'ar', whatwg: 'iso-8859-6', aliases: ['iso-8859-6', 'iso8859-6', 'iso_8859-6', 'arabic', 'ecma-114', 'asmo-708', 'csisolatinarabic'], kind: 'single', script: 'arabic', encode: true },
    { id: 'windows-1255', label: 'Windows-1255 (希伯来文)', family: 'he', whatwg: 'windows-1255', aliases: ['windows-1255', 'cp1255', '1255', 'ms-hebr'], kind: 'single', script: 'hebrew', encode: true },
    { id: 'iso-8859-8', label: 'ISO-8859-8 (希伯来文)', family: 'he', whatwg: 'iso-8859-8', aliases: ['iso-8859-8', 'iso8859-8', 'iso_8859-8', 'hebrew', 'csisolatinhebrew', 'visual'], kind: 'single', script: 'hebrew', encode: true },
    { id: 'windows-874', label: 'Windows-874 / TIS-620 (泰文)', family: 'th', whatwg: 'windows-874', aliases: ['windows-874', 'cp874', '874', 'tis-620', 'iso-8859-11'], kind: 'single', script: 'thai', encode: true },
    { id: 'windows-1258', label: 'Windows-1258 (越南文)', family: 'vn', whatwg: 'windows-1258', aliases: ['windows-1258', 'cp1258', '1258'], kind: 'single', script: 'latin', encode: true },

    // ---------- 西欧 / 其它 ----------
    { id: 'windows-1252', label: 'Windows-1252 (西欧)', family: 'we', whatwg: 'windows-1252', aliases: ['windows-1252', 'cp1252', '1252', 'ansi', 'x-ansi', 'ms-ansi'], kind: 'single', script: 'latin', encode: true },
    { id: 'iso-8859-1', label: 'ISO-8859-1 / Latin-1 (西欧)', family: 'we', whatwg: 'iso-8859-1', aliases: ['iso-8859-1', 'iso8859-1', 'iso_8859-1', 'latin1', 'l1', 'iso-ir-100', 'csisolatin1', '8859-1', 'cp819'], kind: 'single', script: 'latin', encode: true },
    { id: 'iso-8859-15', label: 'ISO-8859-15 / Latin-9 (西欧)', family: 'we', whatwg: 'iso-8859-15', aliases: ['iso-8859-15', 'iso8859-15', 'iso_8859-15', 'latin9', 'l9', 'csisolatin9'], kind: 'single', script: 'latin', encode: true },
    { id: 'iso-8859-3', label: 'ISO-8859-3 (西欧)', family: 'we', whatwg: 'iso-8859-3', aliases: ['iso-8859-3', 'iso8859-3', 'iso_8859-3', 'latin3', 'l3'], kind: 'single', script: 'latin', encode: true },
    { id: 'iso-8859-4', label: 'ISO-8859-4 (波罗的海)', family: 'we', whatwg: 'iso-8859-4', aliases: ['iso-8859-4', 'iso8859-4', 'iso_8859-4', 'latin4', 'l4'], kind: 'single', script: 'latin', encode: true },
    { id: 'iso-8859-10', label: 'ISO-8859-10 (北欧)', family: 'we', whatwg: 'iso-8859-10', aliases: ['iso-8859-10', 'iso8859-10', 'latin6', 'l6'], kind: 'single', script: 'latin', encode: true },
    { id: 'iso-8859-13', label: 'ISO-8859-13 (波罗的海)', family: 'we', whatwg: 'iso-8859-13', aliases: ['iso-8859-13', 'iso8859-13'], kind: 'single', script: 'latin', encode: true },
    { id: 'iso-8859-14', label: 'ISO-8859-14 (威尔士)', family: 'we', whatwg: 'iso-8859-14', aliases: ['iso-8859-14', 'iso8859-14'], kind: 'single', script: 'latin', encode: true },
    { id: 'iso-8859-16', label: 'ISO-8859-16 (东南欧)', family: 'we', whatwg: 'iso-8859-16', aliases: ['iso-8859-16', 'iso8859-16'], kind: 'single', script: 'latin', encode: true, fallback: 'iso-8859-16' },
    { id: 'macintosh', label: 'Mac Roman (西欧)', family: 'we', whatwg: 'macintosh', aliases: ['macintosh', 'mac', 'macroman', 'x-mac-roman', 'csmacintosh'], kind: 'single', script: 'latin', encode: true },
    { id: 'replacement', label: '替换字符 (乱码占位)', family: 'other', whatwg: 'replacement', aliases: ['replacement', 'csiso2022kr', 'hz-gb-2312', 'iso-2022-kr', 'unknown-8bit'], kind: 'replacement', script: 'none', encode: false }
  ];

  var FAMILY_LABELS = {
    unicode: 'Unicode',
    'zh-cn': '简体中文',
    'zh-tw': '繁体中文',
    ja: '日文',
    ko: '韩文',
    cyrillic: '西里尔文',
    el: '希腊文',
    tr: '土耳其文',
    cee: '中东欧',
    ar: '阿拉伯文',
    he: '希伯来文',
    th: '泰文',
    vn: '越南文',
    we: '西欧 / Latin',
    other: '其它'
  };

  var FAMILY_ORDER = [
    'unicode', 'zh-cn', 'zh-tw', 'ja', 'ko', 'cyrillic', 'el', 'tr',
    'cee', 'ar', 'he', 'th', 'vn', 'we', 'other'
  ];

  var byId = {};
  var aliasMap = {};

  LIST.forEach(function (entry) {
    byId[entry.id] = entry;
    entry.aliases.forEach(function (alias) {
      aliasMap[alias.toLowerCase()] = entry.id;
    });
    aliasMap[entry.id.toLowerCase()] = entry.id;
    aliasMap[entry.whatwg.toLowerCase()] = entry.id;
  });

  // 少数浏览器不实现的 WHATWG 标签，退回到自带码表
  var SUPPORTED = {};

  function canDecode(whatwg) {
    if (SUPPORTED[whatwg] !== undefined) return SUPPORTED[whatwg];
    var ok = true;
    try {
      /* eslint-disable no-new */
      new TextDecoder(whatwg);
    } catch (e) {
      ok = false;
    }
    SUPPORTED[whatwg] = ok;
    return ok;
  }

  CE.charsets = {
    list: LIST,
    byId: byId,
    ranges: R,
    scripts: SCRIPT,
    familyLabels: FAMILY_LABELS,
    familyOrder: FAMILY_ORDER,

    /** 通过 id 获取编码记录 */
    get: function (id) {
      return byId[id] || null;
    },

    /** 通过 HTTP 头 / meta 中出现的名字查找编码记录 */
    fromAlias: function (name) {
      if (!name) return null;
      var key = String(name).trim().toLowerCase().replace(/^["']|["']$/g, '');
      if (!key) return null;
      if (aliasMap[key]) return byId[aliasMap[key]];
      // 去掉常见的修饰后缀
      var stripped = key.replace(/[_:].*$/, '');
      if (aliasMap[stripped]) return byId[aliasMap[stripped]];
      return null;
    },

    /** 浏览器是否实现了该编码的解码器 */
    canDecode: canDecode,

    /** 该编码是否可用于导出（需要反向码表） */
    canEncode: function (id) {
      var entry = byId[id];
      return !!(entry && entry.encode);
    },

    /** 按语系分组返回编码列表 */
    grouped: function () {
      return FAMILY_ORDER.map(function (family) {
        return {
          family: family,
          label: FAMILY_LABELS[family],
          items: LIST.filter(function (e) {
            return e.family === family;
          })
        };
      }).filter(function (g) {
        return g.items.length > 0;
      });
    },

    /** 列出全部别名（用于文档/调试） */
    aliasCount: function () {
      return Object.keys(aliasMap).length;
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
