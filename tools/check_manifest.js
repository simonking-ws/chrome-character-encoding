// Validate manifest.json: check it parses and that every referenced file exists.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const manifestPath = path.join(root, 'manifest.json');

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  console.log('manifest.json 解析成功');
} catch (e) {
  console.error('manifest.json 解析失败:', e.message);
  process.exit(1);
}

const referenced = new Set();

function add(p) {
  if (p && !p.startsWith('http')) referenced.add(p);
}

add(manifest.background && manifest.background.service_worker);
(manifest.content_scripts || []).forEach((cs) => {
  (cs.js || []).forEach(add);
  (cs.css || []).forEach(add);
});
(manifest.action || {}) && Object.values((manifest.action || {}).default_icon || {}).forEach(add);
Object.values(manifest.icons || {}).forEach(add);
add(manifest.action && manifest.action.default_popup);
add(manifest.options_page);

let missing = 0;
[...referenced].sort().forEach((p) => {
  const full = path.join(root, p);
  if (!fs.existsSync(full)) {
    console.error('  缺少文件:', p);
    missing++;
  }
});
console.log('引用的文件数:', referenced.size, ' 缺失:', missing);

// Also verify that importScripts paths inside the service worker resolve.
const swPath = path.join(root, manifest.background.service_worker);
const swSrc = fs.readFileSync(swPath, 'utf8');
const importRe = /importScripts\(([\s\S]*?)\);/;
const m = swSrc.match(importRe);
if (m) {
  const paths = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  const swDir = path.dirname(swPath);
  paths.forEach((p) => {
    const full = path.resolve(swDir, p);
    if (!fs.existsSync(full)) {
      console.error('  service worker 引用的文件不存在:', p, '->', full);
      missing++;
    } else {
      console.log('  importScripts 路径正常:', p);
    }
  });
}

// Check popup/options script references.
['src/popup/popup.html', 'src/options/options.html'].forEach((rel) => {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) return;
  const html = fs.readFileSync(full, 'utf8');
  const dir = path.dirname(full);
  [...html.matchAll(/<script src="([^"]+)"/g)].forEach((x) => {
    const target = path.resolve(dir, x[1]);
    if (!fs.existsSync(target)) {
      console.error('  页面引用的脚本不存在:', rel, '->', x[1]);
      missing++;
    }
  });
});

process.exit(missing ? 1 : 0);
