// 答题链路回归：答案缓存 / 429 退避 / 作答率语义。
// 背景：
//   1) 同一道题（题干+选项一致）反复请求 DeepSeek，同题库的题在章节作业里很常见，白烧 token。
//   2) 429 只固定等 2s 重试一次，连续答题时很容易继续撞限流。
//   3) CxQuestionHandler.init 返回的 "correctRate" 其实是「AI 成功作答的比例」，
//      不是答对率（脚本拿不到平台判分结果），调用方却当成正确率来卡自动提交。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, fs.readdirSync(ROOT).find((n) => n.endsWith('.user.js') && n.indexOf('.bak') < 0));
const src = fs.readFileSync(SCRIPT, 'utf8');

function slice(from, to) {
  const start = src.indexOf(from);
  if (start < 0) throw new Error('找不到起点: ' + from);
  const end = src.indexOf(to, start);
  if (end < 0) throw new Error('找不到终点: ' + to);
  return src.slice(start, end);
}

const results = [];
const check = (name, ok, extra) => results.push({ name, ok: !!ok, extra: extra === undefined ? '' : String(extra) });

(async () => {

// ============ A. getAnswer：缓存 + 退避 ============
// 缓存代码块是 0.3.6 才加进来的；对更早的版本退化成只抽 getAnswer 本体，
// 让断言自然失败而不是整个文件崩掉（方便拿旧版对比）。
const CACHE_START_MARK = 'const ANSWER_CACHE_MAX = 300;';
const cacheStartAt = src.indexOf(CACHE_START_MARK) >= 0
  ? src.indexOf(CACHE_START_MARK)
  : src.indexOf('const getAnswer = async');
if (cacheStartAt < 0) throw new Error('未能定位 getAnswer');
const answerBlock = src.slice(cacheStartAt, src.indexOf('const ANSWER_TAB_NAME$1 = "1";'));

function buildAnswerSandbox() {
  const calls = [];
  const sleeps = [];
  const config = {
    otherParams: { params: [{ name: '切换、答题间隔，单位秒', value: 3 }] },
    deepseek: { apiKey: 'sk-test', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com' }
  };
  // 可编排的 API 桩：按队列依次返回
  const queue = [];
  const sandbox = {
    console,
    Map,
    Promise,
    useConfigStore: () => config,
    sleep: (second) => {
      sleeps.push(second);
      return Promise.resolve();
    },
    md5: (text) => crypto.createHash('md5').update(String(text)).digest('hex'),
    callDeepseekAPI: async (apiKey, baseUrl, model, question) => {
      calls.push(question && question.title);
      const next = queue.shift();
      // 队列空时给兜底结果：旧版没有缓存，会多打一次 API，不能让测试直接崩掉
      if (!next) return { code: 200, data: { answer: ['B. 球体'], num: '0', usenum: '' }, msg: '' };
      return typeof next === 'function' ? next() : next;
    }
  };
  vm.createContext(sandbox);
  const handleErrorSrc = slice('const handleError = (msg, errorType = "unknown") => ({', 'const DEEPSEEK_SYSTEM_PROMPT');
  vm.runInContext(handleErrorSrc + '\n' + answerBlock + '\nglobalThis.__getAnswer = getAnswer;', sandbox);
  return { getAnswer: sandbox.__getAnswer, calls, sleeps, queue, config };
}

const okResult = (answers) => ({ code: 200, data: { answer: answers, num: '9', usenum: '1' }, msg: '' });
const rateLimit = () => ({ code: 10003, errorType: 'rate_limit', data: { answer: [] }, msg: '请求过于频繁，请稍后重试' });

// A1 同题第二次命中缓存，不再打 API
{
  const box = buildAnswerSandbox();
  const question = { title: '下列哪个是球体？', optionsText: ['A. 正方体', 'B. 球体'], type: '0' };
  box.queue.push(okResult(['B. 球体']));
  const first = await box.getAnswer(question);
  const second = await box.getAnswer(question);
  check('A1 首次请求实际调用了 API', box.calls.length === 1, 'calls=' + box.calls.length);
  check('A1 首次结果不带 cached 标记', first.data.cached === undefined);
  check('A1 同题第二次命中缓存', second.data.cached === true, 'cached=' + second.data.cached);
  check('A1 缓存命中后 API 调用次数不增加', box.calls.length === 1, 'calls=' + box.calls.length);
  check('A1 缓存返回的答案一致', JSON.stringify(second.data.answer) === JSON.stringify(['B. 球体']), JSON.stringify(second.data.answer));
  check('A1 缓存命中不额外等待答题间隔', box.sleeps.length === 1, 'sleeps=' + box.sleeps.length);
}

// A2 题干不同 → 不串缓存
{
  const box = buildAnswerSandbox();
  box.queue.push(okResult(['A']), okResult(['B']));
  await box.getAnswer({ title: '题目甲', optionsText: ['A', 'B'], type: '0' });
  const second = await box.getAnswer({ title: '题目乙', optionsText: ['A', 'B'], type: '0' });
  check('A2 题干不同不命中缓存', second.data.cached === undefined, 'cached=' + second.data.cached);
  check('A2 题干不同会重新请求', box.calls.length === 2, 'calls=' + box.calls.length);
}

// A3 选项不同 → 不串缓存
{
  const box = buildAnswerSandbox();
  box.queue.push(okResult(['A']), okResult(['A']));
  await box.getAnswer({ title: '同一题干', optionsText: ['A', 'B'], type: '0' });
  const second = await box.getAnswer({ title: '同一题干', optionsText: ['A', 'C'], type: '0' });
  check('A3 选项不同不命中缓存', second.data.cached === undefined, 'cached=' + second.data.cached);
}

// A4 失败结果不写缓存（否则一次网络抖动会把这个题永久钉成失败）
{
  const box = buildAnswerSandbox();
  box.queue.push({ code: 10003, errorType: 'unknown', data: { answer: [] }, msg: '网络请求失败' });
  box.queue.push(okResult(['B']));
  const failed = await box.getAnswer({ title: '会先失败的题', optionsText: ['A', 'B'], type: '0' });
  check('A4 第一次失败如实返回', failed.code !== 200, 'code=' + failed.code);
  const retry = await box.getAnswer({ title: '会先失败的题', optionsText: ['A', 'B'], type: '0' });
  check('A4 失败不写缓存，重试能拿到答案', retry.code === 200 && retry.data.cached === undefined,
    'code=' + retry.code + ' cached=' + retry.data.cached);
}

// A5 429 退避：2s → 6s，两次后放弃
{
  const box = buildAnswerSandbox();
  box.queue.push(rateLimit(), rateLimit(), rateLimit());
  const result = await box.getAnswer({ title: '一直限流的题', optionsText: ['A', 'B'], type: '0' });
  check('A5 429 一共请求 3 次（1 次 + 2 次重试）', box.calls.length === 3, 'calls=' + box.calls.length);
  check('A5 退避间隔递增 2s → 6s', JSON.stringify(box.sleeps) === JSON.stringify([3, 2, 6]), JSON.stringify(box.sleeps));
  check('A5 重试耗尽后如实返回限流错误', result.code === 10003 && result.errorType === 'rate_limit', result.msg);
}

// A6 429 后重试成功：结果正常返回并写缓存
{
  const box = buildAnswerSandbox();
  box.queue.push(rateLimit(), okResult(['C']));
  const result = await box.getAnswer({ title: '限流后成功的题', optionsText: ['A', 'B', 'C'], type: '0' });
  check('A6 429 重试成功返回 200', result.code === 200, 'code=' + result.code);
  check('A6 只重试一次就成功', box.calls.length === 2, 'calls=' + box.calls.length);
  const cached = await box.getAnswer({ title: '限流后成功的题', optionsText: ['A', 'B', 'C'], type: '0' });
  check('A6 成功结果已写缓存', cached.data.cached === true, 'cached=' + cached.data.cached);
}

// A7 非限流错误不做退避重试
{
  const box = buildAnswerSandbox();
  box.queue.push({ code: 10003, errorType: 'auth', data: { answer: [] }, msg: 'API Key 无效，请检查' });
  const result = await box.getAnswer({ title: '鉴权失败的题', optionsText: ['A', 'B'], type: '0' });
  check('A7 非 429 不重试', box.calls.length === 1, 'calls=' + box.calls.length);
  check('A7 非 429 不产生退避等待', JSON.stringify(box.sleeps) === JSON.stringify([3]), JSON.stringify(box.sleeps));
  check('A7 错误信息透传', result.msg === 'API Key 无效，请检查', result.msg);
}

// A8 没填 API Key 直接返回，不排队不等待
{
  const box = buildAnswerSandbox();
  box.config.deepseek.apiKey = '';
  const result = await box.getAnswer({ title: '任意题', optionsText: ['A'], type: '0' });
  check('A8 缺 Key 直接报错', result.code === 10003 && result.msg.indexOf('API Key') >= 0, result.msg);
  check('A8 缺 Key 不消耗答题间隔', box.sleeps.length === 0, 'sleeps=' + box.sleeps.length);
  check('A8 缺 Key 不打 API', box.calls.length === 0, 'calls=' + box.calls.length);
}

// ============ B. CxQuestionHandler.init 的返回值语义 ============
const handlerBlock = slice('class BaseQuestionHandler {', 'class ZhsQuestionHandler extends BaseQuestionHandler');

// 打包器注入的辅助函数，抽出来的 class 代码依赖它们
const LOG_LINK_CONST = (src.match(/const LOG_LINK_HTML = '[^']*';/) || [''])[0];
const PRELUDE = `
var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => { __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value); return value; };
${LOG_LINK_CONST}
`;

function buildHandlerSandbox(answerMap) {
  const logs = [];
  const sandbox = {
    console,
    Set,
    Map,
    Promise,
    Math,
    JSON,
    String,
    Number,
    Array,
    Object,
    document: { querySelector: () => null, querySelectorAll: () => [] },
    _unsafeWindow: { location: { href: 'https://mooc1.chaoxing.com/' } },
    useLogStore: () => ({ addLog: () => {}, logList: [], clearLog: () => {} }),
    useQuestionStore: () => ({ addQuestion: () => {}, clearQuestion: () => {} }),
    getAnswer: async (question) => answerMap(question)
  };
  vm.createContext(sandbox);
  vm.runInContext(PRELUDE + handlerBlock + '\nglobalThis.__CxQuestionHandler = CxQuestionHandler;', sandbox);
  return { CxQuestionHandler: sandbox.__CxQuestionHandler, logs };
}

function makeHandler(box, questions, answerMap) {
  const handler = new box.CxQuestionHandler('zj', {});
  // init() 第一句就是 this.questions = []，所以题目必须在 parseHtml 阶段注入
  handler.parseHtml = () => {
    handler.questions = questions.map((item) => Object.assign({ answer: [] }, item));
  };
  handler.fillQuestion = () => {
    handler.filled = (handler.filled || 0) + 1;
  };
  handler.addLog = () => {};
  handler.addQuestion = () => {};
  return handler;
}

// B1 全部答出来：覆盖率 100%
{
  const box = buildHandlerSandbox((q) => okResult(['A']));
  const handler = makeHandler(box, [
    { title: '题1', optionsText: ['A', 'B'], options: {}, answer: [] },
    { title: '题2', optionsText: ['A', 'B'], options: {}, answer: [] }
  ]);
  const stat = await handler.init();
  check('B1 返回结构化统计而不是裸数字', typeof stat === 'object' && stat !== null, typeof stat);
  check('B1 total 正确', stat.total === 2, 'total=' + stat.total);
  check('B1 answered 正确', stat.answered === 2, 'answered=' + stat.answered);
  check('B1 全部答出时 rate=100', stat.rate === 100, 'rate=' + stat.rate);
}

// B2 部分答不出来：rate 反映的是覆盖率，不是正确率
{
  let index = 0;
  const box = buildHandlerSandbox(() => {
    index += 1;
    return index === 2 ? { code: 10003, data: { answer: [] }, msg: '网络请求失败' } : okResult(['A']);
  });
  const handler = makeHandler(box, [
    { title: '题1', optionsText: ['A', 'B'], options: {}, answer: [] },
    { title: '题2', optionsText: ['A', 'B'], options: {}, answer: [] },
    { title: '题3', optionsText: ['A', 'B'], options: {}, answer: [] }
  ]);
  const stat = await handler.init();
  check('B2 三题里两题答出 → answered=2', stat.answered === 2, 'answered=' + stat.answered);
  check('B2 rate 约等于 66.67', Math.abs(stat.rate - 200 / 3) < 0.01, 'rate=' + stat.rate);
  check('B2 失败题不会算进 answered', stat.answered !== stat.total);
}

// B3 一题都没解析到：total=0 且 rate=0（不能 NaN）
{
  const box = buildHandlerSandbox(() => okResult(['A']));
  const handler = makeHandler(box, []);
  const stat = await handler.init();
  check('B3 无题目时 total=0', stat.total === 0, 'total=' + stat.total);
  check('B3 无题目时 rate=0 而不是 NaN', stat.rate === 0 && Number.isFinite(stat.rate), 'rate=' + stat.rate);
}

// B4 全部失败：rate=0，调用方会拦住自动提交
{
  const box = buildHandlerSandbox(() => ({ code: 10003, data: { answer: [] }, msg: 'API 余额不足' }));
  const handler = makeHandler(box, [
    { title: '题1', optionsText: ['A', 'B'], options: {}, answer: [] },
    { title: '题2', optionsText: ['A', 'B'], options: {}, answer: [] }
  ]);
  const stat = await handler.init();
  check('B4 全失败时 answered=0', stat.answered === 0, 'answered=' + stat.answered);
  check('B4 全失败时 rate=0（会被阈值拦下）', stat.rate === 0, 'rate=' + stat.rate);
}

let failed = 0;
for (const item of results) {
  if (!item.ok) failed += 1;
  console.log((item.ok ? '  PASS  ' : '  FAIL  ') + item.name + (item.extra ? '  [' + item.extra + ']' : ''));
}
console.log('\n共 ' + results.length + ' 项，失败 ' + failed + ' 项');
process.exit(failed ? 1 : 0);

})();
