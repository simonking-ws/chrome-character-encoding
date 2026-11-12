/**
 * 内容脚本：在页面内完成编码切换。
 *
 * 核心思路是“取回原始字节、重新解码、就地替换文本”，而不是刷新页面：
 *
 *   1. 后台脚本取回页面的原始字节。浏览器已经按自己猜的编码解码过一遍，
 *      此时页面上显示的是乱码，原始字节才是正确内容的来源。
 *   2. 用用户选定的编码重新解码，得到正确的 HTML 文本。
 *   3. 把新解析出来的文档与当前文档逐一对齐，只替换文本节点和属性值。
 *      这样脚本、事件绑定、样式、表单状态都原样保留，不像重新加载那样
 *      丢掉页面状态。
 *
 * 第 3 步之所以可行，是因为 HTML 的标签分隔符都是 ASCII 字节，而所有
 * ASCII 兼容编码（GBK、Big5、Shift_JIS、EUC-JP、EUC-KR 以及各种单字节
 * 编码）都不会把 ASCII 字节吃进多字节序列里。因此无论按哪种编码解析，
 * 文档的元素结构和文本节点的切分位置都是一致的，只有文本内容不同。
 *
 * 遇到 UTF-16 这类非 ASCII 兼容编码，或页面脚本改动过 DOM 导致结构
 * 对不上时，则退回整页替换。
 */
(function () {
  'use strict';

  var CE = window.CE;

  /** 页面状态 */
  var state = {
    /** 当前生效的编码 id */
    charset: null,
    /** 浏览器最初使用的编码 */
    originalCharset: null,
    /** 原始 DOM 文本快照，用于“还原” */
    snapshot: null,
    /** 是否已改写过页面 */
    modified: false,
    /** 是否整页替换过（替换后无法就地还原，只能重新加载） */
    replaced: false,
    /** 是否已经做过字节级检测 */
    detected: false
  };

  /* ------------------------------------------------------------------ *
   * 与后台脚本通信
   * ------------------------------------------------------------------ */

  function send(type, payload) {
    return new Promise(function (resolve, reject) {
      chrome.runtime.sendMessage({ type: type, payload: payload }, function (response) {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response || !response.ok) {
          reject(new Error((response && response.error) || '未知错误'));
          return;
        }
        resolve(response.result);
      });
    });
  }

  /* ------------------------------------------------------------------ *
   * 取回页面原始字节
   * ------------------------------------------------------------------ */

  /**
   * 取回当前页面的原始字节。
   *
   * 优先由内容脚本自己发起同源请求：这样带上的是页面自己的 Cookie，
   * 登录后才能看到的页面也能正确处理。若请求失败（例如页面 CSP 限制了
   * connect-src），再退回后台脚本代取。
   *
   * @returns {Promise<{bytes: Uint8Array, httpCharset: string|null}>}
   */
  async function fetchPageBytes() {
    try {
      var response = await fetch(location.href, {
        credentials: 'include',
        cache: 'no-store',
        redirect: 'follow'
      });
      if (response.ok) {
        var buffer = await response.arrayBuffer();
        var contentType = response.headers.get('content-type') || '';
        var match = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType);
        return {
          bytes: new Uint8Array(buffer),
          httpCharset: match ? match[1] : null
        };
      }
    } catch (error) {
      // 交给后台脚本处理
    }

    var result = await send('transcode', { url: location.href, charset: state.charset });
    var bytes = base64ToBytes(result.base64);
    return { bytes: bytes, httpCharset: result.httpCharset || null };
  }

  function base64ToBytes(base64) {
    var binary = atob(base64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  /* ------------------------------------------------------------------ *
   * 文本同步
   * ------------------------------------------------------------------ */

  /** 按文档顺序收集所有文本节点 */
  function collectTextNodes(root) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var nodes = [];
    var node;
    while ((node = walker.nextNode())) {
      nodes.push(node);
    }
    return nodes;
  }

  /** 按文档顺序收集所有元素 */
  function collectElements(root) {
    return Array.prototype.slice.call(root.querySelectorAll('*'));
  }

  /**
   * 把 source 文档的文本与属性同步到 target 文档。
   *
   * @param {Document} target 当前页面文档
   * @param {Document} source 按目标编码解析出来的新文档
   * @returns {boolean} 是否同步成功
   */
  function syncDocuments(target, source) {
    var targetTexts = collectTextNodes(target.documentElement);
    var sourceTexts = collectTextNodes(source.documentElement);

    // 文本节点数量必须一致，否则说明页面结构已被改动，无法安全对齐
    if (targetTexts.length !== sourceTexts.length) return false;

    for (var i = 0; i < targetTexts.length; i++) {
      if (targetTexts[i].nodeValue !== sourceTexts[i].nodeValue) {
        targetTexts[i].nodeValue = sourceTexts[i].nodeValue;
      }
    }

    // 元素数量一致时，同步属性值（只改两边都有的属性，避免破坏事件绑定）
    var targetEls = collectElements(target.documentElement);
    var sourceEls = collectElements(source.documentElement);
    if (targetEls.length === sourceEls.length) {
      for (var j = 0; j < targetEls.length; j++) {
        var targetEl = targetEls[j];
        var sourceEl = sourceEls[j];
        var attrs = sourceEl.attributes;
        for (var k = 0; k < attrs.length; k++) {
          var attr = attrs[k];
          if (targetEl.hasAttribute(attr.name) &&
              targetEl.getAttribute(attr.name) !== attr.value) {
            targetEl.setAttribute(attr.name, attr.value);
          }
        }
      }
    }

    return true;
  }

  /** 记录当前文档的文本内容，用于“还原” */
  function takeSnapshot() {
    return collectTextNodes(document.documentElement).map(function (node) {
      return { node: node, value: node.nodeValue };
    });
  }

  function restoreSnapshot(snapshot) {
    for (var i = 0; i < snapshot.length; i++) {
      var item = snapshot[i];
      if (item.node && item.node.isConnected) {
        item.node.nodeValue = item.value;
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * 应用编码
   * ------------------------------------------------------------------ */

  /**
   * 用指定编码重新渲染页面。
   * @param {string} charset 编码 id
   * @returns {Promise<boolean>}
   */
  async function applyCharset(charset) {
    var html;
    try {
      var page = await fetchPageBytes();
      html = CE.codec.decode(page.bytes, charset);
    } catch (error) {
      showToast('无法获取页面内容：' + error.message, 'error');
      return false;
    }

    // 首次改动前先留一份原始文本，之后可以还原
    if (!state.snapshot) state.snapshot = takeSnapshot();

    var parsed = new DOMParser().parseFromString(html, 'text/html');
    if (!syncDocuments(document, parsed)) {
      // 结构对不上（例如页面被脚本改过），退回整页替换
      replaceWholeDocument(html);
      state.replaced = true;
    }

    state.charset = charset;
    state.modified = true;
    updateToolbar();
    showToast('已按 ' + charsetLabel(charset) + ' 重新解码');
    return true;
  }

  /** 整页替换（结构无法对齐时的兜底方案） */
  function replaceWholeDocument(html) {
    // document.write 会按当前页面地址解析相对路径
    document.open();
    document.write(html);
    document.close();
  }

  /** 还原成浏览器最初的解码结果 */
  async function restoreOriginal() {
    if (!state.modified) {
      showToast('页面尚未被修改');
      return;
    }
    // 整页替换过之后旧节点已经不存在，只能重新加载
    if (state.snapshot && !state.replaced) {
      restoreSnapshot(state.snapshot);
      state.modified = false;
      state.charset = state.originalCharset;
      updateToolbar();
      showToast('已还原为浏览器原始解码结果');
      return;
    }
    location.reload();
  }

  function charsetLabel(id) {
    var entry = CE.charsets.get(id);
    return entry ? entry.label : id;
  }

  /* ------------------------------------------------------------------ *
   * 工具栏
   * ------------------------------------------------------------------ */

  var toolbarHost = null;
  var toolbarShadow = null;

  var TOOLBAR_CSS = [
    ':host { all: initial; }',
    '.bar {',
    '  position: fixed; z-index: 2147483647;',
    '  top: 12px; right: 12px;',
    '  font: 12px/1.5 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;',
    '  color: #1f2328;',
    '  background: #fff;',
    '  border: 1px solid #d0d7de;',
    '  border-radius: 8px;',
    '  box-shadow: 0 6px 24px rgba(0,0,0,.18);',
    '  width: 236px;',
    '  overflow: hidden;',
    '}',
    '.head {',
    '  display: flex; align-items: center; gap: 8px;',
    '  padding: 7px 10px; cursor: pointer;',
    '  background: #f6f8fa;',
    '}',
    '.head:hover { background: #eef1f4; }',
    '.dot { width: 8px; height: 8px; border-radius: 50%; background: #1a7f37; flex: none; }',
    '.dot.warn { background: #bf8700; }',
    '.dot.err { background: #cf222e; }',
    '.title { font-weight: 600; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
    '.caret { color: #656d76; flex: none; }',
    '.body { max-height: 320px; overflow-y: auto; display: none; }',
    '.open .body { display: block; }',
    '.row { padding: 6px 10px; cursor: pointer; display: flex; justify-content: space-between; gap: 8px; }',
    '.row:hover { background: #f6f8fa; }',
    '.row.active { background: #ddf4ff; font-weight: 600; }',
    '.row .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '.row .hint { color: #656d76; font-size: 11px; flex: none; }',
    '.group { padding: 6px 10px 2px; color: #656d76; font-weight: 600; font-size: 11px; background: #f6f8fa; }',
    '.foot { padding: 6px; border-top: 1px solid #d0d7de; display: flex; gap: 6px; }',
    'button {',
    '  flex: 1; font: inherit; padding: 5px 8px; cursor: pointer;',
    '  border: 1px solid #d0d7de; border-radius: 6px; background: #f6f8fa; color: #1f2328;',
    '}',
    'button:hover { background: #eef1f4; }',
    '.toast {',
    '  position: fixed; z-index: 2147483647; top: 12px; left: 50%; transform: translateX(-50%);',
    '  padding: 8px 14px; border-radius: 6px; font: 12px/1.5 system-ui, sans-serif;',
    '  background: #1f2328; color: #fff; box-shadow: 0 4px 16px rgba(0,0,0,.2);',
    '}',
    '.toast.error { background: #cf222e; }'
  ].join('\n');

  function createToolbar() {
    if (toolbarHost) return;

    toolbarHost = document.createElement('div');
    toolbarHost.id = 'ce-toolbar-host';
    // Shadow DOM 隔离样式，避免与页面自身的 CSS 互相影响
    toolbarShadow = toolbarHost.attachShadow({ mode: 'open' });

    var style = document.createElement('style');
    style.textContent = TOOLBAR_CSS;
    toolbarShadow.appendChild(style);

    var bar = document.createElement('div');
    bar.className = 'bar';

    var head = document.createElement('div');
    head.className = 'head';

    var dot = document.createElement('span');
    dot.className = 'dot';

    var title = document.createElement('span');
    title.className = 'title';
    title.textContent = '编码：检测中…';

    var caret = document.createElement('span');
    caret.className = 'caret';
    caret.textContent = '▾';

    head.appendChild(dot);
    head.appendChild(title);
    head.appendChild(caret);

    var body = document.createElement('div');
    body.className = 'body';

    var foot = document.createElement('div');
    foot.className = 'foot';

    var restoreBtn = document.createElement('button');
    restoreBtn.textContent = '还原';
    restoreBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      restoreOriginal();
    });

    var detectBtn = document.createElement('button');
    detectBtn.textContent = '重新检测';
    detectBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      refreshDetection();
    });

    foot.appendChild(restoreBtn);
    foot.appendChild(detectBtn);

    bar.appendChild(head);
    bar.appendChild(body);
    bar.appendChild(foot);
    toolbarShadow.appendChild(bar);

    (document.body || document.documentElement).appendChild(toolbarHost);

    toolbarShadow.bar = bar;
    toolbarShadow.body = body;
    toolbarShadow.dot = dot;
    toolbarShadow.title = title;

    // 展开时才去取原始字节做检测，平时不额外请求页面
    head.addEventListener('click', function () {
      var opened = bar.classList.toggle('open');
      if (opened && !state.detected) {
        state.detected = true;
        refreshDetection();
      }
    });
  }

  function updateToolbar() {
    if (!toolbarShadow) return;
    var entry = CE.charsets.get(state.charset);
    toolbarShadow.title.textContent = entry ? ('编码：' + entry.label) : '编码：未知';
    toolbarShadow.dot.className = 'dot' + (state.modified ? ' warn' : '');
    renderEncodingList();
  }

  /** 渲染可选编码列表 */
  function renderEncodingList() {
    var body = toolbarShadow.body;
    body.textContent = '';

    CE.charsets.grouped().forEach(function (group) {
      var header = document.createElement('div');
      header.className = 'group';
      header.textContent = group.label;
      body.appendChild(header);

      group.items.forEach(function (item) {
        var row = document.createElement('div');
        row.className = 'row' + (item.id === state.charset ? ' active' : '');

        var name = document.createElement('span');
        name.className = 'name';
        name.textContent = item.label;

        var hint = document.createElement('span');
        hint.className = 'hint';
        hint.textContent = item.id;

        row.appendChild(name);
        row.appendChild(hint);
        row.addEventListener('click', function () {
          applyCharset(item.id);
        });
        body.appendChild(row);
      });
    });
  }

  /** 在页面顶部显示一条提示 */
  function showToast(message, kind) {
    if (!toolbarShadow) createToolbar();
    var existing = toolbarShadow.querySelector('.toast');
    if (existing) existing.remove();

    var toast = document.createElement('div');
    toast.className = 'toast' + (kind === 'error' ? ' error' : '');
    toast.textContent = message;
    toolbarShadow.appendChild(toast);
    setTimeout(function () {
      if (toast.isConnected) toast.remove();
    }, 2600);
  }

  /* ------------------------------------------------------------------ *
   * 检测
   * ------------------------------------------------------------------ */

  async function refreshDetection() {
    try {
      var detection = await detectPage();
      state.charset = detection.charset;
      if (!state.modified) state.originalCharset = detection.charset;
      updateToolbar();

      var level = detection.confidence > 0.75 ? '' : detection.confidence > 0.5 ? ' warn' : ' err';
      toolbarShadow.dot.className = 'dot' + level;
      showToast('检测结果：' + detection.label +
        '（置信度 ' + Math.round(detection.confidence * 100) + '%）');
      return detection;
    } catch (error) {
      showToast('检测失败：' + error.message, 'error');
      return null;
    }
  }

  /** 取回原始字节并检测编码 */
  async function detectPage() {
    var page = await fetchPageBytes();
    var detection = CE.detect.analyze(page.bytes, { httpCharset: page.httpCharset });
    return {
      charset: detection.charset,
      label: detection.label,
      confidence: detection.confidence,
      method: detection.method,
      declared: detection.declared,
      httpCharset: page.httpCharset,
      candidates: detection.candidates
    };
  }

  /* ------------------------------------------------------------------ *
   * 消息处理
   * ------------------------------------------------------------------ */

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message) return false;

    if (message.type === 'ce-state') {
      sendResponse({
        charset: state.charset,
        originalCharset: state.originalCharset,
        modified: state.modified
      });
      return false;
    }

    if (message.type === 'ce-apply') {
      applyCharset(message.charset).then(
        function (ok) { sendResponse({ ok: ok }); },
        function (error) { sendResponse({ ok: false, error: String(error.message) }); }
      );
      return true;
    }

    if (message.type === 'ce-restore') {
      restoreOriginal();
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === 'ce-detect') {
      detectPage().then(
        function (detection) { sendResponse({ ok: true, result: detection }); },
        function (error) { sendResponse({ ok: false, error: String(error.message) }); }
      );
      return true;
    }

    return false;
  });

  /* ------------------------------------------------------------------ *
   * 启动
   * ------------------------------------------------------------------ */

  function start() {
    createToolbar();

    // 浏览器实际使用的编码
    var browserCharset = (document.characterSet || 'utf-8').toLowerCase();
    var entry = CE.charsets.fromAlias(browserCharset);
    state.originalCharset = entry ? entry.id : 'utf-8';
    state.charset = state.originalCharset;
    updateToolbar();

    // 立即拍下原始文本快照，这样“还原”随时可用
    state.snapshot = takeSnapshot();

    // 站点规则里指定了编码则自动应用（只有命中规则时才会去取原始字节）
    send('getRule', { url: location.href })
      .then(function (rule) {
        if (rule.charset && rule.charset !== state.originalCharset) {
          applyCharset(rule.charset);
        }
      })
      .catch(function () { /* 忽略 */ });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }

  // 供弹窗与调试使用
  window.__ceExtension = {
    applyCharset: applyCharset,
    restoreOriginal: restoreOriginal,
    refreshDetection: refreshDetection,
    getState: function () {
      return {
        charset: state.charset,
        originalCharset: state.originalCharset,
        modified: state.modified
      };
    }
  };
})();
