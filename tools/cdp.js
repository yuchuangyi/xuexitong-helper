// 极简 CDP 客户端：连上测试 Chrome 的调试端口，在页面里执行表达式并打印结果。
// 用法: node cdp.js "<js表达式>"  [--await] [--json]
const http = require('http');

const PORT = 9333;
const expression = process.argv[2] || 'document.title';
const useAwait = process.argv.includes('--await');

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(error);
        }
      });
    }).on('error', reject);
  });
}

(async () => {
  const targets = await getJson('/json/list');
  const page = targets.find((t) => t.type === 'page' && t.url.startsWith('http'));
  if (!page) {
    console.log('没有找到 http 页面 target');
    process.exit(1);
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const messageId = ++id;
      pending.set(messageId, { resolve, reject });
      ws.send(JSON.stringify({ id: messageId, method, params }));
    });

  ws.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (error) {
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const slot = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) slot.reject(new Error(JSON.stringify(msg.error)));
      else slot.resolve(msg.result);
    }
  });

  const result = await new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve('open'));
    ws.addEventListener('error', (event) => reject(new Error('websocket error')));
    setTimeout(() => reject(new Error('websocket 连接超时')), 8000);
  }).catch((error) => {
    console.log('连接失败:', error.message);
    process.exit(1);
  });

  try {
    const out = await send('Runtime.evaluate', {
      expression,
      awaitPromise: useAwait,
      returnByValue: true,
      userGesture: true
    });
    if (out.exceptionDetails) {
      console.log('页面内异常:', JSON.stringify(out.exceptionDetails.exception || out.exceptionDetails));
    } else {
      const value = out.result && out.result.value;
      console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    }
  } catch (error) {
    console.log('执行失败:', error.message);
  }
  ws.close();
  process.exit(0);
})();
