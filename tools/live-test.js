// 真机注入测试：连上测试 Chrome（已登录），注入依赖 + GM 垫片 + 脚本本体，观察真实行为。
const fs = require('fs');
const http = require('http');

const DIR = require('path').join(__dirname, '..');
const PORT = 9333;
const SCRIPT = require('path').join(DIR, fs.readdirSync(DIR).find((n) => n.endsWith('.user.js')));

const body = fs
  .readFileSync(SCRIPT, 'utf8')
  .replace(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/m, '');

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

(async () => {
  const targets = await getJson('/json/list');
  const page = targets.find((t) => t.type === 'page' && t.url.includes('zhihuishu.com'));
  if (!page) { console.log('没有找到智慧树页面'); process.exit(1); }
  console.log('目标页面:', page.url);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const slot = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? slot.reject(new Error(JSON.stringify(msg.error))) : slot.resolve(msg.result);
    }
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('ws error')));
    setTimeout(() => reject(new Error('ws 超时')), 8000);
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const evaluate = async (expression) => {
    const out = await send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: true
    });
    if (out.exceptionDetails) throw new Error(JSON.stringify(out.exceptionDetails.exception || out.exceptionDetails));
    return out.result && out.result.value;
  };

  // ---------- 1. 打补丁 + 装载依赖 ----------
  const setup = await evaluate(`(async () => {
    if (!window.__amoPatched) {
      window.__amoPatched = true;
      const origAttach = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function (init) {
        const root = origAttach.call(this, Object.assign({}, init, { mode: 'open' }));
        (window.__amoShadowRoots = window.__amoShadowRoots || []).push(root);
        return root;
      };
      window.GM_addStyle = (css) => { const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s); return s; };
      window.GM_getResourceText = () => '';
      window.GM_getValue = (k, d) => { try { const v = localStorage.getItem('amo:' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } };
      window.GM_setValue = (k, v) => { try { localStorage.setItem('amo:' + k, JSON.stringify(v)); } catch (e) {} };
      window.GM_info = { script: { version: '0.3.1', name: '阿墨·网课助手', namespace: 'amo.netcourse' } };
      window.unsafeWindow = window;
      window.GM_xmlhttpRequest = (opts) => {
        fetch(opts.url, { method: opts.method || 'GET', headers: opts.headers || {}, body: opts.data })
          .then(async (r) => { const text = await r.text(); opts.onload && opts.onload({ status: r.status, responseText: text, readyState: 4 }); })
          .catch((e) => { opts.onerror && opts.onerror(e); });
      };
    }
    const deps = [
      'https://lib.baomitu.com/vue/3.4.31/vue.global.prod.js',
      'https://lib.baomitu.com/vue-demi/0.14.7/index.iife.js',
      'https://lib.baomitu.com/element-plus/2.7.2/index.full.min.js',
      'https://lib.baomitu.com/pinia/2.3.1/pinia.iife.min.js',
      'https://lib.baomitu.com/rxjs/7.8.2/rxjs.umd.min.js',
      'https://lib.baomitu.com/blueimp-md5/2.19.0/js/md5.min.js'
    ];
    // 之前失败过的那批 script 标签要先清掉，否则会被当成已加载
    document.querySelectorAll('script[data-amo]').forEach((s) => s.remove());
    const load = (src) => new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = src; s.setAttribute('data-amo', src);
      s.onload = () => resolve('ok');
      s.onerror = () => resolve('fail');
      document.head.appendChild(s);
    });
    const loaded = {};
    for (const d of deps) {
      loaded[d.split('/').slice(-2).join('/')] = await load(d);
      // pinia 的 IIFE 依赖全局 VueDemi，和脚本 @require 的顺序要求一致
      if (d.includes('vue.global')) window.Vue = window.Vue || Vue;
    }
    return JSON.stringify({ loaded, globals: { Vue: typeof Vue, VueDemi: typeof VueDemi, Pinia: typeof Pinia, rxjs: typeof rxjs, md5: typeof md5, ElementPlus: typeof ElementPlus } });
  })()`);
  console.log('\n=== 依赖装载 ===\n' + setup);

  // ---------- 2. 注入脚本本体 ----------
  const injectResult = await evaluate(`(() => {
    try {
      ${body}
      return 'injected-ok';
    } catch (e) {
      return 'inject-error: ' + (e && e.message);
    }
  })()`);
  console.log('\n=== 注入结果 ===\n' + injectResult);

  // ---------- 3. 观察 ----------
  const snap = async (label) => {
    const state = await evaluate(`(() => {
      const roots = window.__amoShadowRoots || [];
      const panelText = roots.map((r) => (r.textContent || '').replace(/\\s+/g, ' ').trim()).join(' || ').slice(0, 1400);
      const cards = [...document.querySelectorAll('.resources-list .basic-info-video-card-container')].map((c) => ({
        active: /(^|\\s)active(\\s|$)/.test(c.className),
        text: c.innerText.replace(/\\s+/g, ' ').trim().slice(0, 40)
      }));
      const points = [...document.querySelectorAll('.section-item-collapse-info')].filter((p) => /(^|\\s)active(\\s|$)/.test(p.className))
        .map((p) => p.innerText.replace(/\\s+/g, ' ').trim().slice(0, 40));
      const v = document.querySelector('video');
      return JSON.stringify({
        path: location.pathname,
        cards, activePoints: points,
        video: v ? { paused: v.paused, muted: v.muted, rate: v.playbackRate, cur: Math.round(v.currentTime), dur: Math.round(v.duration || 0) } : null,
        panelTail: panelText.slice(-700)
      });
    })()`);
    console.log('\n=== ' + label + ' ===');
    try {
      const parsed = JSON.parse(state);
      console.log('路由:', parsed.path);
      console.log('视频:', JSON.stringify(parsed.video));
      console.log('当前知识点:', JSON.stringify(parsed.activePoints));
      console.log('资源卡片:', JSON.stringify(parsed.cards, null, 1));
      console.log('面板日志尾部:', parsed.panelTail);
    } catch (e) {
      console.log(state);
    }
  };

  await new Promise((r) => setTimeout(r, 6000));
  await snap('注入后 6 秒');
  await new Promise((r) => setTimeout(r, 20000));
  await snap('注入后 26 秒');

  ws.close();
  process.exit(0);
})().catch((error) => {
  console.log('执行失败:', error.message);
  process.exit(1);
});
