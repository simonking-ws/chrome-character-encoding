// Run a page in real Chrome headless and print the <pre id="out"> content.
// Usage: node tools/chrome_probe.js tools/probe.html
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = path.join(
  process.env.LOCALAPPDATA,
  'Google',
  'Chrome',
  'Application',
  'chrome.exe'
);

const file = path.resolve(process.argv[2] || 'tools/probe.html');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-probe-'));

const args = [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--disable-extensions-except=' + path.resolve('.'),
  '--user-data-dir=' + profile,
  '--virtual-time-budget=20000',
  '--dump-dom',
  'file:///' + file.replace(/\\/g, '/')
];

const child = spawn(CHROME, args, { stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
let err = '';
child.stdout.on('data', (d) => (out += d));
child.stderr.on('data', (d) => (err += d));

child.on('close', (code) => {
  fs.rmSync(profile, { recursive: true, force: true });
  const m = out.match(/<pre id="out">([\s\S]*?)<\/pre>/);
  if (m) {
    const text = m[1]
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
    console.log(text);
  } else {
    console.log('NO OUTPUT (exit ' + code + ')');
    console.log(out.slice(0, 2000));
    console.error(err.slice(0, 2000));
  }
});
