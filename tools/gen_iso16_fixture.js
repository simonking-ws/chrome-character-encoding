// Compare Python's iso8859_16 codec with Chrome's native ISO-8859-16 decoder.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-l16-'));

const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><pre id="out">pending</pre>
<script>
const dec = new TextDecoder('iso-8859-16');
const table = [];
for (let b = 0; b < 256; b++) table.push(dec.decode(Uint8Array.from([b])).codePointAt(0));
document.getElementById('out').textContent = JSON.stringify(table);
</script></body></html>`;

const file = path.join(os.tmpdir(), 'ce-l16.html');
fs.writeFileSync(file, html);

const child = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--user-data-dir=' + profile, '--virtual-time-budget=20000', '--dump-dom',
  'file:///' + file.replace(/\\/g, '/')
], { stdio: ['ignore', 'pipe', 'pipe'] });

let out = '';
child.stdout.on('data', (d) => (out += d));
child.on('close', () => {
  fs.rmSync(profile, { recursive: true, force: true });
  const m = out.match(/<pre id="out">([\s\S]*?)<\/pre>/);
  const chromeTable = JSON.parse(m[1].replace(/&quot;/g, '"'));
  fs.writeFileSync(path.join(__dirname, 'chrome_iso8859_16.json'), JSON.stringify(chromeTable));

  // Compare with Python
  const { execFileSync } = require('child_process');
  const py = execFileSync('python', ['-c', `
import json
t = []
for b in range(256):
    try:
        s = bytes([b]).decode("iso8859_16")
        t.append(ord(s))
    except Exception:
        t.append(0xFFFD)
print(json.dumps(t))
`], { encoding: 'utf8' });
  const pyTable = JSON.parse(py);

  let diff = 0;
  const samples = [];
  for (let b = 0; b < 256; b++) {
    if (chromeTable[b] !== pyTable[b]) {
      diff++;
      if (samples.length < 10) {
        samples.push({
          byte: b.toString(16),
          chrome: chromeTable[b].toString(16),
          python: pyTable[b].toString(16)
        });
      }
    }
  }
  console.log('差异字节数:', diff, 'of 256');
  console.log(JSON.stringify(samples, null, 1));
});
