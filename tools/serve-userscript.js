// 临时本地服务：把改造后的用户脚本通过 http://127.0.0.1 提供给浏览器，
// 让 Tampermonkey 弹出安装/更新页面。仅监听回环地址，20 分钟后自动退出。
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = 'C:\\Users\\wangn\\WorkBuddy\\2026-09-11-10-00-35';
const PORT = 18234;
const LIFETIME_MS = 20 * 60 * 1000;
const LOG = path.join(ROOT, 'serve-userscript.log');

const scriptName = fs.readdirSync(ROOT).find((name) => name.endsWith('.user.js'));
const scriptPath = path.join(ROOT, scriptName);

function log(message) {
  try {
    fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${message}\n`);
  } catch (error) {
    /* ignore */
  }
}

let served = 0;

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];

  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      '<meta charset="utf-8"><h3>阿墨·网课助手</h3>' +
      `<p><a href="/amo.user.js">点这里安装 / 更新（Tampermonkey 会自动接管）</a></p>` +
      `<p>本地文件：${scriptName}</p>`
    );
    log(`served index from ${req.headers['user-agent'] || 'unknown'}`);
    return;
  }

  if (url === '/amo.user.js' || url === '/index.user.js') {
    let body;
    try {
      body = fs.readFileSync(scriptPath);
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('读取脚本失败: ' + error.message);
      log('read failed: ' + error.message);
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store'
    });
    res.end(body);
    served += 1;
    log(`served script ${body.length} bytes (第 ${served} 次) ua=${req.headers['user-agent'] || 'unknown'}`);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
  log('404 ' + url);
});

server.listen(PORT, '127.0.0.1', () => {
  log(`listening on http://127.0.0.1:${PORT}/amo.user.js  (file: ${scriptName})`);
  console.log(`ready http://127.0.0.1:${PORT}/amo.user.js`);
});

server.on('error', (error) => {
  log('server error: ' + error.message);
  process.exit(1);
});

setTimeout(() => {
  log('lifetime reached, shutting down');
  server.close(() => process.exit(0));
}, LIFETIME_MS);
