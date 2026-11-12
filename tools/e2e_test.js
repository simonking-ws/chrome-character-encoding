/**
 * 端到端测试：在真实 Chrome 中加载扩展，访问用各种编码提供的页面，
 * 验证扩展能否正确检测编码，并把乱码纠正回来。
 *
 *   node tools/e2e_test.js
 *
 * 正式版 Chrome 禁止 --load-extension，这里改用 CDP 的 Extensions 域
 * （Extensions.loadUnpacked），配合 --remote-debugging-pipe 使用。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PipeCDP } = require('./pipe_cdp');

const CHROME = path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe');
const EXT_DIR = path.resolve(__dirname, '..');
const PORT = 8941;

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log('  [PASS] ' + name);
  } else {
    fail++;
    failures.push(name + (detail ? ' -> ' + detail : ''));
    console.log('  [FAIL] ' + name + (detail ? ' -> ' + detail : ''));
  }
}

const SAMPLES = {
  'zh-cn': '这是一段中文网页内容，用于测试字符编码检测功能是否正常工作。页面应当显示正确的文字。',
  'zh-tw': '這是一段繁體中文網頁內容，用於測試字元編碼偵測功能是否正常運作。頁面應當顯示正確的文字。',
  ja: 'これは日本語のウェブページコンテンツです。文字コードの検出機能をテストします。ページは正しく表示されるはずです。',
  ko: '이것은 한국어 웹 페이지 콘텐츠입니다. 문자 인코딩 감지 기능을 테스트합니다. 페이지가 올바르게 표시되어야 합니다.',
  ru: 'Это содержимое веб-страницы на русском языке для проверки определения кодировки. Страница должна отображаться правильно.',
  de: 'Grüße aus München! Änderung für größere Straßen und schöne Wörter. Die Seite soll richtig angezeigt werden.'
};

const EXPECTED = {
  'zh-cn': 'gbk', 'zh-tw': 'big5', ja: 'shift_jis', ko: 'euc-kr',
  ru: 'windows-1251', de: 'windows-1252'
};

async function main() {
  console.log('启动测试服务器…');
  const server = spawn(process.execPath, [path.join(__dirname, 'test_server.js'), String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', () => {});
  await new Promise((r) => setTimeout(r, 900));

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-e2e-'));
  console.log('启动 Chrome（通过 CDP 加载扩展）…');

  // fd 3 / fd 4 是 --remote-debugging-pipe 的读写端
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--user-data-dir=' + profile,
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    'about:blank'
  ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });

  // 子进程的 fd 3 是浏览器读取的一端（我们写），fd 4 是浏览器写出的��端（我们读）
  const cdp = new PipeCDP(chrome.stdio[3], chrome.stdio[4]);

  try {
    // 加载扩展
    const loaded = await cdp.send('Extensions.loadUnpacked', { path: EXT_DIR });
    console.log('扩展已加载，ID:', loaded.id);

    // 打开测试页面
    const pageUrl = 'http://localhost:' + PORT + '/page?lang=zh-cn';
    const target = await cdp.send('Target.createTarget', { url: pageUrl });
    const { sessionId } = await cdp.send('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true
    });

    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await new Promise((r) => setTimeout(r, 1800));

    // 打开扩展的弹窗页面，用它来调用扩展接口
    const popupTarget = await cdp.send('Target.createTarget', {
      url: 'chrome-extension://' + loaded.id + '/src/popup/popup.html'
    });
    const popupSession = await cdp.send('Target.attachToTarget', {
      targetId: popupTarget.targetId,
      flatten: true
    });
    await cdp.send('Runtime.enable', {}, popupSession.sessionId);
    await new Promise((r) => setTimeout(r, 1200));

    const extSession = popupSession.sessionId;

    async function goto(url) {
      await cdp.send('Page.navigate', { url }, sessionId);
      // 等待文档真正加载完成
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 250));
        const ready = await cdp.evaluate(
          'document.readyState === "complete" && !!document.getElementById("head")',
          sessionId
        ).catch(() => false);
        if (ready) return;
      }
    }

    /** 调用扩展接口 */
    function callExt(type, payload) {
      return cdp.evaluate(
        'chrome.runtime.sendMessage(' + JSON.stringify({ type, payload }) + ').then(r => r)',
        extSession
      );
    }

    /* ---------------- 检测 ---------------- */
    console.log('\n=== 检测编码 ===');
    for (const lang of Object.keys(SAMPLES)) {
      const url = 'http://localhost:' + PORT + '/page?lang=' + lang;
      await goto(url);
      const res = await callExt('detect', { url });
      const got = res && res.result ? res.result.charset : null;
      check('检测 ' + lang + ' -> ' + EXPECTED[lang], got === EXPECTED[lang], 'got ' + got);
    }

    /* -------------- 乱码纠正 -------------- */
    console.log('\n=== 纠正乱码（响应头声明与实际不符）===');
    for (const lang of Object.keys(SAMPLES)) {
      const url = 'http://localhost:' + PORT + '/wrong?lang=' + lang;
      await goto(url);

      const before = await cdp.evaluate('document.getElementById("head").textContent', sessionId);
      const garbled = before !== SAMPLES[lang];

      const res = await callExt('transcode', { url, charset: EXPECTED[lang] });
      const html = res && res.result ? res.result.html : null;
      check('转码内容正确 ' + lang, !!html && html.indexOf(SAMPLES[lang]) !== -1,
        html ? html.slice(0, 50) : 'null');

      // 用转码后的 HTML 替换页面文本，验证乱码被纠正
      const after = await cdp.evaluate(`(() => {
        const html = ${JSON.stringify(html)};
        const parsed = new DOMParser().parseFromString(html, 'text/html');
        document.getElementById('head').textContent = parsed.getElementById('head').textContent;
        return document.getElementById('head').textContent;
      })()`, sessionId);
      check('乱码纠正 ' + lang, garbled && after === SAMPLES[lang],
        'garbled=' + garbled + ' after=' + JSON.stringify(String(after).slice(0, 30)));
    }

    /* ---------------- 内容脚本实际行为 ---------------- */
    console.log('\n=== 内容脚本就地替换 ===');
    {
      const url = 'http://localhost:' + PORT + '/wrong?lang=zh-cn';
      await goto(url);
      const before = await cdp.evaluate('document.getElementById("head").textContent', sessionId);

      // 由扩展页面给内容脚本发消息，触发真实的“就地替换”流程
      const applied = await cdp.evaluate(`(async () => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find((t) => (t.url || '').indexOf('localhost:${PORT}/wrong') !== -1);
        if (!tab) return { error: '未找到目标标签页' };
        try {
          const res = await chrome.tabs.sendMessage(tab.id, { type: 'ce-apply', charset: 'gbk' });
          return { res };
        } catch (e) {
          return { error: String(e) };
        }
      })()`, extSession);

      const after = await cdp.evaluate('document.getElementById("head").textContent', sessionId);
      check('内容脚本纠正中文乱码',
        before !== SAMPLES['zh-cn'] && after === SAMPLES['zh-cn'],
        'before=' + JSON.stringify(String(before).slice(0, 16)) +
        ' after=' + JSON.stringify(String(after).slice(0, 16)) +
        ' applied=' + JSON.stringify(applied));
    }

    /* ---------------- 还原 ---------------- */
    console.log('\n=== 还原 ===');
    {
      const url = 'http://localhost:' + PORT + '/wrong?lang=zh-cn';
      await goto(url);
      const original = await cdp.evaluate('document.getElementById("head").textContent', sessionId);

      const applyResult = await cdp.evaluate(`(async () => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find((t) => (t.url || '').indexOf('localhost:${PORT}/wrong') !== -1);
        await chrome.tabs.sendMessage(tab.id, { type: 'ce-apply', charset: 'gbk' });
        return true;
      })()`, extSession);
      const fixed = await cdp.evaluate('document.getElementById("head").textContent', sessionId);
      check('应用后显示正确文字', fixed === SAMPLES['zh-cn'],
        JSON.stringify(String(fixed).slice(0, 20)));

      await cdp.evaluate(`(async () => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find((t) => (t.url || '').indexOf('localhost:${PORT}/wrong') !== -1);
        await chrome.tabs.sendMessage(tab.id, { type: 'ce-restore' });
        return true;
      })()`, extSession);
      await new Promise((r) => setTimeout(r, 500));
      const restored = await cdp.evaluate('document.getElementById("head").textContent', sessionId);
      check('还原后回到浏览器原始解码', restored === original,
        JSON.stringify(String(restored).slice(0, 20)));
    }

    /* ---------------- 工具栏与站点规则 ---------------- */
    console.log('\n=== 工具栏与站点规则 ===');
    {
      const url = 'http://localhost:' + PORT + '/page?lang=zh-cn';
      await goto(url);
      const hasToolbar = await cdp.evaluate(
        '!!document.getElementById("ce-toolbar-host")', sessionId);
      check('页面内注入工具栏', hasToolbar === true);

      // 写入站点规则
      const saved = await cdp.evaluate(`(async () => {
        const res = await chrome.runtime.sendMessage({
          type: 'setRule',
          payload: { url: 'http://localhost:${PORT}/page?lang=zh-cn', charset: 'big5' }
        });
        return res;
      })()`, extSession);
      check('保存站点规则', !!(saved && saved.ok && saved.result.charset === 'big5'),
        JSON.stringify(saved));

      const readBack = await cdp.evaluate(`(async () => {
        const res = await chrome.runtime.sendMessage({
          type: 'getRule',
          payload: { url: 'http://localhost:${PORT}/page?lang=zh-cn' }
        });
        return res;
      })()`, extSession);
      check('读取站点规则', !!(readBack && readBack.ok && readBack.result.charset === 'big5'),
        JSON.stringify(readBack));

      // 清理规则
      await cdp.evaluate(`(async () => {
        await chrome.runtime.sendMessage({
          type: 'setRule',
          payload: { url: 'http://localhost:${PORT}/page?lang=zh-cn', charset: null }
        });
        return true;
      })()`, extSession);
    }

    /* ---------------- 转码保存 ---------------- */
    console.log('\n=== 转码保存 ===');
    {
      const url = 'http://localhost:' + PORT + '/page?lang=zh-cn';
      const res = await callExt('exportPage', { url, from: 'gbk', to: 'utf-8' });
      const info = res && res.result ? res.result : null;
      check('转码导出成功', !!(info && info.base64), JSON.stringify(res));

      if (info) {
        const bytes = Buffer.from(info.base64, 'base64');
        const text = bytes.toString('utf8');
        check('导出内容为正确的 UTF-8 文本', text.indexOf(SAMPLES['zh-cn']) !== -1,
          text.slice(0, 60));
        check('导出的 meta charset 已更新',
          /<meta\s+charset="utf-8"/i.test(text), text.slice(0, 200));
        check('导出时无字符丢失', info.missing === 0, 'missing=' + info.missing);
      }

      // 再转成 Big5：简体汉字在 Big5 里并不都能表示，应当报告字符丢失，
      // 但产出的字节必须仍是合法的 Big5
      const res2 = await callExt('exportPage', { url, from: 'gbk', to: 'big5' });
      const info2 = res2 && res2.result ? res2.result : null;
      if (info2) {
        const bytes2 = Buffer.from(info2.base64, 'base64');
        const decoded = new TextDecoder('big5').decode(bytes2);
        check('导出为 Big5 时报告了无法表示的字符', info2.missing > 0, 'missing=' + info2.missing);
        check('导出为 Big5 的字节仍是合法 Big5', decoded.indexOf('<html') !== -1,
          decoded.slice(0, 40));
      }

      // 繁体页面转 Big5 不应丢字
      const twUrl = 'http://localhost:' + PORT + '/page?lang=zh-tw';
      const res3 = await callExt('exportPage', { url: twUrl, from: 'big5', to: 'big5' });
      const info3 = res3 && res3.result ? res3.result : null;
      if (info3) {
        check('繁体页面转 Big5 不丢字', info3.missing === 0, 'missing=' + info3.missing);
        const text3 = new TextDecoder('big5').decode(Buffer.from(info3.base64, 'base64'));
        check('繁体页面转 Big5 后内容正确',
          text3.indexOf('這是一段繁體中文網頁內容') !== -1, text3.slice(0, 50));
      }
    }

    /* ---------------- 严格 CSP 页面 ---------------- */
    console.log('\n=== 严格 CSP 页面（验证兜底路径）===');
    {
      const url = 'http://localhost:' + PORT + '/csp?lang=zh-cn';
      await goto(url);
      const before = await cdp.evaluate('document.getElementById("head").textContent', sessionId);

      const applied = await cdp.evaluate(`(async () => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find((t) => (t.url || '').indexOf('localhost:${PORT}/csp') !== -1);
        if (!tab) return { error: '未找到目标标签页' };
        try {
          return { res: await chrome.tabs.sendMessage(tab.id, { type: 'ce-apply', charset: 'gbk' }) };
        } catch (e) {
          return { error: String(e) };
        }
      })()`, extSession);

      const after = await cdp.evaluate('document.getElementById("head").textContent', sessionId);
      check('CSP 页面也能纠正乱码', after === SAMPLES['zh-cn'],
        'before=' + JSON.stringify(String(before).slice(0, 16)) +
        ' after=' + JSON.stringify(String(after).slice(0, 16)) +
        ' applied=' + JSON.stringify(applied));
    }

    /* ---------------- 实际下载文件 ---------------- */
    console.log('\n=== 下载转码后的文件 ===');
    {
      const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-dl-'));
      await cdp.send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: downloadDir,
        eventsEnabled: true
      });

      // 在扩展页面里走完整的“转码并保存”流程
      const pageUrl = 'http://localhost:' + PORT + '/page?lang=zh-cn';
      const dl = await cdp.evaluate(`(async () => {
        const res = await chrome.runtime.sendMessage({
          type: 'exportPage',
          payload: { url: '${pageUrl}', from: 'gbk', to: 'utf-8' }
        });
        if (!res.ok) return { error: res.error };
        const bytes = Uint8Array.from(atob(res.result.base64), (c) => c.charCodeAt(0));
        const blob = new Blob([bytes], { type: 'text/html;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'transcoded.html';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        return { ok: true, size: bytes.length };
      })()`, extSession);

      // 等文件落盘
      let file = null;
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 250));
        const files = fs.readdirSync(downloadDir).filter((f) => f.endsWith('.html'));
        if (files.length) { file = path.join(downloadDir, files[0]); break; }
      }

      check('下载文件已生成', !!file, dl && JSON.stringify(dl));
      if (file) {
        const content = fs.readFileSync(file, 'utf8');
        check('下载内容为正确的 UTF-8 文本',
          content.indexOf(SAMPLES['zh-cn']) !== -1, content.slice(0, 60));
        check('下载文件的 meta charset 已更新',
          /<meta\s+charset="utf-8"/i.test(content), content.slice(0, 200));
      }
      fs.rmSync(downloadDir, { recursive: true, force: true });
    }

    /* ---------------- 编码往返 ---------------- */
    console.log('\n=== 编解码往返 ===');
    const gbk = await callExt('encode', { text: '中文测试', charset: 'gbk' });
    const gbkHex = Buffer.from(gbk.result.base64, 'base64').toString('hex');
    check('GBK 编码输出 d6d0cec4b2e2cad4', gbkHex === 'd6d0cec4b2e2cad4', gbkHex);

    const utf16 = await callExt('encode', { text: '中', charset: 'utf-16le' });
    const utf16Hex = Buffer.from(utf16.result.base64, 'base64').toString('hex');
    check('UTF-16LE 编码输出 2d4e', utf16Hex === '2d4e', utf16Hex);
  } catch (error) {
    fail++;
    failures.push('异常: ' + error.message);
    console.error('\n测试异常:', error);
  } finally {
    try { chrome.kill(); } catch (e) { /* 忽略 */ }
    server.kill();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }

  console.log('\n通过: ' + pass + '  失败: ' + fail);
  if (fail) {
    console.log('\n失败项:');
    failures.forEach((f) => console.log('  - ' + f));
  }
  process.exit(fail ? 1 : 0);
}

main();
