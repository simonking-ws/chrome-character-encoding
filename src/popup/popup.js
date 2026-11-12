/**
 * 弹窗逻辑：显示页面信息、检测结果，并提供编码列表供用户选择。
 */
(function () {
  'use strict';

  var CE = window.CE;

  var selected = null;
  var activeTab = null;
  var detection = null;

  var els = {
    pageInfo: document.getElementById('page-info'),
    detection: document.getElementById('detection'),
    detectedCharset: document.getElementById('detected-charset'),
    detectedConfidence: document.getElementById('detected-confidence'),
    declaredCharset: document.getElementById('declared-charset'),
    browserCharset: document.getElementById('browser-charset'),
    candidates: document.getElementById('candidates'),
    search: document.getElementById('search'),
    list: document.getElementById('encoding-list'),
    remember: document.getElementById('remember-site'),
    apply: document.getElementById('apply-btn'),
    exportBtn: document.getElementById('export-btn'),
    exportDialog: document.getElementById('export-dialog'),
    exportFrom: document.getElementById('export-from'),
    exportTo: document.getElementById('export-to'),
    exportWarning: document.getElementById('export-warning'),
    exportHint: document.getElementById('export-hint'),
    exportConfirm: document.getElementById('export-confirm'),
    options: document.getElementById('options-btn')
  };

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

  function setStatus(text, isError) {
    var status = document.getElementById('status');
    if (!status) {
      status = document.createElement('div');
      status.id = 'status';
      status.className = 'status';
      document.querySelector('.footer').appendChild(status);
    }
    status.textContent = text;
    status.className = 'status' + (isError ? ' error' : '');
  }

  /* ------------------------------------------------------------------ *
   * 渲染
   * ------------------------------------------------------------------ */

  function renderList() {
    var keyword = els.search.value.trim().toLowerCase();
    els.list.textContent = '';

    var groups = CE.charsets.grouped();
    var matched = 0;

    groups.forEach(function (group) {
      var items = group.items.filter(function (item) {
        if (!keyword) return true;
        return (
          item.label.toLowerCase().indexOf(keyword) !== -1 ||
          item.id.toLowerCase().indexOf(keyword) !== -1 ||
          item.aliases.some(function (alias) {
            return alias.toLowerCase().indexOf(keyword) !== -1;
          })
        );
      });

      if (!items.length) return;

      var title = document.createElement('div');
      title.className = 'group-title';
      title.textContent = group.label;
      els.list.appendChild(title);

      items.forEach(function (item) {
        matched++;
        var row = document.createElement('button');
        row.type = 'button';
        row.className = 'encoding-item' + (item.id === selected ? ' selected' : '');
        row.dataset.id = item.id;

        var name = document.createElement('span');
        name.className = 'name';
        name.textContent = item.label;

        var alias = document.createElement('span');
        alias.className = 'alias';
        alias.textContent = item.id;

        row.appendChild(name);
        row.appendChild(alias);
        row.addEventListener('click', function () {
          select(item.id);
        });
        els.list.appendChild(row);
      });
    });

    if (!matched) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '没有匹配的编码';
      els.list.appendChild(empty);
    }
  }

  function select(id) {
    selected = id;
    renderList();
    els.apply.disabled = false;
    var entry = CE.charsets.get(id);
    setStatus('已选择：' + (entry ? entry.label : id));
  }

  function renderDetection(info) {
    detection = info;
    els.detection.classList.remove('hidden');
    els.detectedCharset.textContent = info.label || info.charset;
    els.detectedConfidence.textContent =
      Math.round((info.confidence || 0) * 100) + '% · ' + describeMethod(info.method);
    els.declaredCharset.textContent = info.declared || '（无）';
    els.browserCharset.textContent = info.browserCharset || '（未知）';

    // 候选编码
    els.candidates.textContent = '';
    (info.candidates || []).slice(0, 5).forEach(function (candidate) {
      var button = document.createElement('button');
      button.type = 'button';
      button.textContent = CE.charsets.get(candidate.charset)
        ? CE.charsets.get(candidate.charset).label
        : candidate.charset;
      button.addEventListener('click', function () {
        select(candidate.charset);
      });
      els.candidates.appendChild(button);
    });
  }

  function describeMethod(method) {
    var map = {
      'bom': 'BOM 标记',
      'http-header': 'HTTP 响应头',
      'meta-tag': 'HTML meta 标签',
      'utf-8-validation': 'UTF-8 校验',
      'utf16-pattern': 'UTF-16 字节特征',
      'ascii': '纯 ASCII',
      'statistical': '统计检测'
    };
    return map[method] || method || '未知';
  }

  /* ------------------------------------------------------------------ *
   * 应用
   * ------------------------------------------------------------------ */

  async function apply() {
    if (!selected || !activeTab) return;
    els.apply.disabled = true;
    setStatus('正在重新解码…');

    try {
      // 由内容脚本完成转码：它能拿到原始字节并就地替换文本
      var response = await chrome.tabs.sendMessage(activeTab.id, {
        type: 'ce-apply',
        charset: selected
      });
      if (!response || !response.ok) {
        throw new Error((response && response.error) || '转码失败');
      }

      if (els.remember.checked) {
        await send('setRule', { url: activeTab.url, charset: selected });
        setStatus('已按 ' + (CE.charsets.get(selected) || {}).label + ' 重新解码，并已记住此网站');
      } else {
        setStatus('已按 ' + (CE.charsets.get(selected) || {}).label + ' 重新解码');
      }
      setTimeout(function () { window.close(); }, 700);
    } catch (error) {
      // 内容脚本无法注入的页面（扩展商店、chrome:// 等）会报连接失败
      var message = /Receiving end does not exist|Could not establish connection/i.test(error.message)
        ? '此页面不允许扩展注入脚本，无法在此转码'
        : error.message;
      setStatus('失败：' + message, true);
      els.apply.disabled = false;
    }
  }

  /* ------------------------------------------------------------------ *
   * 转码保存
   * ------------------------------------------------------------------ */

  /** 填充编码下拉框 */
  function fillCharsetSelect(select, value) {
    select.textContent = '';
    CE.charsets.grouped().forEach(function (group) {
      var optgroup = document.createElement('optgroup');
      optgroup.label = group.label;
      group.items.forEach(function (item) {
        var option = document.createElement('option');
        option.value = item.id;
        option.textContent = item.label;
        if (item.id === value) option.selected = true;
        optgroup.appendChild(option);
      });
      select.appendChild(optgroup);
    });
  }

  function openExportDialog() {
    if (!activeTab) return;
    var source = (detection && detection.charset) || selected || 'utf-8';
    fillCharsetSelect(els.exportFrom, source);
    fillCharsetSelect(els.exportTo, selected || 'utf-8');
    els.exportWarning.classList.add('hidden');
    els.exportWarning.textContent = '';
    els.exportHint.textContent = '把当前页面按所选编码重新编码后保存为 HTML 文件。';
    els.exportDialog.showModal();
  }

  async function confirmExport() {
    var from = els.exportFrom.value;
    var to = els.exportTo.value;
    var result;

    try {
      result = await send('exportPage', { url: activeTab.url, from: from, to: to });
    } catch (error) {
      setStatus('转码失败：' + error.message, true);
      return;
    }

    var info = result.result;
    if (info.missing > 0) {
      setStatus('已保存，但有 ' + info.missing + ' 个字符无法用 ' + to + ' 表示（已替换为问号）', true);
    } else {
      setStatus('已按 ' + to + ' 转码保存');
    }

    // 触发下载
    var bytes = base64ToBytes(info.base64);
    var blob = new Blob([bytes], { type: 'text/html;charset=' + to });
    var url = URL.createObjectURL(blob);
    var name = (activeTab.title || 'page').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) + '.html';

    var link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  }

  function base64ToBytes(base64) {
    var binary = atob(base64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  /* ------------------------------------------------------------------ *
   * 启动
   * ------------------------------------------------------------------ */

  async function init() {
    els.search.addEventListener('input', renderList);
    els.apply.addEventListener('click', apply);
    els.exportBtn.addEventListener('click', openExportDialog);
    els.options.addEventListener('click', function () {
      chrome.runtime.openOptionsPage();
    });
    els.exportConfirm.addEventListener('click', function (event) {
      event.preventDefault();
      els.exportDialog.close();
      confirmExport();
    });

    renderList();

    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab = tabs[0];
    if (!activeTab) return;

    var url = activeTab.url || '';
    els.pageInfo.textContent = activeTab.title ? activeTab.title : url;
    els.pageInfo.title = url;

    // 优先让内容脚本检测：它是同源请求，能带上页面自己的 Cookie；
    // 没有内容脚本时（例如扩展商店页面）再由后台脚本代劳。
    var info = null;
    var browserCharset = '（未知）';
    try {
      var result = await chrome.tabs.sendMessage(activeTab.id, { type: 'ce-detect' });
      if (result && result.ok) {
        info = result.result;
      }
      var stateResult = await chrome.tabs.sendMessage(activeTab.id, { type: 'ce-state' });
      if (stateResult && stateResult.charset) browserCharset = stateResult.charset;
    } catch (e) {
      // 页面可能不支持内容脚本（例如扩展商店），忽略
    }

    if (!info) {
      try {
        info = await send('detect', { url: url });
      } catch (error) {
        setStatus('检测失败：' + error.message, true);
        return;
      }
    }

    info.browserCharset = browserCharset;
    renderDetection(info);
    select(info.charset);
    els.exportBtn.disabled = false;
  }

  init().catch(function (error) {
    setStatus('初始化失败：' + error.message, true);
  });
})();
