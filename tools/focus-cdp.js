// 把调试实例里指定的标签页切到前台，方便肉眼观察
const http = require('http');
const PORT = 9333;

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

(async () => {
  const targets = await getJson('/json/list');
  const page = targets.find((t) => t.type === 'page' && t.url.includes('zhihuishu.com'));
  if (!page) { console.log('未找到目标页面'); process.exit(1); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  });
  await new Promise((r) => ws.addEventListener('open', r));
  const send = (method, params = {}) => new Promise((r) => { const mid = ++id; pending.set(mid, r); ws.send(JSON.stringify({ id: mid, method, params })); });
  await send('Page.enable');
  await send('Page.bringToFront');
  console.log('已把测试标签页切到前台：' + page.url.slice(0, 100));
  ws.close();
  process.exit(0);
})().catch((e) => { console.log('失败:', e.message); process.exit(1); });
