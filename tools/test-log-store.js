// 日志层回归：条目上限 + 渲染白名单。
// 背景：刷课是长时间挂着跑的，logList 只 push 不裁剪 → Vue 响应式数组越来越大，
//       面板列表渲染越来越卡；另外日志直接 innerHTML 渲染，题目文本来自平台页面，
//       等于把 DOM 注入面开在课程页里。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, fs.readdirSync(ROOT).find((n) => n.endsWith('.user.js') && n.indexOf('.bak') < 0));
const src = fs.readFileSync(SCRIPT, 'utf8');

const start = src.indexOf('const formatDateTime = (dt) => {');
const end = src.indexOf('const useQuestionStore = ');
if (start < 0 || end < 0) throw new Error('未能定位日志层代码，脚本结构可能已变');
const block = src.slice(start, end);

// 极简 pinia：只需要 state + actions 能跑起来
const pinia = {
  defineStore(name, definition) {
    return function useStore() {
      const store = Object.assign({}, definition.state ? definition.state() : {});
      const actions = definition.actions || {};
      for (const key of Object.keys(actions)) {
        store[key] = actions[key].bind(store);
      }
      return store;
    };
  }
};

const sandbox = { pinia, console, Date, Map, Set, Promise };
vm.createContext(sandbox);
vm.runInContext(
  block +
    '\nglobalThis.__useLogStore = useLogStore;' +
    '\nglobalThis.sanitizeLogHtml = typeof sanitizeLogHtml === "function" ? sanitizeLogHtml : null;',
  sandbox
);
const useLogStore = sandbox.__useLogStore;

const results = [];
const check = (name, ok, extra) => results.push({ name, ok: !!ok, extra: extra === undefined ? '' : String(extra) });

// ---- 条目上限 ----
{
  const store = useLogStore();
  for (let i = 0; i < 100; i += 1) store.addLog('普通日志 ' + i, 'primary');
  check('100 条时不做裁剪', store.logList.length === 100, 'len=' + store.logList.length);

  const overLimitStore = useLogStore();
  for (let i = 0; i < 500; i += 1) overLimitStore.addLog('压力日志 ' + i, 'primary');
  check('超过上限后裁剪到 400 条', overLimitStore.logList.length === 400, 'len=' + overLimitStore.logList.length);
  check('裁剪后保留的是最新一条', overLimitStore.logList[overLimitStore.logList.length - 1].message === '压力日志 499',
    overLimitStore.logList[overLimitStore.logList.length - 1].message);
  check('裁剪丢弃的是最旧一条', overLimitStore.logList[0].message === '压力日志 100',
    overLimitStore.logList[0].message);
}

// ---- clearLog 存在性 ----
// Unipus 分支（useUnipusLogic）进来第一句就是 logStore.clearLog()，
// 这个方法以前根本没定义，直接 TypeError → 面板都不显示。
{
  const store = useLogStore();
  store.addLog('一条日志', 'primary');
  check('clearLog 是函数', typeof store.clearLog === 'function', typeof store.clearLog);
  if (typeof store.clearLog === 'function') {
    store.clearLog();
    check('clearLog 能清空日志', store.logList.length === 0, 'len=' + store.logList.length);
  }
}

// ---- 渲染清洗 ----
{
  const store = useLogStore();
  // 缺失时用恒等函数兜底，让断言自然失败而不是整个文件崩掉（方便拿旧版对比）
  const sanitize = sandbox.sanitizeLogHtml || ((text) => text);
  check('渲染清洗函数存在', typeof sandbox.sanitizeLogHtml === 'function', typeof sandbox.sanitizeLogHtml);

  const injected = sanitize('<img src=x onerror="alert(1)">');
  check('img 标签被转义', injected.indexOf('<img') === -1 && injected.indexOf('&lt;img') === 0, injected);
  check('onerror 属性不会成为可执行 HTML', injected.indexOf('onerror="') === -1, injected);

  const scriptInjected = sanitize('<script>alert(1)</script>');
  check('script 标签被转义', scriptInjected === '&lt;script&gt;alert(1)&lt;/script&gt;', scriptInjected);

  const quoted = sanitize('他说"引号"和\'单引号\'');
  check('引号被转义', quoted.indexOf('&quot;') >= 0 && quoted.indexOf('&#39;') >= 0, quoted);

  const ampersand = sanitize('A & B');
  check('& 被转义', ampersand === 'A &amp; B', ampersand);

  // 脚本自己生成的那一种链接必须保留，否则「点击查看原因」点不了
  const linkLog = '第1道题搜索失败，<a class="log-action-link" href="#" data-log-action="show-answer-tab">点击查看原因</a>';
  const kept = sanitize(linkLog);
  check('白名单链接原样保留', kept.indexOf('<a class="log-action-link"') >= 0, kept);
  check('白名单链接文本未被二次转义', kept.indexOf('点击查看原因') >= 0);

  // 既有白名单链接、又有注入内容：链接留、内容转义
  const mixed = '<img src=x onerror=alert(1)>' + linkLog;
  const mixedOut = sanitize(mixed);
  check('混合内容：注入部分被转义', mixedOut.indexOf('&lt;img') === 0, mixedOut.slice(0, 30));
  check('混合内容：链接仍可用', mixedOut.indexOf('<a class="log-action-link"') >= 0);

  // 日志里最常见的注入来源：课程资源标题
  const titleInjected = sanitize('切换到下一个资源：<svg onload=alert(1)>');
  check('资源标题里的 svg 被转义', titleInjected.indexOf('<svg') === -1, titleInjected);

  store.addLog('<b>正常文本</b>', 'primary');
  check('store 只存原始文本，清洗在渲染层做', store.logList[0].message === '<b>正常文本</b>', store.logList[0].message);
}

let failed = 0;
for (const item of results) {
  if (!item.ok) failed += 1;
  console.log((item.ok ? '  PASS  ' : '  FAIL  ') + item.name + (item.extra ? '  [' + item.extra + ']' : ''));
}
console.log('\n共 ' + results.length + ' 项，失败 ' + failed + ' 项');
process.exit(failed ? 1 : 0);
