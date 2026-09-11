// 只观察、不注入：看视频资源加载后，播放器到底是什么结构。
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
  if (!page) { console.log('未找到智慧树页面'); process.exit(1); }

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
    const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (out.exceptionDetails) throw new Error(JSON.stringify(out.exceptionDetails.exception || out.exceptionDetails));
    return out.result && out.result.value;
  };

  console.log('当前页面:', page.url);
  await new Promise((r) => setTimeout(r, 5000));

  // 点开视频资源卡片
  const clicked = await evaluate(`(async () => {
    const cards = [...document.querySelectorAll('.resources-list .basic-info-video-card-container')];
    const list = cards.map((c) => c.innerText.replace(/\\s+/g, ' ').trim().slice(0, 45));
    // 找带时长的（=视频资源）
    const videoCard = cards.find((c) => /\\d{1,2}:\\d{2}:\\d{2}/.test(c.innerText));
    if (!videoCard) return JSON.stringify({ list, clicked: false });
    videoCard.scrollIntoView({ block: 'center' });
    const t = videoCard.querySelector('.item-mask') || videoCard;
    ['mouseover', 'mousedown', 'mouseup', 'click'].forEach((k) =>
      t.dispatchEvent(new MouseEvent(k, { bubbles: true, cancelable: true, view: window })));
    t.click();
    // 尽快静音，避免打扰
    const mute = () => document.querySelectorAll('video').forEach((v) => { v.muted = true; });
    for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 500)); mute(); }
    return JSON.stringify({ list, clicked: true, target: videoCard.innerText.replace(/\\s+/g, ' ').trim().slice(0, 45) });
  })()`);
  console.log('\n=== 资源卡片 ===\n' + clicked);

  // 观察播放器结构
  const probe = await evaluate(`(() => {
    const videos = [...document.querySelectorAll('video')];
    const iframes = [...document.querySelectorAll('iframe')].map((f) => ({
      src: (f.src || '').slice(0, 90),
      sameOrigin: (() => { try { return !!f.contentDocument; } catch (e) { return false; } })()
    }));
    // 主文档和同源 iframe 里都找一遍
    let iframeVideos = 0;
    document.querySelectorAll('iframe').forEach((f) => {
      try { const d = f.contentDocument; if (d) iframeVideos += d.querySelectorAll('video').length; } catch (e) {}
    });
    const wrapper = document.querySelector('.video-player-wrapper, [class*="video-player"]');
    return JSON.stringify({
      mainVideos: videos.length,
      videoDetail: videos.map((v) => ({
        muted: v.muted, paused: v.paused, rate: v.playbackRate,
        cur: Math.round(v.currentTime), dur: Math.round(v.duration || 0),
        cls: String(v.className || '').slice(0, 60),
        parentCls: String((v.parentElement && v.parentElement.className) || '').slice(0, 80)
      })),
      iframeVideos, iframes,
      wrapperCls: wrapper ? String(wrapper.className).slice(0, 90) : '无',
      wrapperHtml: wrapper ? wrapper.outerHTML.replace(/\\s+/g, ' ').slice(0, 600) : '无'
    });
  })()`);
  console.log('\n=== 播放器结构 ===\n' + probe);

  ws.close();
  process.exit(0);
})().catch((error) => { console.log('失败:', error.message); process.exit(1); });
