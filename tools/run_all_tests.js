#!/usr/bin/env node
/**
 * 一次性跑完所有测试。
 *
 *   node tools/run_all_tests.js
 */
const { spawnSync } = require('child_process');
const path = require('path');

const SUITES = [
  { name: '单元测试（编解码与检测）', file: 'test_libs.js' },
  { name: '单字节码表回退测试', file: 'test_legacy_fallback.js' },
  { name: 'manifest 校验', file: 'check_manifest.js' },
  { name: '端到端测试（真实 Chrome）', file: 'e2e_test.js' }
];

let failed = 0;

for (const suite of SUITES) {
  console.log('\n' + '='.repeat(60));
  console.log('  ' + suite.name + '  (' + suite.file + ')');
  console.log('='.repeat(60));
  const result = spawnSync(process.execPath, [path.join(__dirname, suite.file)], {
    stdio: 'inherit',
    cwd: path.join(__dirname, '..')
  });
  if (result.status !== 0) {
    failed++;
    console.log('  >>> 失败：' + suite.name);
  }
}

// 图标由 Python 生成，单独校验
console.log('\n' + '='.repeat(60));
console.log('  图标校验  (check_icons.py)');
console.log('='.repeat(60));
const icons = spawnSync('python', [path.join(__dirname, 'check_icons.py')], {
  stdio: 'inherit',
  cwd: path.join(__dirname, '..')
});
if (icons.status !== 0) {
  failed++;
  console.log('  >>> 失败：图标校验');
}

console.log('\n' + '='.repeat(60));
if (failed) {
  console.log('  有 ' + failed + ' 个测试套件失败');
  process.exit(1);
}
console.log('  全部测试通过');
