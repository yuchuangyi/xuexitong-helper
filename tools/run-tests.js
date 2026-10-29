// 一次性跑完 tools 下所有离线测试并汇总。
// 用法：npm test
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TOOLS = __dirname;
const ROOT = path.join(TOOLS, '..');
const files = fs
  .readdirSync(TOOLS)
  .filter((name) => /^test-.*\.js$/.test(name))
  .sort();

// 版本一致性：package.json 与 .user.js 头部 @version 必须一致
const readVersion = () => {
  const scriptName = fs.readdirSync(ROOT).find((n) => n.endsWith('.user.js') && n.indexOf('.bak') < 0);
  const src = fs.readFileSync(path.join(ROOT, scriptName), 'utf8');
  const match = src.match(/^\/\/ @version\s+(\S+)/m);
  return { script: match ? match[1] : '0.0.0', pkg: require(path.join(ROOT, 'package.json')).version };
};

const results = [];
let total = 0;
let failed = 0;

for (const file of files) {
  const started = Date.now();
  const proc = spawnSync(process.execPath, [path.join(TOOLS, file)], { encoding: 'utf8' });
  const output = (proc.stdout || '') + (proc.stderr || '');
  const match = output.match(/共\s*(\d+)\s*项，失败\s*(\d+)\s*项/);
  if (!match) {
    results.push({ file, ok: false, detail: '未输出统计行（可能崩溃）', output });
    failed += 1;
    continue;
  }
  const count = Number(match[1]);
  const bad = Number(match[2]);
  total += count;
  failed += bad;
  results.push({
    file,
    ok: bad === 0,
    detail: `${count} 项，失败 ${bad} 项（${Date.now() - started}ms）`,
    output
  });
}

const versions = readVersion();
const versionOk = versions.script === versions.pkg;

console.log('');
for (const item of results) {
  console.log(`  ${item.ok ? 'PASS' : 'FAIL'}  ${item.file.padEnd(20)} ${item.detail}`);
  if (!item.ok) {
    const fails = item.output.split(/\r?\n/).filter((line) => line.indexOf('FAIL') >= 0);
    fails.slice(0, 8).forEach((line) => console.log('        ' + line.trim()));
  }
}
console.log(`  ${versionOk ? 'PASS' : 'FAIL'}  版本一致性           @version=${versions.script} package.json=${versions.pkg}`);
console.log(`\n合计 ${total} 项，失败 ${failed} 项${versionOk ? '' : '，版本号不一致'}`);
process.exit(failed || !versionOk ? 1 : 0);
