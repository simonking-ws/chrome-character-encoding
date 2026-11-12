/**
 * 截图工具：把扩展的弹窗、选项页以及带工具栏的页面渲染成图片，
 * 便于检查界面效果。
 *
 *   node tools/screenshot.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PipeCDP } = require('./pipe_cdp');

const CHROME = path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe');
const EXT_DIR = path.resolve(__dirname, '..');
const PORT = 8942;
const OUT_DIR = path.resolve(__dirname, '..', 'screenshots');

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const server = spawn(process.execPath, [path.join(__dirname, 'test_server.js'), String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', () => {});
  await new Promise((r) => setTimeout(r, 900));

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-shot-'));
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--hide-scrollbars',
    '--user-data-dir=' + profile,
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    'about:blank'
  ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });

  const cdp = new PipeCDP(chrome.stdio[3], chrome.stdio[4]);

  /** 打开一个页面并截图 */
  async function shot(url, file, options) {
    options = options || {};
    const target = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true
    });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: options.width || 900,
      height: options.height || 700,
      deviceScaleFactor: 2,
      mobile: false
    }, sessionId);
    await cdp.send('Page.navigate', { url }, sessionId);
    await new Promise((r) => setTimeout(r, 2200));
    if (options.before) await options.before(sessionId);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    fs.writeFileSync(path.join(OUT_DIR, file), Buffer.from(data, 'base64'));
    console.log('wrote', path.join(OUT_DIR, file));
    await cdp.send('Target.closeTarget', { targetId: target.targetId });
  }

  try {
    const loaded = await cdp.send('Extensions.loadUnpacked', { path: EXT_DIR });
    const base = 'chrome-extension://' + loaded.id;

    // 弹窗
    await shot(base + '/src/popup/popup.html', 'popup.png', { width: 360, height: 640 });

    // 转码保存对话框（通过点击按钮走真实流程）
    await shot(base + '/src/popup/popup.html', 'export-dialog.png', {
      width: 360,
      height: 460,
      before: async (sessionId) => {
        await cdp.evaluate(`(() => {
          const btn = document.getElementById('export-btn');
          if (btn && !btn.disabled) btn.click();
          return true;
        })()`, sessionId);
        await new Promise((r) => setTimeout(r, 500));
      }
    });

    // 选项页
    await shot(base + '/src/options/options.html', 'options.png', { width: 820, height: 760 });

    // 页面内工具栏（展开状态）
    await shot('http://localhost:' + PORT + '/wrong?lang=zh-cn', 'toolbar.png', {
      width: 900,
      height: 420,
      before: async (sessionId) => {
        await cdp.evaluate(`(() => {
          const host = document.getElementById('ce-toolbar-host');
          if (host && host.shadowRoot) {
            const bar = host.shadowRoot.querySelector('.bar');
            if (bar) bar.classList.add('open');
          }
          return true;
        })()`, sessionId);
        await new Promise((r) => setTimeout(r, 500));
      }
    });

    // 应用 GBK 之后的效果
    const popupTarget = await cdp.send('Target.createTarget', {
      url: base + '/src/popup/popup.html'
    });
    const popupSession = await cdp.send('Target.attachToTarget', {
      targetId: popupTarget.targetId,
      flatten: true
    });
    await cdp.send('Runtime.enable', {}, popupSession.sessionId);
    await new Promise((r) => setTimeout(r, 800));

    await shot('http://localhost:' + PORT + '/wrong?lang=zh-cn', 'fixed.png', {
      width: 900,
      height: 260,
      before: async (sessionId) => {
        // 由扩展页面给内容脚本发消息，走真实的替换流程
        await cdp.evaluate(`(async () => {
          const tabs = await chrome.tabs.query({});
          const tab = tabs.find((t) => (t.url || '').indexOf('localhost:${PORT}/wrong') !== -1);
          if (!tab) return 'no tab';
          try {
            await chrome.tabs.sendMessage(tab.id, { type: 'ce-apply', charset: 'gbk' });
            return 'ok';
          } catch (e) {
            return String(e);
          }
        })()`, popupSession.sessionId);
        await new Promise((r) => setTimeout(r, 700));
      }
    });
    await cdp.send('Target.closeTarget', { targetId: popupTarget.targetId });
  } catch (error) {
    console.error('截图失败:', error);
  } finally {
    try { chrome.kill(); } catch (e) { /* 忽略 */ }
    server.kill();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }
}

main();
