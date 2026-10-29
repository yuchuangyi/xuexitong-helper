// 把脚本里真实的判断函数放到真机页面上跑，看哪一个返回了错误结果。
const fs = require('fs');
const path = require('path');
const http = require('http');

const DIR = 'C:\\Users\\wangn\\WorkBuddy\\2026-09-11-10-00-35';
const PORT = 9333;
const SCRIPT = path.join(DIR, fs.readdirSync(DIR).find((n) => n.endsWith('.user.js')));
const src = fs.readFileSync(SCRIPT, 'utf8');

function slice(from, to) {
  const start = src.indexOf(from);
  if (start < 0) throw new Error('找不到 ' + from);
  const end = src.indexOf(to, start);
  if (end < 0) throw new Error('找不到 ' + to);
  return src.slice(start, end);
}

const helpers = slice(
  '/* ================= 智慧树 AI 课程（知识学习页）适配 · 开始',
  'class ZhsAiQuestionHandler extends BaseQuestionHandler'
);

function getJson(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

(async () => {
  const targets = await getJson('/json/list');
  const page = targets.find((t) => t.type === 'page' && t.url.includes('zhihuishu.com'));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  });
  await new Promise((r) => ws.addEventListener('open', r));
  const send = (method, params = {}) => new Promise((r) => { const mid = ++id; pending.set(mid, r); ws.send(JSON.stringify({ id: mid, method, params })); });
  const evaluate = async (expression) => {
    const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (out.exceptionDetails) throw new Error(JSON.stringify(out.exceptionDetails.exception || out.exceptionDetails));
    return out.result && out.result.value;
  };

  await evaluate(`(function(){
    var _unsafeWindow = window;
${helpers}
    globalThis.__h = { zsAiGetResourceCards, zsAiCardIsActive, zsAiCardFinished, zsAiIsVideoCard, zsAiGetVideo, zsAiIsScrollable, zsAiCardKey, zsAiPlain, zsAiIsVisible };
  })();`);

  const result = await evaluate(`(() => {
    const h = globalThis.__h;
    const cards = h.zsAiGetResourceCards().filter((c) => h.zsAiIsVisible(c));
    return JSON.stringify(cards.map((c, index) => {
      const video = h.zsAiGetVideo();
      return {
        index,
        cls: String(c.className || '').slice(0, 70),
        text: h.zsAiPlain(c.textContent).slice(0, 55),
        isActive: h.zsAiCardIsActive(c),
        isFinished: h.zsAiCardFinished(c),
        isVideoCard: h.zsAiIsVideoCard(c),
        key: h.zsAiCardKey(c).slice(0, 30),
        videoFoundNow: !!video
      };
    }), null, 1);
  })()`);
  console.log('=== 真实页面上的判定结果 ===');
  console.log(result);

  const videoInfo = await evaluate(`(() => {
    const v = globalThis.__h.zsAiGetVideo();
    return JSON.stringify(v ? { found: true, cls: String(v.className||'').slice(0,40), dur: Math.round(v.duration||0), cur: Math.round(v.currentTime), paused: v.paused } : { found: false });
  })()`);
  console.log('\n=== zsAiGetVideo 实际返回 ===');
  console.log(videoInfo);

  ws.close();
  process.exit(0);
})().catch((error) => { console.log('失败:', error.message); process.exit(1); });
