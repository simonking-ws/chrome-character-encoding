/**
 * 后台服务工作线程。
 *
 * 负责：
 *   1. 取回页面原始字节（连同 HTTP 响应头里声明的 charset）
 *   2. 提供编码检测与转码能力
 *   3. 记住“站点 -> 编码”的规则
 *   4. 响应内容脚本与弹窗的消息
 *
 * 说明：内容脚本通常会自己发起同源请求来取原始字节（这样能带上页面自己的
 * Cookie），后台脚本主要作为兜底，以及为没有内容脚本的页面（扩展商店等）
 * 提供检测能力。
 */
importScripts(
  '../lib/charsets.js',
  '../lib/legacy-tables.js',
  '../lib/gb18030-4byte.js',
  '../lib/text-codec.js',
  '../lib/detect.js'
);

const CE = self.CE;

/** 每个页面的缓存：原始字节 + 检测结果 */
const pageCache = new Map();

/** 站点编码规则：host -> charset id */
const RULES_KEY = 'siteRules';

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

async function getRules() {
  const stored = await chrome.storage.local.get(RULES_KEY);
  return stored[RULES_KEY] || {};
}

/** 从 URL 里取出用于匹配的 host */
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch (e) {
    return '';
  }
}

/** Uint8Array -> base64 */
function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/* ------------------------------------------------------------------ *
 * 取页面
 * ------------------------------------------------------------------ */

/**
 * 取回页面的原始字节。
 *
 * 直接再请求一次页面，拿到的是未经浏览器解码的原始数据——也就是浏览器
 * 显示乱码时“本应该”显示的内容。
 */
async function fetchPage(url) {
  const response = await fetch(url, {
    credentials: 'include',
    cache: 'no-store',
    redirect: 'follow'
  });
  const buffer = await response.arrayBuffer();
  const contentType = response.headers.get('content-type') || '';
  const match = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType);
  return {
    bytes: new Uint8Array(buffer),
    contentType,
    httpCharset: match ? match[1] : null,
    finalUrl: response.url || url
  };
}

/** 取回页面并缓存，带检测结果 */
async function getPage(url) {
  const cached = pageCache.get(url);
  if (cached) return cached;

  const page = await fetchPage(url);
  const detection = CE.detect.analyze(page.bytes, { httpCharset: page.httpCharset });
  const entry = { ...page, detection };
  pageCache.set(url, entry);
  return entry;
}

/* ------------------------------------------------------------------ *
 * 消息处理
 * ------------------------------------------------------------------ */

const handlers = {
  /** 检测当前页面的编码 */
  async detect({ url }) {
    const page = await getPage(url);
    return {
      charset: page.detection.charset,
      label: page.detection.label,
      confidence: page.detection.confidence,
      method: page.detection.method,
      declared: page.detection.declared,
      httpCharset: page.httpCharset,
      candidates: page.detection.candidates,
      contentType: page.contentType,
      finalUrl: page.finalUrl,
      byteLength: page.bytes.length
    };
  },

  /**
   * 按指定编码解码整个页面。
   * 同时返回原始字节（base64），便于内容脚本在本地完成解码。
   */
  async transcode({ url, charset }) {
    const page = await getPage(url);
    return {
      html: CE.codec.decode(page.bytes, charset),
      base64: bytesToBase64(page.bytes),
      httpCharset: page.httpCharset,
      charset,
      finalUrl: page.finalUrl
    };
  },

  /** 把文本编码成目标编码的字节，返回 base64 */
  async encode({ text, charset }) {
    const bytes = CE.codec.encode(text, charset);
    return { base64: bytesToBase64(bytes), length: bytes.length };
  },

  /**
   * 把整页转码成目标编码，供下载保存。
   *
   * 转码方向是“源编码 -> 目标编码”：先用源编码把原始字节解成文本，再按
   * 目标编码重新编码成字节。无法用目标编码表示的字符会被替换成问号，
   * 替换数量会一并返回，方便提示用户。
   */
  async exportPage({ url, from, to }) {
    const page = await getPage(url);
    const sourceCharset = from || page.detection.charset;
    const text = CE.codec.decode(page.bytes, sourceCharset);

    // 先检查目标编码能否完整表示页面内容
    const check = CE.codec.checkEncodable(text, to);

    // 目标文件的 <meta charset> 要改成目标编码，否则浏览器会用错编码打开
    const output = text.replace(
      /<meta[^>]*charset\s*=\s*["']?[^"'>;]*/gi,
      '<meta charset="' + to + '"'
    );
    const bytes = CE.codec.encode(output, to);

    return {
      base64: bytesToBase64(bytes),
      length: bytes.length,
      sourceCharset,
      targetCharset: to,
      missing: check.missing,
      samples: check.samples
    };
  },

  /** 读取/设置站点规则 */
  async getRule({ url }) {
    const rules = await getRules();
    return { host: hostOf(url), charset: rules[hostOf(url)] || null };
  },

  async setRule({ url, charset }) {
    const host = hostOf(url);
    const rules = await getRules();
    if (charset) {
      rules[host] = charset;
    } else {
      delete rules[host];
    }
    await chrome.storage.local.set({ [RULES_KEY]: rules });
    return { host, charset: charset || null };
  },

  /** 清空缓存 */
  async clearCache() {
    pageCache.clear();
    return { ok: true };
  }
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message && message.type];
  if (!handler) return false;
  Promise.resolve(handler(message.payload || {}, sender))
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: String((error && error.message) || error) }));
  return true; // 保持消息通道开放，等待异步响应
});
