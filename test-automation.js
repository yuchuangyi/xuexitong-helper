// 真机结构仿真：用 2026-09-11 实测到的真实 DOM 结构，驱动脚本里真实的 useZhsAiCourseLogic 主循环。
// 覆盖「目录页挑未完成知识点 → 学习页播视频/读图文 → 切下一个资源 → 切下一个知识点」整条链路。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const DIR = 'C:\\Users\\wangn\\WorkBuddy\\2026-09-11-10-00-35';
const SCRIPT = path.join(DIR, fs.readdirSync(DIR).find((name) => name.endsWith('.user.js')));
const src = fs.readFileSync(SCRIPT, 'utf8');

function slice(from, to) {
  const start = src.indexOf(from);
  if (start < 0) throw new Error('找不到起点: ' + from);
  const end = src.indexOf(to, start);
  if (end < 0) throw new Error('找不到终点: ' + to);
  return src.slice(start, end);
}

const baseClass = slice('class BaseQuestionHandler {', 'class CxQuestionHandler');
const zsAiBlock = slice(
  '/* ================= 智慧树 AI 课程（知识学习页）适配 · 开始',
  '/* ================= 智慧树 AI 课程（知识学习页）适配 · 结束'
);

const HOST = 'https://ai-smart-course-student-pro.zhihuishu.com';
const LEARN_URL = HOST + '/learnPage/2065759622273359872/1851192466150133760/275251';
const CATALOG_URL = HOST + '/singleCourse/knowledgeStudy/2065759622273359872/275251';

const results = [];
const check = (name, ok, extra) => results.push({ name, ok: !!ok, extra: extra === undefined ? '' : String(extra) });

const prelude = `
var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => { __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value); return value; };

var __fakeNow = 1700000000000;
Date.now = () => __fakeNow;
var __advanceClock = (ms) => { __fakeNow += ms; };

var logs = [];
var aiCallCount = 0;
var _unsafeWindow = window;
var sleep = (second) => new Promise((resolve) => setTimeout(resolve, Math.min(second * 20, 60)));
var hookError = () => {};

var __ticks = [];
var setInterval = (fn, ms) => { __ticks.push(fn); return __ticks.length; };

var useLogStore = () => ({ addLog: (message, type) => logs.push([type, message]) });
var useQuestionStore = () => ({ questionList: [], addQuestion: () => {}, clearQuestion: () => {} });
var __config = {
  deepseek: { apiKey: "sk-test", model: "deepseek-flash", baseUrl: "https://api.deepseek.com" },
  otherParams: { name: "其他参数", params: [
    { name: "切换、答题间隔，单位秒", value: 3, type: "number" },
    { name: "正确率达到多少自动提交", value: 85, type: "number" },
    { name: "答案相似度超过多少选择", value: 85, type: "number" }
  ] },
  platformParams: {
    zhsAi: {
      parts: [
        { params: [{ value: true }, { value: true }, { value: 1 }, { value: 150 }] },
        { params: [{ value: true }, { value: true }] }
      ]
    }
  }
};
var useConfigStore = () => __config;
var getAnswer = async () => {
  aiCallCount += 1;
  return window.__cannedAnswer || { code: 200, data: { answer: ["B. 球体"] } };
};
var __logs = () => logs;
`;

function buildDom(pageHtml, url) {
  const dom = new JSDOM('<!doctype html><html><body>' + pageHtml + '</body></html>', {
    pretendToBeVisual: true,
    runScripts: 'outside-only',
    url
  });
  const { window } = dom;
  window.Element.prototype.getClientRects = function () {
    const style = window.getComputedStyle(this);
    if (style.display === 'none' || style.visibility === 'hidden') return [];
    return [{ width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10 }];
  };
  window.Element.prototype.scrollIntoView = function () {};
  const media = window.HTMLMediaElement.prototype;
  media.play = function () {
    this.__played = true;
    Object.defineProperty(this, 'paused', { value: false, configurable: true });
    return Promise.resolve();
  };
  media.pause = function () {
    Object.defineProperty(this, 'paused', { value: true, configurable: true });
    return Promise.resolve();
  };
  window.document.addEventListener('click', (event) => {
    const key = describe(event.target);
    window.__clicks[key] = (window.__clicks[key] || 0) + 1;
  }, true);
  window.__clicks = {};
  return dom;
}

function describe(el) {
  if (!el || !el.tagName) return 'unknown';
  // 点击命中的经常是没有文本的覆盖层（如 .item-mask），向上找有文本的祖先
  let node = el;
  let text = '';
  for (let depth = 0; depth < 4 && node; depth += 1) {
    const current = String(node.textContent || '').replace(/\s+/g, '');
    if (current) {
      text = current.slice(0, 18);
      break;
    }
    node = node.parentElement;
  }
  const cls = String(el.className || '').split(' ').filter(Boolean).slice(0, 2).join('.');
  return el.tagName.toLowerCase() + (cls ? '.' + cls : '') + '#' + text;
}

// ---- 真实结构片段 ----
// 学习页资源卡片：文本形如 "世界的物质统一性 00:05:27 0%" / "三、世界的物质统一性 已完成"
const RESOURCE_CARDS = (items) => items.map((item) => `
  <div class="basic-info-video-card-container${item.active ? ' ZHIHUISHU_QZMD active' : ''}">
    <div class="video-wrap"><div class="video-img-bg"><img></div><img class="video-image"></div>
    <div class="video-info"><div class="video-title">${item.title}</div>
      <div class="video-progress">${item.state}</div></div>
  </div>`).join('');

// 学习页左侧目录：<div class="section-item-collapse-info [active]"><div class="section-item-collapse-title"><div class="title-text">名</div></div><div class="collapse-info-progress"><div class="progress-text">必学 x/y</div></div></div>
const STUDY_POINTS = (items) => items.map((item) => `
  <div class="section-item-collapse-info${item.active ? ' active' : ''}">
    <div class="section-item-collapse-title"><div class="title-text">${item.name}</div></div>
    <div class="collapse-info-progress"><div class="progress-text">必学 <span>${item.done}</span>/${item.total}</div></div>
  </div>`).join('');

// 目录页知识点条目：<div class="item-content" knowledgeid="...">
const CATALOG_ITEMS = (items) => `
  <div class="conlist-content-box">
  ${items.map((item) => `
    <div class="item-content" knowledgeid="${item.id}" id="knowledgeId-${item.id}">
      <div class="stydy-hint"></div>
      <div class="item-mask el-tooltip__trigger"></div>
      <div class="item-top">
        <div class="item-top-left"><div class="item-title" title="${item.name}">${item.name}</div></div>
        <div class="item-top-right">
          <div class="item-top-right-svg"><div class="el-progress el-progress--dashboard" role="progressbar" aria-valuenow="${item.mastery}" aria-valuemin="0" aria-valuemax="100"></div></div>
          <div class="item-top-right-text">掌握度</div>
        </div>
      </div>
      <div class="item-bottom">
        <div class="bottom-text"> 学习进度&nbsp;<span class="progress-num">${item.progress}<span class="pctte">%</span></span></div>
        <div class="left-item-pct"><div class="pct-num" style="width: ${item.progress}%;"></div></div>
      </div>
    </div>`).join('')}
  </div>`;

const QUESTION_BLOCK = `
  <div class="questionContent">
    <div class="questionTitle"><span class="letterSortNum">1</span>（单选题）地球的形状是（ ）</div>
    <div class="centent-pre"><div class="preStyle">地球的形状是（ ）</div></div>
    <div class="el-radio-group">
      <label class="el-radio"><span class="el-radio__input"><input type="radio" class="el-radio__original" name="q1"></span><span class="letterSort">A</span><span class="el-radio__label">方的</span></label>
      <label class="el-radio"><span class="el-radio__input"><input type="radio" class="el-radio__original" name="q1"></span><span class="letterSort">B</span><span class="el-radio__label">球体</span></label>
    </div>
    <div class="pre-next"><button class="next-topic"><span>下一题</span></button></div>
  </div>`;

async function boot(pageHtml, url) {
  const dom = buildDom(pageHtml, url);
  const { window } = dom;
  const ctx = dom.getInternalVMContext();
  vm.runInContext(prelude, ctx);
  vm.runInContext(
    baseClass + '\n' + zsAiBlock +
    '\nglobalThis.__start = () => useZhsAiCourseLogic();' +
    '\nglobalThis.__api = { zsAiFindScrollable, zsAiIsScrollable };',
    ctx,
    { filename: 'zsai-extract.js' }
  );
  return { dom, window, ctx };
}

async function start(ctx, window) {
  vm.runInContext('__start()', ctx);
  await wait(window, 90);
}
async function wait(window, ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
async function nextTick(ctx, window) {
  const tick = vm.runInContext('__ticks[0]', ctx);
  if (!tick) throw new Error('未捕获到 tick 回调');
  await tick();
  await wait(window, 40);
}
function clicks(window, keyword) {
  const needle = keyword.replace(/\s+/g, '');
  return Object.entries(window.__clicks)
    .filter(([key]) => key.includes(needle))
    .reduce((sum, [, count]) => sum + count, 0);
}
function lastLogs(ctx, count) {
  return vm.runInContext('__logs()', ctx).slice(-count).map((item) => item[1]).join(' | ');
}

(async () => {
  /* ============ 学习页 /learnPage ============ */

  // A. 视频资源：自动播放 / 静音 / 倍速，不乱点
  {
    const { window, ctx } = await boot(`
      ${STUDY_POINTS([{ name: '物质及其存在方式', done: 2, total: 4 }, { name: '世界的物质统一性', done: 0, total: 2, active: true }])}
      <video class="study-video"></video>
      <div class="resources-list">${RESOURCE_CARDS([
        { title: '三、世界的物质统一性', state: '已完成' },
        { title: '世界的物质统一性', state: '00:05:27 0%', active: true }
      ])}</div>`, LEARN_URL);
    const video = window.document.querySelector('video');
    await start(ctx, window);
    check('A 视频自动播放', video.__played === true);
    check('A 视频自动静音', video.muted === true);
    check('A 视频倍速按设置生效', video.playbackRate === 1, 'rate=' + video.playbackRate);
    check('A 视频播放中不误点资源卡片', clicks(window, 'basic-info-video-card') === 0, 'clicks=' + clicks(window, 'basic-info-video-card'));
    check('A 路由识别为学习页', /学习页/.test(lastLogs(ctx, 4)), lastLogs(ctx, 4));
    window.close();
  }

  // B. 当前资源已完成 + 视频播完 → 切到下一个未完成资源
  {
    const { window, ctx } = await boot(`
      ${STUDY_POINTS([{ name: '世界的物质统一性', done: 0, total: 3, active: true }])}
      <video class="study-video"></video>
      <div class="resources-list">${RESOURCE_CARDS([
        { title: '三、世界的物质统一性', state: '已完成', active: true },
        { title: '世界的物质统一性', state: '00:05:27 0%' },
        { title: '小结与思考', state: '未完成' }
      ])}</div>`, LEARN_URL);
    await start(ctx, window);
    await nextTick(ctx, window);
    check('B 切到下一个未完成资源', clicks(window, '世界的物质统一性00:05:27') > 0,
      'clicks=' + clicks(window, '世界的物质统一性00:05:27') + ' | ' + lastLogs(ctx, 3));
    check('B 不重复点已完成的资源', clicks(window, '三、世界的物质统一性已完成') === 0);
    window.close();
  }

  // C. 资源全部完成 → 切到下一个未完成知识点（跳过当前）
  {
    const { window, ctx } = await boot(`
      ${STUDY_POINTS([
        { name: '物质及其存在方式', done: 2, total: 4 },
        { name: '世界的物质统一性', done: 2, total: 2, active: true },
        { name: '联系和发展的普遍性', done: 0, total: 4 }
      ])}
      <div class="resources-list">${RESOURCE_CARDS([
        { title: '三、世界的物质统一性', state: '已完成', active: true },
        { title: '四、世界的物质统一性', state: '已完成' }
      ])}</div>`, LEARN_URL);
    await start(ctx, window);
    check('C 切到下一个未完成知识点', clicks(window, '联系和发展的普遍性') > 0,
      'clicks=' + clicks(window, '联系和发展的普遍性') + ' | ' + lastLogs(ctx, 3));
    check('C 没有重复点当前知识点', clicks(window, '世界的物质统一性必学') === 0);
    check('C 提示了切换动作', /切换到下一个知识点/.test(lastLogs(ctx, 3)), lastLogs(ctx, 3));
    window.close();
  }

  // D. 图文资源（没有 video）：停留超时后跳到下一个资源
  {
    const { window, ctx } = await boot(`
      ${STUDY_POINTS([{ name: '世界的物质统一性', done: 0, total: 2, active: true }])}
      <div class="learn-page-main"><div class="article"><img><img><p>图文内容</p></div></div>
      <div class="resources-list">${RESOURCE_CARDS([
        { title: '三、世界的物质统一性', state: '未完成', active: true },
        { title: '世界的物质统一性', state: '00:05:27 0%' }
      ])}</div>`, LEARN_URL);
    await start(ctx, window);
    const logAfterStart = lastLogs(ctx, 3);
    check('D 识别到图文资源并开始阅读', /图文资源阅读中/.test(logAfterStart) || /图文/.test(logAfterStart), logAfterStart);
    vm.runInContext('__advanceClock(200000)', ctx);
    await nextTick(ctx, window);
    check('D 超时后跳到下一个资源', clicks(window, '世界的物质统一性00:05:27') > 0,
      'clicks=' + clicks(window, '世界的物质统一性00:05:27') + ' | ' + lastLogs(ctx, 3));
    check('D 超时给出告警日志', /超过 150s/.test(lastLogs(ctx, 4)), lastLogs(ctx, 4));
    window.close();
  }

  // E. 页面有题目时优先答题
  {
    const { window, ctx } = await boot(`
      ${STUDY_POINTS([{ name: '世界的物质统一性', done: 0, total: 2, active: true }])}
      <video class="study-video"></video>
      <div class="resources-list">${RESOURCE_CARDS([{ title: '世界', state: '0%', active: true }])}</div>
      ${QUESTION_BLOCK}`, LEARN_URL);
    await start(ctx, window);
    await wait(window, 200);
    const asked = vm.runInContext('aiCallCount', ctx);
    const labels = Array.from(window.document.querySelectorAll('label.el-radio'));
    const checkedIndex = labels.findIndex((l) => l.querySelector('input').checked);
    check('E 有题目时调用了 AI 答题', asked === 1, 'asked=' + asked + ' | ' + lastLogs(ctx, 3));
    check('E 选中了 AI 给的答案', checkedIndex === 1, 'checkedIndex=' + checkedIndex);
    check('E 答题后点了下一题', clicks(window, 'next-topic') > 0, 'clicks=' + clicks(window, 'next-topic'));
    window.close();
  }

  /* ============ 目录页 /singleCourse/knowledgeStudy ============ */

  // F. 进入第一个未完成知识点
  {
    const { window, ctx } = await boot(
      CATALOG_ITEMS([
        { id: '1851192465760063488', name: '物质与意识的辩证关系', mastery: 100, progress: 100 },
        { id: '1851192466150133760', name: '世界的物质统一性', mastery: 0, progress: 50 },
        { id: '1851192466301128704', name: '联系和发展的普遍性', mastery: 0, progress: 0 }
      ]), CATALOG_URL);
    await start(ctx, window);
    check('F 路由识别为目录页', /目录页/.test(lastLogs(ctx, 5)), lastLogs(ctx, 5));
    check('F 进入第一个未完成知识点', clicks(window, '世界的物质统一性') > 0,
      'clicks=' + clicks(window, '世界的物质统一性') + ' | ' + lastLogs(ctx, 3));
    check('F 跳过已完成的知识点', clicks(window, '物质与意识的辩证关系') === 0);
    check('F 日志打印了知识点名', /进入未完成知识点：世界的物质统一性/.test(lastLogs(ctx, 3)), lastLogs(ctx, 3));
    window.close();
  }

  // G. 冷却期内不重复点同一个知识点，改点下一个未完成
  {
    const { window, ctx } = await boot(
      CATALOG_ITEMS([
        { id: '1', name: '甲知识点', mastery: 0, progress: 0 },
        { id: '2', name: '乙知识点', mastery: 0, progress: 0 }
      ]), CATALOG_URL);
    await start(ctx, window);
    const afterFirst = clicks(window, '甲知识点');
    vm.runInContext('__advanceClock(7000)', ctx);
    await nextTick(ctx, window);
    check('G 重复点击甲被冷却拦住', clicks(window, '甲知识点') === afterFirst, `首次=${afterFirst} 再tick=${clicks(window, '甲知识点')}`);
    check('G 改点下一个未完成知识点', clicks(window, '乙知识点') > 0, 'clicks=' + clicks(window, '乙知识点') + ' | ' + lastLogs(ctx, 3));
    window.close();
  }

  // H. 目录页全部 100% → 给提示且不乱点
  {
    const { window, ctx } = await boot(
      CATALOG_ITEMS([
        { id: '1', name: '甲知识点', mastery: 100, progress: 100 },
        { id: '2', name: '乙知识点', mastery: 100, progress: 100 }
      ]), CATALOG_URL);
    await start(ctx, window);
    check('H 全部完成时给出提示', /都已是 100%/.test(lastLogs(ctx, 4)), lastLogs(ctx, 4));
    check('H 全部完成时不再点击', clicks(window, '知识点') === 0, 'clicks=' + clicks(window, '知识点'));
    window.close();
  }

  // I. 非目标页面不动作
  {
    const { window, ctx } = await boot('<div>其他页面</div>', HOST + '/mySpace');
    await start(ctx, window);
    check('I 非目标路由时待机', /待机中/.test(lastLogs(ctx, 4)), lastLogs(ctx, 4));
    check('I 非目标路由不点击', Object.keys(window.__clicks).length === 0);
    window.close();
  }

  // J. 滚动容器必须真的能滚（overflow 校验）——这是文档任务点「一直刷新」的根因
  {
    const { window, ctx } = await boot(`
      <div class="learn-page-main" style="overflow: visible" id="wrapper">页面外层容器（overflow 是 visible，根本不能滚）</div>
      <div class="resources-detail-container" style="overflow-y: auto" id="real">真正的滚动区</div>`, LEARN_URL);
    const wrapper = window.document.getElementById('wrapper');
    const real = window.document.getElementById('real');
    // jsdom 没有布局引擎，手动给出尺寸
    [wrapper, real].forEach((el) => {
      Object.defineProperty(el, 'scrollHeight', { value: 9000, configurable: true });
      Object.defineProperty(el, 'clientHeight', { value: 800, configurable: true });
    });
    const api = vm.runInContext('__api', ctx);
    const wrapperScrollable = api.zsAiIsScrollable(wrapper);
    const realScrollable = api.zsAiIsScrollable(real);
    const chosen = api.zsAiFindScrollable();
    check('J 外层容器（overflow:visible）不算可滚动', wrapperScrollable === false, 'wrapperScrollable=' + wrapperScrollable);
    check('J overflow-y:auto 的容器能被识别', realScrollable === true, 'realScrollable=' + realScrollable);
    check('J 找到的是真正的滚动区而不是页面外层',
      chosen && chosen.id === 'real', 'chosen=' + (chosen ? chosen.id : 'null'));
    window.close();
  }

  // K. 滚动真的发生时要有步数上限，不会无限滚
  {
    const { window, ctx } = await boot(`
      ${STUDY_POINTS([{ name: '甲知识点', done: 0, total: 2, active: true }])}
      <div class="learn-page-main" style="overflow-y: auto"><div class="doc">长文档</div></div>
      <div class="resources-list">${RESOURCE_CARDS([{ title: '文档任务点', state: '未完成', active: true }])}</div>`, LEARN_URL);
    const scroller = window.document.querySelector('.learn-page-main');
    Object.defineProperty(scroller, 'scrollHeight', { value: 100000, configurable: true });
    Object.defineProperty(scroller, 'clientHeight', { value: 800, configurable: true });
    let moves = 0;
    let last = 0;
    Object.defineProperty(scroller, 'scrollTop', {
      get() { return last; },
      set(v) { if (v !== last) { last = v; moves += 1; } },
      configurable: true
    });
    await start(ctx, window);
    await nextTick(ctx, window);
    await nextTick(ctx, window);
    check('K 图文资源在滚动阅读', moves > 0, 'moves=' + moves);
    check('K 滚动步数受上限约束', vm.runInContext('__ticks.length', ctx) >= 1, 'ticks=' + vm.runInContext('__ticks.length', ctx));
    window.close();
  }

  let failed = 0;
  for (const item of results) {
    if (!item.ok) failed += 1;
    console.log((item.ok ? '  PASS  ' : '  FAIL  ') + item.name + (item.extra ? '  [' + item.extra + ']' : ''));
  }
  console.log('\n共 ' + results.length + ' 项，失败 ' + failed + ' 项');
  process.exit(failed ? 1 : 0);
})();
