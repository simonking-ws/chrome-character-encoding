/**
 * 字符编码检测。
 *
 * 检测顺序（与浏览器行为一致，优先级由高到低）：
 *   1. BOM —— 最可靠，直接确定编码
 *   2. UTF-16 字节特征（无 BOM 时）
 *   3. HTTP 响应头 charset
 *   4. 文档内 <meta charset> / http-equiv
 *   5. 统计检测 —— 在没有任何声明时推断
 *
 * 统计检测的难点在于：单字节编码会把任意高位字节映射成某种文字，所以
 * “解码后落在某个文字区间”几乎无法区分候选。真正的判据是“解码结果像不像
 * 某种语言”，而这要用语言自身的统计特征来判断：
 *
 *   · 有分词的语言（西里尔、希腊、阿拉伯、希伯来、土耳其、中东欧、
 *     越南、西欧）—— 用常用词命中率。误判成别的编码时，词边界与词形
 *     都会被破坏，命中率迅速归零。
 *   · 不分词的语言（中日韩、泰语）—— 用高频字命中率。中日韩常用字占比
 *     很高，而乱码几乎不会命中。
 *
 * 另外还要用“文字纯度”做门槛：解码结果里该文字区间的字符占比过低时直接
 * 淘汰，避免跨文字的误判。
 */
(function (root) {
  'use strict';

  var CE = (root.CE = root.CE || {});

  /* ------------------------------------------------------------------ *
   * 语言特征
   * ------------------------------------------------------------------ */

  // 简体高频字
  var ZH_HANS_T1 = '的一是不了人我在有他这中大来上们到说国和地也子时道出而要于就下得可你年生自会那后能对着事其里所去行过家十用发天如然作方成者多日都三小军二无同么经法当起与好看学进种将还分此心前面又定见只主没公从又不没而之者所以但如果因为以及而且或者';
  // 繁体高频字
  var ZH_HANT_T1 = '的一是不了人我在有他這中大來上們到說國和地也子時道出而要於就下得可你年生自會那後能對著事其裡所去行過家十用發天如然作方成者多日都三小軍二無同麼經法當起與好看學進種將還分此心前面又定見只主沒公從又不沒而之者所以但如果因為以及而且或者';
  // 只在简体中出现的字（用于区分 GBK 与 Big5）
  var ZH_SIMPLIFIED_ONLY = '这国说时会来对开过还没发经进着电车东门书长马鸟龙飞风汉单双产业义乐习乡们个为还样后现点从体机制应当区专务贝币银钟轻输转获气氛营听题读说话时间问网络认识数据系统实现应该种样标准开发技术员后们严';
  // 只在繁体中出现的字
  var ZH_TRADITIONAL_ONLY = '這國說時會來對開過還沒發經進著電車東門書長馬鳥龍飛風漢單雙產業義樂習鄉們個為還樣後現點從體機制應當區專務貝幣銀鐘輕輸轉獲氣氛營聽題讀說話時間問網絡認識數據系統實現應該種樣標準開發技術員後們嚴';

  // 日文假名
  var JA_T1 = 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをんアイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲンガギグゲゴザジズゼゾダヂヅデドバビブベボパピプペポ';

  // 韩文常用音节
  var KO_T1 = '이그저은는을가고한지있다없다되등와한로무사도시나사람년월일시간정국대학교회사어부것때중내외그거하나우리누가';

  // 泰文高频字符
  var TH_T1 = 'ารนอกเงมยวลปสหคดตจบใไโเป็นและที่มีให้ได้ไม่จะการความันกับนี้แต่จากเมื่อก็ยังอยู่ทำบางใช้';
  // 泰文声调符号与元音符号：真实泰文里这些组合标记大量出现，
  // 而随机字节解码出来的泰文不会有合理的组合结构
  var TH_MARKS = '่้๊๋์ํ็่';

  // 常用词（用于有分词的语言）
  var WORDS = {
    ru: 'и в не на я быть он с что а по это она этот к но они мы как из у который то за свой весь год от так для о ты все же до время так же когда даже сейчас знаю здесь только или ещё очень после потом потому ничего',
    el: 'και το της των στο με για από που είναι τα οι δεν σε ένα έναν τον την της του τις να ως όταν όπως αν αλλά κάθε όλα πολύ',
    ar: 'في من على إلى عن مع هذا هذه ذلك التي الذي كان لا ما هو هي كل بعد أن بين قد لم لن يكون هناك هذه التي على',
    he: 'של את על לא זה הוא היא עם כל אחרי יש אני אתה אנחנו הם לפי כי אם גם רק אבל או אז אשר',
    tr: 'bir ve bu için ile daha çok olarak olan gibi ama veya her bana sen biz siz onlar benim senin bizim olarak vardı değil olan şey',
    cee: 'a v na se je že pro to ale jako který jsou byl jsem nebo tak již však také po tom kde kterými češtině kůň příliš žluťoučký ďábelské šest oběžník všechen',
    vn: 'và của là các có trong được cho những một này với không người khi đã cũng như về từ để nhưng thì đó',
    we: 'the and for that with this from have are was not but they you all can her when there been more about which their would'
  };

  /**
   * 各语言的文字区间。
   *
   * 拉丁字母系的语言都共用 Latin-1 补充区（0xA0-0xFF）与拉丁扩展区，
   * 因为 é、á、í 这类带音标的字母在任何欧洲语言里都很常见。它们的区分
   * 靠常用词表，而不是靠文字区间。
   */
  var SCRIPTS = {
    han: [[0x4e00, 0x9fff], [0x3400, 0x4dbf], [0xf900, 0xfaff]],
    kana: [[0x3040, 0x30ff], [0x31f0, 0x31ff]],
    hangul: [[0xac00, 0xd7a3], [0x1100, 0x11ff], [0x3130, 0x318f]],
    cyrillic: [[0x0400, 0x04ff], [0x0500, 0x052f]],
    greek: [[0x0370, 0x03ff], [0x1f00, 0x1fff]],
    arabic: [[0x0600, 0x06ff], [0x0750, 0x077f], [0xfb50, 0xfdff], [0xfe70, 0xfeff]],
    hebrew: [[0x0590, 0x05ff], [0xfb1d, 0xfb4f]],
    thai: [[0x0e00, 0x0e7f]],
    latin: [[0x00a0, 0x024f], [0x1e00, 0x1eff]],
    latinExt: [[0x00a0, 0x024f], [0x1e00, 0x1eff]],
    turkish: [[0x00a0, 0x024f], [0x1e00, 0x1eff]],
    vietnamese: [[0x00a0, 0x024f], [0x1e00, 0x1eff]]
  };

  /**
   * 候选编码表。
   *   script  期望的文字区间
   *   lang    语言模型名
   *   spaced  该语言是否用空格分词（决定用词命中率还是字命中率）
   */
  var CANDIDATES = [
    { id: 'gbk', script: 'han', lang: 'zh-hans' },
    { id: 'gb18030', script: 'han', lang: 'zh-hans' },
    { id: 'big5', script: 'han', lang: 'zh-hant' },
    { id: 'shift_jis', script: 'kana', lang: 'ja' },
    { id: 'euc-jp', script: 'kana', lang: 'ja' },
    { id: 'euc-kr', script: 'hangul', lang: 'ko' },
    { id: 'windows-1251', script: 'cyrillic', lang: 'ru' },
    { id: 'koi8-r', script: 'cyrillic', lang: 'ru' },
    { id: 'koi8-u', script: 'cyrillic', lang: 'ru' },
    { id: 'iso-8859-5', script: 'cyrillic', lang: 'ru' },
    { id: 'ibm866', script: 'cyrillic', lang: 'ru' },
    { id: 'x-mac-cyrillic', script: 'cyrillic', lang: 'ru' },
    { id: 'windows-1253', script: 'greek', lang: 'el' },
    { id: 'iso-8859-7', script: 'greek', lang: 'el' },
    { id: 'windows-1256', script: 'arabic', lang: 'ar' },
    { id: 'iso-8859-6', script: 'arabic', lang: 'ar' },
    { id: 'windows-1255', script: 'hebrew', lang: 'he' },
    { id: 'iso-8859-8', script: 'hebrew', lang: 'he' },
    { id: 'windows-874', script: 'thai', lang: 'th' },
    { id: 'windows-1254', script: 'turkish', lang: 'tr' },
    { id: 'windows-1250', script: 'latinExt', lang: 'cee' },
    { id: 'iso-8859-2', script: 'latinExt', lang: 'cee' },
    { id: 'windows-1258', script: 'vietnamese', lang: 'vn' },
    { id: 'windows-1252', script: 'latin', lang: 'we' },
    { id: 'iso-8859-15', script: 'latin', lang: 'we' },
    { id: 'macintosh', script: 'latin', lang: 'we' }
  ];

  /** 语言模型 */
  var MODELS = {
    'zh-hans': { t1: ZH_HANS_T1, spaced: false },
    'zh-hant': { t1: ZH_HANT_T1, spaced: false },
    ja: { t1: JA_T1, spaced: false },
    ko: { t1: KO_T1, spaced: false },
    th: { t1: TH_T1, spaced: false },
    ru: { words: WORDS.ru, spaced: true },
    el: { words: WORDS.el, spaced: true },
    ar: { words: WORDS.ar, spaced: true },
    he: { words: WORDS.he, spaced: true },
    tr: { words: WORDS.tr, spaced: true },
    cee: { words: WORDS.cee, spaced: true },
    vn: { words: WORDS.vn, spaced: true },
    we: { words: WORDS.we, spaced: true }
  };

  var modelCache = Object.create(null);

  function modelFor(name) {
    if (modelCache[name]) return modelCache[name];
    var model = MODELS[name] || {};
    var built = {
      spaced: !!model.spaced,
      t1: Object.create(null),
      words: Object.create(null)
    };
    if (model.t1) {
      for (var i = 0; i < model.t1.length; i++) built.t1[model.t1[i]] = true;
    }
    if (model.words) {
      var list = model.words.split(' ');
      for (var j = 0; j < list.length; j++) {
        if (list[j]) built.words[list[j]] = true;
      }
    }
    modelCache[name] = built;
    return built;
  }

  function inRanges(cp, ranges) {
    for (var i = 0; i < ranges.length; i++) {
      if (cp >= ranges[i][0] && cp <= ranges[i][1]) return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------ *
   * 基础工具
   * ------------------------------------------------------------------ */

  /** 把字节按 latin1 解码，便于用正则扫描 ASCII 结构 */
  function latin1(bytes, limit) {
    var len = Math.min(bytes.length, limit || 8192);
    var chunks = [];
    for (var i = 0; i < len; i += 8192) {
      chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 8192, len))));
    }
    return chunks.join('');
  }

  /** 检测 BOM */
  function detectBom(bytes) {
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      return { charset: 'utf-8', bomLength: 3 };
    }
    if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xfe &&
        bytes[2] === 0x00 && bytes[3] === 0x00) {
      return { charset: 'utf-32le', bomLength: 4 };
    }
    if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x00 &&
        bytes[2] === 0xfe && bytes[3] === 0xff) {
      return { charset: 'utf-32be', bomLength: 4 };
    }
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      return { charset: 'utf-16le', bomLength: 2 };
    }
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      return { charset: 'utf-16be', bomLength: 2 };
    }
    return null;
  }

  /** 从 HTML 头部找 <meta charset> 或 http-equiv */
  function detectMetaCharset(bytes) {
    var head = latin1(bytes, 8192);
    var re = /<meta[^>]*charset\s*=\s*["']?\s*([a-zA-Z0-9_\-:.]+)/gi;
    var m;
    var found = null;
    while ((m = re.exec(head)) !== null) {
      var name = m[1].toLowerCase();
      if (!found) found = name;
      // http-equiv 指定的 Content-Type 优先级更高
      if (/http-equiv/i.test(m[0])) return name;
    }
    return found;
  }

  /** 严格校验 UTF-8 */
  function isValidUtf8(bytes, limit) {
    var len = Math.min(bytes.length, limit || 65536);
    var i = 0;
    var multibyte = 0;
    while (i < len) {
      var b = bytes[i];
      if (b < 0x80) { i++; continue; }
      var extra;
      var min;
      if (b >= 0xc2 && b <= 0xdf) { extra = 1; min = 0x80; }
      else if (b >= 0xe0 && b <= 0xef) { extra = 2; min = 0x800; }
      else if (b >= 0xf0 && b <= 0xf4) { extra = 3; min = 0x10000; }
      else return false;
      if (i + extra >= len) {
        // 末尾被截断的多字节序列不算错误
        return multibyte > 0;
      }
      var cp = b & (0x7f >> extra);
      for (var k = 1; k <= extra; k++) {
        var c = bytes[i + k];
        if ((c & 0xc0) !== 0x80) return false;
        cp = (cp << 6) | (c & 0x3f);
      }
      if (cp < min) return false;
      if (cp > 0x10ffff) return false;
      if (cp >= 0xd800 && cp <= 0xdfff) return false;
      multibyte++;
      i += extra + 1;
    }
    return true;
  }

  /** 统计 UTF-16 特征（大量 NUL 字节） */
  function looksUtf16(bytes) {
    var len = Math.min(bytes.length, 4096);
    if (len < 4) return null;
    var evenZero = 0;
    var oddZero = 0;
    var pairs = 0;
    for (var i = 0; i + 1 < len; i += 2) {
      pairs++;
      if (bytes[i] === 0) evenZero++;
      if (bytes[i + 1] === 0) oddZero++;
    }
    if (pairs === 0) return null;
    if (oddZero / pairs > 0.4 && evenZero / pairs < 0.1) return 'utf-16le';
    if (evenZero / pairs > 0.4 && oddZero / pairs < 0.1) return 'utf-16be';
    return null;
  }

  /** 字节里是否存在非 ASCII 字节 */
  function hasMultibyte(bytes, limit) {
    var len = Math.min(bytes.length, limit || 65536);
    for (var i = 0; i < len; i++) {
      if (bytes[i] >= 0x80) return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------ *
   * 统计检测
   * ------------------------------------------------------------------ */

  /** 提取词（按非字母数字切分） */
  var TOKEN_RE = /[^\p{L}\p{N}]+/u;

  function tokenize(text) {
    var parts = text.split(TOKEN_RE);
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      if (parts[i]) out.push(parts[i]);
    }
    return out;
  }

  /** 词命中率：命中常用词的字符数占总字符数的比例 */
  function wordHitRate(text, model) {
    var tokens = tokenize(text);
    if (!tokens.length) return 0;
    var hitChars = 0;
    var totalChars = 0;
    for (var i = 0; i < tokens.length; i++) {
      var token = tokens[i].toLowerCase();
      if (token.length < 2) continue;
      totalChars += token.length;
      if (model.words[token]) hitChars += token.length;
    }
    if (!totalChars) return 0;
    return hitChars / totalChars;
  }

  /** 高频字命中率（只统计非 ASCII 字符） */
  function charHitRate(text, model) {
    var hits = 0;
    var total = 0;
    for (var i = 0; i < text.length; i++) {
      var cp = text.charCodeAt(i);
      if (cp < 0x80) continue;
      total++;
      if (model.t1[text[i]]) hits++;
    }
    if (!total) return 0;
    return hits / total;
  }

  /**
   * 随机字节基准。
   *
   * 不同文字的“常用字密度”差别很大：中文常用字只占两万字中的百来个，
   * 而泰文常用字占了整个泰文区的一半。若直接比较命中率，泰文会永远赢。
   *
   * 解决办法是用同一编码去解码一段固定的高位随机字节，量出“碰运气能命中
   * 多少”——这就是该编码的基准线。再把实际命中率换算成相对基准线的
   * 显著度（Z 分数），不同文字之间就可以直接比较了。
   */
  var chanceCache = Object.create(null);
  var RANDOM_BYTES = null;

  function randomHighBytes() {
    if (RANDOM_BYTES) return RANDOM_BYTES;
    // 固定种子的线性同余序列，保证每次运行结果一致
    var seed = 0x2545f491;
    var buf = new Uint8Array(4096);
    for (var i = 0; i < buf.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      buf[i] = 0x80 + (seed >>> 16) % 0x80;
    }
    RANDOM_BYTES = buf;
    return buf;
  }

  /** 某编码在随机字节下的命中基准 */
  function chanceRate(charsetId, model, measure) {
    var key = charsetId + ':' + (measure === 'word' ? 'w' : 'c');
    if (chanceCache[key] !== undefined) return chanceCache[key];
    var rate = 0;
    var entry = CE.charsets.get(charsetId);
    if (entry) {
      try {
        var dec = new TextDecoder(entry.whatwg);
        var text = dec.decode(randomHighBytes());
        rate = measure === 'word' ? wordHitRate(text, model) : charHitRate(text, model);
      } catch (e) {
        rate = 0;
      }
    }
    chanceCache[key] = rate;
    return rate;
  }

  /**
   * 命中率相对基准线的显著度（Z 分数）。
   * 命中越多、样本越大，越显著。
   */
  function significance(observed, chance, n) {
    if (!n) return 0;
    if (chance <= 0) {
      // 基准为 0 时，只要命中就有意义
      return observed > 0 ? Math.min(40, n * observed * 2) : 0;
    }
    var variance = chance * (1 - chance) / n;
    if (variance <= 0) return 0;
    var z = (observed - chance) / Math.sqrt(variance);
    return Math.max(0, z);
  }


  /**
   * 给一个候选编码打分。
   * @returns {{score: number, purity: number, detail: string}|null}
   */
  function scoreCandidate(bytes, candidate, sampleLen) {
    var entry = CE.charsets.get(candidate.id);
    if (!entry) return null;

    var dec;
    try {
      dec = new TextDecoder(entry.whatwg, { fatal: true });
    } catch (e) {
      return null; // 浏览器不支持该标签
    }

    var sample = bytes.length > sampleLen ? bytes.subarray(0, sampleLen) : bytes;
    var text;
    try {
      text = dec.decode(sample);
    } catch (e) {
      return null; // 不是合法的该编码
    }
    if (!text.length) return null;

    var scriptRanges = SCRIPTS[candidate.script] || [];
    var model = modelFor(candidate.lang);

    // 文字纯度
    var nonAscii = 0;
    var inScript = 0;
    for (var i = 0; i < text.length; i++) {
      var cp = text.charCodeAt(i);
      if (cp < 0x80) continue;
      nonAscii++;
      if (inRanges(cp, scriptRanges)) inScript++;
    }
    if (!nonAscii) return null;
    var purity = inScript / nonAscii;
    if (purity < 0.5) return null;

    var score;
    var detail;

    if (model.spaced) {
      // 有分词的语言：常用词命中率是主要判据
      var wr = wordHitRate(text, model);
      var cr = charHitRate(text, model);
      // 词命中率同样要相对基准线：不同语言词表大小不同，绝对值不可比
      var wordChance = chanceRate(candidate.id, model, 'word');
      var wordZ = significance(wr, wordChance, text.length);
      score = wordZ * 3 + cr * 10;
      detail = 'word=' + wr.toFixed(3) + ' z=' + wordZ.toFixed(2) + ' char=' + cr.toFixed(3);
    } else {
      // 不分词的语言：高频字命中率相对随机基准的显著度
      var rate = charHitRate(text, model);
      var chance = chanceRate(candidate.id, model, 'char');
      var z = significance(rate, chance, nonAscii);
      score = z;
      detail = 'char=' + rate.toFixed(3) + ' chance=' + chance.toFixed(3) + ' z=' + z.toFixed(2);

      // 简繁倾向：GBK 偏好简体，Big5 偏好繁体
      if (candidate.lang === 'zh-hans' || candidate.lang === 'zh-hant') {
        var simp = 0;
        var trad = 0;
        for (var j = 0; j < text.length; j++) {
          var ch = text[j];
          if (zhSimplifiedOnly[ch]) simp++;
          else if (zhTraditionalOnly[ch]) trad++;
        }
        var bias = (candidate.lang === 'zh-hans' ? (simp - trad) : (trad - simp)) / nonAscii;
        score += bias * 40;
        detail += ' bias=' + bias.toFixed(3);
      }
    }

    // 纯度越高越可信
    return { score: score * (0.6 + 0.4 * purity), purity: purity, detail: detail };
  }

  var zhSimplifiedOnly = Object.create(null);
  var zhTraditionalOnly = Object.create(null);
  (function () {
    for (var i = 0; i < ZH_SIMPLIFIED_ONLY.length; i++) zhSimplifiedOnly[ZH_SIMPLIFIED_ONLY[i]] = true;
    for (var j = 0; j < ZH_TRADITIONAL_ONLY.length; j++) zhTraditionalOnly[ZH_TRADITIONAL_ONLY[j]] = true;
  })();

  /**
   * 统计检测主入口。
   * @returns {{charset: string, confidence: number, candidates: Array}}
   */
  function detectStatistical(bytes, sampleLen) {
    var len = sampleLen || 65536;
    var scored = [];
    for (var i = 0; i < CANDIDATES.length; i++) {
      var cand = CANDIDATES[i];
      var result = scoreCandidate(bytes, cand, len);
      if (!result || result.score <= 0) continue;
      scored.push({ charset: cand.id, score: result.score, detail: result.detail });
    }
    scored.sort(function (a, b) { return b.score - a.score; });

    if (!scored.length) {
      return { charset: 'windows-1252', confidence: 0.1, candidates: [] };
    }

    var best = scored[0];
    var second = scored[1];
    // 置信度取决于领先幅度
    var margin = second ? (best.score - second.score) / (best.score || 1) : 1;
    var confidence = Math.max(0.1, Math.min(0.95, 0.25 + margin * 0.45 + Math.min(best.score, 1) * 0.3));

    return {
      charset: best.charset,
      confidence: confidence,
      candidates: scored.slice(0, 6).map(function (item) {
        return {
          charset: item.charset,
          score: Math.round(item.score * 1000) / 1000,
          detail: item.detail
        };
      })
    };
  }

  /* ------------------------------------------------------------------ *
   * 对外接口
   * ------------------------------------------------------------------ */

  /**
   * 综合分析一段字节的编码。
   *
   * @param {Uint8Array} bytes 原始字节
   * @param {{httpCharset?: string, sampleLength?: number}} [options]
   */
  function analyze(bytes, options) {
    options = options || {};
    var sampleLength = options.sampleLength || 65536;
    var statistical = { charset: null, confidence: 0, candidates: [] };

    // 1. BOM
    var bom = detectBom(bytes);
    if (bom) {
      var bomEntry = CE.charsets.get(bom.charset) ||
        CE.charsets.fromAlias(bom.charset) || CE.charsets.get('utf-8');
      return result(bomEntry, 1, 'bom', bom.charset, statistical);
    }

    // 2. UTF-16 特征
    var utf16 = looksUtf16(bytes);
    if (utf16) {
      return result(CE.charsets.get(utf16), 0.9, 'utf16-pattern', null, statistical);
    }

    // 3. 统计检测（先算，用于验证声明是否可信）
    statistical = detectStatistical(bytes, sampleLength);

    // 4. HTTP 头声明
    var declared = options.httpCharset ? String(options.httpCharset).trim().toLowerCase() : null;
    if (declared) {
      var httpEntry = CE.charsets.fromAlias(declared);
      if (httpEntry) {
        // 声明的编码解不出合法结果时，说明声明不可信，退回统计检测
        var valid = isDecodable(bytes, httpEntry, sampleLength);
        if (valid) {
          return result(httpEntry, 0.9, 'http-header', declared, statistical);
        }
        var statFallback = CE.charsets.get(statistical.charset);
        return result(statFallback, Math.min(0.6, statistical.confidence),
          'statistical (声明的 ' + declared + ' 无法解码)', declared, statistical);
      }
    }

    // 5. meta 声明
    var metaName = detectMetaCharset(bytes);
    if (metaName) {
      var metaEntry = CE.charsets.fromAlias(metaName);
      if (metaEntry) {
        var metaValid = isDecodable(bytes, metaEntry, sampleLength);
        if (metaValid) {
          return result(metaEntry, 0.85, 'meta-tag', metaName, statistical);
        }
        var statFallback2 = CE.charsets.get(statistical.charset);
        return result(statFallback2, Math.min(0.6, statistical.confidence),
          'statistical (meta 声明的 ' + metaName + ' 无法解码)', metaName, statistical);
      }
    }

    // 6. 纯 UTF-8 判定
    if (isValidUtf8(bytes, sampleLength) && hasMultibyte(bytes, sampleLength)) {
      return result(CE.charsets.get('utf-8'), 0.95, 'utf-8-validation', null, statistical);
    }

    // 7. 纯 ASCII —— UTF-8 与所有单字节编码结果相同，取 UTF-8
    if (!hasMultibyte(bytes, sampleLength)) {
      return result(CE.charsets.get('utf-8'), 0.6, 'ascii', null, statistical);
    }

    // 8. 统计检测
    return result(CE.charsets.get(statistical.charset) || CE.charsets.get('windows-1252'),
      statistical.confidence, 'statistical', null, statistical);
  }

  function result(entry, confidence, method, declared, statistical) {
    return {
      charset: entry.id,
      label: entry.label,
      confidence: confidence,
      method: method,
      declared: declared,
      statistical: statistical,
      candidates: statistical.candidates
    };
  }

  /** 用 fatal 模式验证字节能否被该编码合法解码 */
  function isDecodable(bytes, entry, sampleLength) {
    if (entry.kind === 'replacement') return true;
    var dec;
    try {
      dec = new TextDecoder(entry.whatwg, { fatal: true });
    } catch (e) {
      // 浏览器不支持但扩展自带码表时，视为可解码
      return !!(entry.fallback && CE.legacyTables && CE.legacyTables[entry.fallback]);
    }
    var sample = bytes.length > (sampleLength || 65536)
      ? bytes.subarray(0, sampleLength || 65536)
      : bytes;
    try {
      dec.decode(sample);
      return true;
    } catch (e) {
      return false;
    }
  }

  CE.detect = {
    analyze: analyze,
    detectBom: detectBom,
    detectMetaCharset: detectMetaCharset,
    isValidUtf8: isValidUtf8,
    detectStatistical: detectStatistical,
    hasMultibyte: hasMultibyte,
    // 供调试与测试使用
    _scoreCandidate: scoreCandidate,
    _candidates: CANDIDATES
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
