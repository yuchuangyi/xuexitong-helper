// P0 回归：超星章节页「任务点卡死」防线。
// 背景：旧实现里 processMedia / waitIframeLoad 都是无限轮询，元素或 iframe 不来就永久挂住，
//       Promise 不 resolve → concatMap 队列停摆 → 后续任务点全部不处理、也不跳章节。
// 本文件用可控时钟驱动脚本里真实的 useCxChapterLogic 内部函数，验证每条路径都有出口。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const rxjs = require('rxjs');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
// 支持指定被测脚本，方便拿历史版本对比（验证这批断言确实能抓到旧 bug）
const SCRIPT = process.env.CX_SCRIPT
  ? path.resolve(ROOT, process.env.CX_SCRIPT)
  : path.join(ROOT, fs.readdirSync(ROOT).find((n) => n.endsWith('.user.js') && n.indexOf('.bak') < 0));
const src = fs.readFileSync(SCRIPT, 'utf8');

// ---- 抽取真实的 useCxChapterLogic，把自动启动段换成导出内部函数 ----
const START = 'const useCxChapterLogic = () => {';
const END = 'const useCxWorkLogic = async () => {';
const startAt = src.indexOf(START);
const endAt = src.indexOf(END);
if (startAt < 0 || endAt < 0) throw new Error('未能定位 useCxChapterLogic，脚本结构可能已变');
let block = src.slice(startAt, endAt);

const LAUNCH = '    init();\n    processIframeTask();\n    setupInterceptor();';
// 主脚本是 CRLF，先归一化再匹配，避免编辑器换行风格不同就断掉
block = block.replace(/\r\n/g, '\n');
if (block.indexOf(LAUNCH) < 0) throw new Error('未能定位 useCxChapterLogic 的启动段');
const EXPORTS = [
  'processMedia',
  'processPpt',
  'processBook',
  'processIframe',
  'processIframeBody',
  'runIframeDocumentTask',
  'waitIframeLoad'
];
block = block.replace(
  LAUNCH,
  'return { ' + EXPORTS.join(', ') + ' };'
);

// ---- 可控时钟：接管 setTimeout / setInterval / Date.now ----
function createClock() {
  let now = 0;
  let seq = 1;
  const timers = new Map();
  const flush = async () => {
    for (let i = 0; i < 3; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = seq++;
      timers.set(id, { fn, ms, at: now + ms, repeat: false });
      return id;
    },
    setInterval(fn, ms) {
      const id = seq++;
      timers.set(id, { fn, ms, at: now + ms, repeat: true });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    clearInterval(id) {
      timers.delete(id);
    },
    pending: () => timers.size,
    async advance(ms) {
      const target = now + ms;
      for (let guard = 0; guard < 200000; guard += 1) {
        let pick = null;
        for (const entry of timers) {
          if (entry[1].at > target) continue;
          if (!pick || entry[1].at < pick[1].at) pick = entry;
        }
        if (!pick) break;
        const [id, timer] = pick;
        now = timer.at;
        if (timer.repeat) timer.at = now + timer.ms;
        else timers.delete(id);
        try {
          timer.fn();
        } catch (error) {
          /* 定时器内部异常不应中断测试 */
        }
        await flush();
      }
      now = target;
      await flush();
    }
  };
}

// ---- 假视频元素：模拟播放器 API ----
function makeVideo(init) {
  const listeners = {};
  const video = {
    muted: false,
    paused: true,
    ended: false,
    duration: 600,
    currentTime: 0,
    async pause() {
      video.paused = true;
    },
    async play() {
      video.paused = false;
      return undefined;
    },
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      listeners[type] = (listeners[type] || []).filter((item) => item !== fn);
    },
    emit(type) {
      (listeners[type] || []).slice().forEach((fn) => fn());
    }
  };
  return Object.assign(video, init || {});
}

// ---- 组装沙箱 ----
function build(clock) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=1&mooc2=1'
  });
  const logs = [];
  const configStore = {
    platformParams: {
      cx: {
        parts: [
          { name: '章节设置', params: [{ value: true }, { value: true }, { value: false }] },
          { name: '考试设置', params: [{ value: true }] }
        ]
      },
      zhs: { parts: [{ name: '答题设置', params: [{ value: true }] }] },
      zhsAi: {
        parts: [
          { name: '学习设置', params: [{ value: true }, { value: true }, { value: 1.5 }, { value: 150 }] },
          { name: '答题设置', params: [{ value: true }, { value: true }] }
        ]
      },
      unipus: { parts: [{ name: '答题设置', params: [{ value: true }] }] },
      unknown: { parts: [{ name: '答题设置', params: [{ value: true }] }] }
    },
    otherParams: { params: [{ value: 3 }, { value: 85 }, { value: 85 }] }
  };

  class FakeDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(clock.now());
      else super(...args);
    }
    static now() {
      return clock.now();
    }
  }

  const sandbox = {
    document: dom.window.document,
    window: dom.window,
    _unsafeWindow: { top: {} },
    console,
    Promise,
    Math,
    JSON,
    Date: FakeDate,
    setTimeout: clock.setTimeout,
    setInterval: clock.setInterval,
    clearTimeout: clock.clearTimeout,
    clearInterval: clock.clearInterval,
    rxjs,
    IframeUtils: {
      getIframes: (element) => Array.from(element.querySelectorAll('iframe')),
      getAllNestedIframes(element) {
        const iframes = Array.from(element.querySelectorAll('iframe'));
        if (!iframes.length) return rxjs.of([]);
        return rxjs.from(iframes).pipe(
          rxjs.mergeMap((iframe) => new rxjs.Observable((subscriber) => {
            let doc = null;
            try {
              doc = iframe.contentDocument;
            } catch (error) {
              doc = null;
            }
            if (!doc) {
              subscriber.next([]);
              subscriber.complete();
              return;
            }
            sandbox.IframeUtils.getAllNestedIframes(doc.documentElement).subscribe((nested) => {
              subscriber.next([iframe, ...nested]);
              subscriber.complete();
            });
          })),
          rxjs.concatAll(),
          rxjs.toArray()
        );
      }
    },
    sleep: (second) => new Promise((resolve) => clock.setTimeout(resolve, second * 1000)),
    decrypt: () => {},
    CxQuestionHandler: class {
      init() {
        return Promise.resolve(100);
      }
    },
    useLogStore: () => ({
      logList: logs,
      addLog: (message, type) => logs.push({ message, type }),
      clearLog: () => {
        logs.length = 0;
      }
    }),
    useQuestionStore: () => ({
      questionList: [],
      addQuestion: () => {},
      clearQuestion: () => {}
    }),
    useConfigStore: () => configStore
  };

  vm.createContext(sandbox);
  vm.runInContext(block + '\nglobalThis.__cxFactory = useCxChapterLogic;', sandbox);
  const api = sandbox.__cxFactory();
  return { api, logs, configStore, clean: () => dom.window.close() };
}

const results = [];
// 未捕获的 Promise 拒绝本身就是缺陷：旧版 play() 被拒时会把异常抛到 async 定时器外，
// 宿主页面收到 unhandledrejection，脚本却以为还在正常跑。这里统一记账。
const unhandled = [];
process.on('unhandledRejection', (reason) => {
  unhandled.push(reason);
});
const check = (name, ok, extra) => {
  results.push({ name, ok: !!ok, extra: extra === undefined ? '' : String(extra) });
};
const lastLogs = (logs, count) => logs.slice(-count).map((item) => item.message).join(' | ');

(async () => {
  // T1 播放器元素根本不出现：必须在等待上限后放行，而不是永久轮询
  {
    const clock = createClock();
    const { api, logs, clean } = build(clock);
    const iframeDocument = { documentElement: { querySelector: () => null } };
    let done = false;
    api.processMedia('video', iframeDocument).then(() => {
      done = true;
    });
    await clock.advance(85000);
    const before = done;
    await clock.advance(10000);
    check('T1 播放器不出现时 90s 前保持等待', before === false, 'done@85s=' + before);
    check('T1 播放器不出现时 90s 后自动放行', done === true, lastLogs(logs, 1));
    check('T1 放行时打印了跳过原因', logs.some((item) => item.message.indexOf('未出现') >= 0), lastLogs(logs, 1));
    clean();
  }

  // T2 播放器挂在页面上但进度永远不动（被限速 / 平台拦播放）
  {
    const clock = createClock();
    const { api, logs, clean } = build(clock);
    const video = makeVideo({ duration: 600, currentTime: 0 });
    const iframeDocument = {
      documentElement: { querySelector: (selector) => (selector === 'video' ? video : null) }
    };
    let done = false;
    api.processMedia('video', iframeDocument).then(() => {
      done = true;
    });
    await clock.advance(55000);
    const before = done;
    await clock.advance(10000);
    check('T2 进度停滞时 55s 前不放弃', before === false, 'done@55s=' + before);
    check('T2 进度停滞超限后放行', done === true, lastLogs(logs, 1));
    check('T2 放行时提示进度未推进', logs.some((item) => item.message.indexOf('未推进') >= 0), lastLogs(logs, 1));
    clean();
  }

  // T3 正常播放到结束：走 ended 出口，不应误判停滞
  {
    const clock = createClock();
    const { api, logs, clean } = build(clock);
    const video = makeVideo({ duration: 600, currentTime: 0 });
    const iframeDocument = {
      documentElement: { querySelector: (selector) => (selector === 'video' ? video : null) }
    };
    let done = false;
    api.processMedia('video', iframeDocument).then(() => {
      done = true;
    });
    await clock.advance(5000);
    const started = logs.some((item) => item.message.indexOf('播放成功') >= 0);
    video.currentTime = 599.5;
    await clock.advance(3000);
    check('T3 正常起播后打印播放成功', started, lastLogs(logs, 2));
    check('T3 播放到尾部自动判定完成', done === true, lastLogs(logs, 1));
    check('T3 正常完成不应报停滞', logs.some((item) => item.message.indexOf('未推进') >= 0) === false);
    clean();
  }

  // T4 iframe 永远加载不完：超时返回 false，不永久轮询
  {
    const clock = createClock();
    const { api, logs, clean } = build(clock);
    const iframe = { contentDocument: { readyState: 'loading' } };
    let settled = null;
    api.waitIframeLoad(iframe).then((value) => {
      settled = value;
    });
    await clock.advance(29000);
    const pending = settled === null;
    await clock.advance(2000);
    check('T4 iframe 加载 29s 时仍在等待', pending === true, 'settled=' + settled);
    check('T4 iframe 加载超时返回 false', settled === false, 'settled=' + settled);
    check('T4 超时后不再遗留定时器', clock.pending() === 0, 'pending=' + clock.pending());
    check('T4 未产生无关日志', logs.length === 0, lastLogs(logs, 2));
    clean();
  }

  // T5 iframe 正常加载：应立刻返回 true
  {
    const clock = createClock();
    const { api, clean } = build(clock);
    const iframe = { contentDocument: { readyState: 'complete' } };
    let settled = null;
    api.waitIframeLoad(iframe).then((value) => {
      settled = value;
    });
    await clock.advance(600);
    check('T5 iframe 就绪时返回 true', settled === true, 'settled=' + settled);
    clean();
  }

  // T6 PPT 阅读器缺失：旧实现会 TypeError，现在必须吞掉并记日志
  {
    const clock = createClock();
    const { api, logs, clean } = build(clock);
    const iframeWindow = { document: { querySelector: () => null } };
    let threw = null;
    await api.processPpt(iframeWindow).catch((error) => {
      threw = error;
    });
    check('T6 PPT 阅读器缺失不抛异常', threw === null, threw && threw.message);
    check('T6 PPT 缺失给出跳过日志', logs.some((item) => item.message.indexOf('PPT 阅读器未挂载') >= 0), lastLogs(logs, 2));
    clean();
  }

  // T7 电子书翻页接口不存在：旧实现会 TypeError，现在必须吞掉并记日志
  {
    const clock = createClock();
    const { api, logs, clean } = build(clock);
    const iframeWindow = { getFrameAttr: () => 'end' };
    let threw = null;
    await api.processBook(iframeWindow).catch((error) => {
      threw = error;
    });
    check('T7 翻页接口缺失不抛异常', threw === null, threw && threw.message);
    check('T7 翻页接口缺失给出跳过日志', logs.some((item) => item.message.indexOf('翻页接口不可用') >= 0), lastLogs(logs, 2));
    clean();
  }

  // T8 任务抛异常：不外抛、且不无限重试同一 iframe
  {
    const clock = createClock();
    const { api, logs, clean } = build(clock);
    const fakeDoc = { marker: 'doc-1' };
    let threw = null;
    await api.runIframeDocumentTask(fakeDoc, () => {
      throw new Error('boom');
    }).catch((error) => {
      threw = error;
    });
    check('T8 任务异常不外抛', threw === null, threw && threw.message);
    check('T8 异常写入日志', logs.some((item) => item.message.indexOf('boom') >= 0), lastLogs(logs, 2));

    let secondRan = false;
    await api.runIframeDocumentTask(fakeDoc, () => {
      secondRan = true;
    });
    check('T8 失败后不再重复处理同一 iframe', secondRan === false);
    clean();
  }

  // T9 串行队列：第一个 iframe 卡住（加载不完），第二个仍要被处理到
  {
    const clock = createClock();
    const { api, logs, clean } = build(clock);
    const brokenIframe = {
      src: 'https://mooc1.chaoxing.com/ananas/modules/video/index.html',
      contentDocument: { readyState: 'loading' },
      contentWindow: {},
      parentElement: null
    };
    const okIframe = {
      src: 'https://mooc1.chaoxing.com/ananas/modules/doc/index.html',
      contentDocument: { readyState: 'complete', documentElement: { querySelector: () => null } },
      contentWindow: {},
      parentElement: null
    };
    const order = [];
    api.processIframe(brokenIframe).then(() => order.push('1'));
    api.processIframe(okIframe).then(() => order.push('2'));
    await clock.advance(1000);
    const early = order.slice();
    await clock.advance(32000);
    check('T9 卡住的 iframe 在 30s 内不误放行', early.join(',') === '2', 'early=' + early.join(','));
    check('T9 卡住的 iframe 超时后队列继续', order.length === 2 && order.indexOf('1') >= 0 && order.indexOf('2') >= 0, 'order=' + order.join(','));
    check('T9 正常 iframe 不必等卡住的那个', order[0] === '2' && order[1] === '1', 'order=' + order.join(','));
    check('T9 超时跳过写了日志', logs.some((item) => item.message.indexOf('未加载完成') >= 0), lastLogs(logs, 1));
    clean();
  }

  // T10 媒体播放被浏览器拒绝（autoplay 策略）：不能变成 unhandled rejection
  {
    const clock = createClock();
    const { api, logs, clean } = build(clock);
    const video = makeVideo({ duration: 600, currentTime: 0 });
    video.play = async () => {
      throw new Error('NotAllowedError');
    };
    const iframeDocument = {
      documentElement: { querySelector: (selector) => (selector === 'video' ? video : null) }
    };
    let done = false;
    api.processMedia('video', iframeDocument).then(() => {
      done = true;
    });
    await clock.advance(6000);
    check('T10 播放被拒绝时给出告警', logs.some((item) => item.message.indexOf('自动播放被拒绝') >= 0), lastLogs(logs, 2));
    await clock.advance(60000);
    check('T10 播放被拒绝后仍能靠停滞上限退出', done === true, lastLogs(logs, 1));
    clean();
  }

  // 等一轮，让异步的 unhandledRejection 事件先落地
  await new Promise((resolve) => setTimeout(resolve, 150));
  check('全程没有未捕获的 Promise 拒绝', unhandled.length === 0,
    unhandled.map((item) => (item && item.message) || item).join('; '));

  let failed = 0;
  for (const item of results) {
    if (!item.ok) failed += 1;
    console.log((item.ok ? '  PASS  ' : '  FAIL  ') + item.name + (item.extra ? '  [' + item.extra + ']' : ''));
  }
  console.log('\n共 ' + results.length + ' 项，失败 ' + failed + ' 项');
  process.exit(failed ? 1 : 0);
})();
