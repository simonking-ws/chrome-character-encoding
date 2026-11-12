/**
 * 选项页逻辑：管理“网站 -> 编码”规则。
 */
(function () {
  'use strict';

  var CE = window.CE;
  var RULES_KEY = 'siteRules';

  var els = {
    host: document.getElementById('host-input'),
    charset: document.getElementById('charset-select'),
    add: document.getElementById('add-btn'),
    status: document.getElementById('status'),
    list: document.getElementById('rules-list'),
    catalog: document.getElementById('catalog'),
    total: document.getElementById('total-count')
  };

  function setStatus(text, isError) {
    els.status.textContent = text;
    els.status.className = 'status' + (isError ? ' error' : '');
  }

  async function getRules() {
    const stored = await chrome.storage.local.get(RULES_KEY);
    return stored[RULES_KEY] || {};
  }

  async function saveRules(rules) {
    await chrome.storage.local.set({ [RULES_KEY]: rules });
  }

  async function renderRules() {
    var rules = await getRules();
    var hosts = Object.keys(rules).sort();
    els.list.textContent = '';

    if (!hosts.length) {
      var empty = document.createElement('li');
      empty.textContent = '尚未设置任何规则';
      els.list.appendChild(empty);
      return;
    }

    hosts.forEach(function (host) {
      var item = document.createElement('li');

      var label = document.createElement('span');
      label.className = 'host';
      label.textContent = host;

      var charsetSelect = document.createElement('select');
      CE.charsets.grouped().forEach(function (group) {
        var optgroup = document.createElement('optgroup');
        optgroup.label = group.label;
        group.items.forEach(function (item2) {
          var option = document.createElement('option');
          option.value = item2.id;
          option.textContent = item2.label;
          if (item2.id === rules[host]) option.selected = true;
          optgroup.appendChild(option);
        });
        charsetSelect.appendChild(optgroup);
      });
      charsetSelect.addEventListener('change', async function () {
        var current = await getRules();
        current[host] = charsetSelect.value;
        await saveRules(current);
        setStatus('已更新 ' + host);
      });

      var remove = document.createElement('button');
      remove.className = 'remove';
      remove.textContent = '删除';
      remove.addEventListener('click', async function () {
        var current = await getRules();
        delete current[host];
        await saveRules(current);
        renderRules();
        setStatus('已删除 ' + host);
      });

      item.appendChild(label);
      item.appendChild(charsetSelect);
      item.appendChild(remove);
      els.list.appendChild(item);
    });
  }

  function renderCharsetSelect() {
    CE.charsets.grouped().forEach(function (group) {
      var optgroup = document.createElement('optgroup');
      optgroup.label = group.label;
      group.items.forEach(function (item) {
        var option = document.createElement('option');
        option.value = item.id;
        option.textContent = item.label;
        optgroup.appendChild(option);
      });
      els.charset.appendChild(optgroup);
    });
  }

  function renderCatalog() {
    els.catalog.textContent = '';
    CE.charsets.grouped().forEach(function (group) {
      group.items.forEach(function (item) {
        var row = document.createElement('div');
        var strong = document.createElement('strong');
        strong.textContent = item.label;
        row.appendChild(strong);
        row.appendChild(document.createTextNode(' · ' + item.id));
        els.catalog.appendChild(row);
      });
    });
    els.total.textContent = CE.charsets.list.length;
  }

  els.add.addEventListener('click', async function () {
    var host = els.host.value.trim();
    if (!host) {
      setStatus('请填写网站域名', true);
      return;
    }
    // 允许用户直接粘贴带协议的地址
    if (host.indexOf('://') !== -1) {
      try {
        host = new URL(host).host;
      } catch (e) {
        setStatus('地址格式不正确', true);
        return;
      }
    }

    var rules = await getRules();
    rules[host] = els.charset.value;
    await saveRules(rules);
    els.host.value = '';
    renderRules();
    setStatus('已添加 ' + host);
  });

  renderCharsetSelect();
  renderCatalog();
  renderRules();
})();
