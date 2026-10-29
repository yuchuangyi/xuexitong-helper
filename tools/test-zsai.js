const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const ROOT = 'C:\\Users\\wangn\\WorkBuddy\\2026-09-11-10-00-35';
const SCRIPT = path.join(ROOT, fs.readdirSync(ROOT).find((name) => name.endsWith('.user.js')));
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

const results = [];
function check(name, ok, extra) {
  results.push({ name, ok: !!ok, extra: extra === undefined ? '' : String(extra) });
}

const prelude = `
var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => { __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value); return value; };
var logs = [];
var answeredQuestions = [];
var _unsafeWindow = window;
var sleep = (second) => new Promise((resolve) => setTimeout(resolve, second * 20));
var hookError = () => {};
var useLogStore = () => ({ addLog: (message, type) => logs.push([type, message]) });
var useQuestionStore = () => ({ questionList: [], addQuestion: (q) => answeredQuestions.push(q), clearQuestion: () => {} });
var useConfigStore = () => ({
  otherParams: { params: [{ name: "答案相似度超过多少选择", value: 85 }] },
  deepseek: { apiKey: "sk-test" },
  platformParams: {
    zhsAi: {
      parts: [
        { params: [{ value: true }, { value: true }, { value: 1 }] },
        { params: [{ value: true }, { value: true }] }
      ]
    }
  }
});
var getAnswer = async (question) => {
  window.__lastAsked = question;
  return window.__cannedAnswer;
};
`;

const cases = {
  single: {
    html: `
      <div class="questionContent">
        <div class="questionTitle"><span class="letterSortNum">1</span>（单选题）地球的形状是（ ）</div>
        <div class="centent-pre"><div class="preStyle">地球的形状是（ ）</div></div>
        <div class="el-radio-group">
          <label class="el-radio"><span class="el-radio__input"><input type="radio" class="el-radio__original" name="q1"></span><span class="letterSort">A</span><span class="el-radio__label">方的</span></label>
          <label class="el-radio"><span class="el-radio__input"><input type="radio" class="el-radio__original" name="q1"></span><span class="letterSort">B</span><span class="el-radio__label">球体</span></label>
          <label class="el-radio"><span class="el-radio__input"><input type="radio" class="el-radio__original" name="q1"></span><span class="letterSort">C</span><span class="el-radio__label">三角形</span></label>
          <label class="el-radio"><span class="el-radio__input"><input type="radio" class="el-radio__original" name="q1"></span><span class="letterSort">D</span><span class="el-radio__label">不规则的三角形</span></label>
        </div>
      </div>`,
    answer: { code: 200, data: { answer: ['B. 球体'] } },
    expect: (doc) => {
      const labels = Array.from(doc.querySelectorAll('label.el-radio'));
      const checkedIndex = labels.findIndex((l) => l.querySelector('input').checked);
      return { ok: checkedIndex === 1, extra: 'checkedIndex=' + checkedIndex };
    }
  },
  multi: {
    html: `
      <div class="questionContent">
        <div class="questionTitle"><span class="letterSortNum">2</span>（多选题）下列属于水果的有</div>
        <div class="centent-pre"><div class="preStyle">下列属于水果的有</div></div>
        <div class="el-checkbox-group">
          <label class="el-checkbox"><span class="el-checkbox__input"><input type="checkbox" class="el-checkbox__original" name="q2"></span><span class="letterSort">A</span><span class="el-checkbox__label">苹果</span></label>
          <label class="el-checkbox"><span class="el-checkbox__input"><input type="checkbox" class="el-checkbox__original" name="q2"></span><span class="letterSort">B</span><span class="el-checkbox__label">白菜</span></label>
          <label class="el-checkbox"><span class="el-checkbox__input"><input type="checkbox" class="el-checkbox__original" name="q2"></span><span class="letterSort">C</span><span class="el-checkbox__label">香蕉</span></label>
        </div>
      </div>`,
    answer: { code: 200, data: { answer: ['苹果', '香蕉'] } },
    expect: (doc) => {
      const labels = Array.from(doc.querySelectorAll('label.el-checkbox'));
      const checked = labels.map((l, i) => (l.querySelector('input').checked ? i : -1)).filter((i) => i >= 0);
      return { ok: checked.length === 2 && checked[0] === 0 && checked[1] === 2, extra: 'checked=' + JSON.stringify(checked) };
    }
  },
  judge: {
    html: `
      <div class="questionContent">
        <div class="questionTitle"><span class="letterSortNum">3</span>（判断题）水在标准大气压下100摄氏度沸腾</div>
        <div class="centent-pre"><div class="preStyle">水在标准大气压下100摄氏度沸腾</div></div>
        <div class="el-radio-group">
          <label class="el-radio"><span class="el-radio__input"><input type="radio" class="el-radio__original" name="q3"></span><span class="letterSort">A</span><span class="el-radio__label">正确</span></label>
          <label class="el-radio"><span class="el-radio__input"><input type="radio" class="el-radio__original" name="q3"></span><span class="letterSort">B</span><span class="el-radio__label">错误</span></label>
        </div>
      </div>`,
    answer: { code: 200, data: { answer: ['true'] } },
    expect: (doc) => {
      const labels = Array.from(doc.querySelectorAll('label.el-radio'));
      const checkedIndex = labels.findIndex((l) => l.querySelector('input').checked);
      return { ok: checkedIndex === 0, extra: 'checkedIndex=' + checkedIndex };
    }
  },
  judgeFallback: {
    html: `
      <div class="questionContent">
        <div class="questionTitle"><span class="letterSortNum">4</span>地球是太阳系中最大的行星</div>
        <div class="centent-pre"><div class="preStyle">地球是太阳系中最大的行星</div></div>
        <div class="el-radio-group">
          <label class="el-radio"><span class="el-radio__input"><input type="radio" class="el-radio__original" name="q4"></span><span class="letterSort">A</span><span class="el-radio__label">正确</span></label>
          <label class="el-radio"><span class="el-radio__input"><input type="radio" class="el-radio__original" name="q4"></span><span class="letterSort">B</span><span class="el-radio__label">错误</span></label>
        </div>
      </div>`,
    answer: { code: 200, data: { answer: ['false'] } },
    expect: (doc) => {
      const labels = Array.from(doc.querySelectorAll('label.el-radio'));
      const checkedIndex = labels.findIndex((l) => l.querySelector('input').checked);
      return { ok: checkedIndex === 1, extra: 'checkedIndex=' + checkedIndex };
    }
  },
  blank: {
    html: `
      <div class="questionContent">
        <div class="questionTitle"><span class="letterSortNum">5</span>（填空题）植物的光合作用产生____</div>
        <div class="centent-pre"><div class="preStyle">植物的光合作用产生____</div></div>
        <div class="blank-area"><input type="text" name="blank1" class="el-input__inner"></div>
      </div>`,
    answer: { code: 200, data: { answer: ['氧气'] } },
    expect: (doc) => {
      const input = doc.querySelector('.questionContent input[type="text"]');
      return { ok: input && input.value === '氧气', extra: 'value=' + (input ? input.value : 'null') };
    }
  }
};

async function runCase(key) {
  const item = cases[key];
  const dom = new JSDOM('<!doctype html><html><body>' + item.html + '</body></html>', {
    pretendToBeVisual: true,
    runScripts: 'outside-only'
  });
  const { window } = dom;
  // jsdom 不实现布局，这里补上可见性判定所需的最小实现
  window.Element.prototype.getClientRects = function () {
    const style = window.getComputedStyle(this);
    if (style.display === 'none' || style.visibility === 'hidden') return [];
    return [{ width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10 }];
  };
  window.__cannedAnswer = item.answer;

  const ctx = dom.getInternalVMContext();
  const source = prelude + '\n' + baseClass + '\n' + zsAiBlock + '\n' +
    'globalThis.__ZsAiQuestionHandler = ZhsAiQuestionHandler;';
  vm.runInContext(source, ctx, { filename: 'zsai-extract.js' });

  const Handler = window.__ZsAiQuestionHandler;
  const handler = new Handler();
  const collected = handler.collect();
  if (!collected) {
    check(key + ' · 识别题目', false, 'collect() 返回 null');
    window.close();
    return;
  }
  check(key + ' · 识别题目', true, 'type=' + collected.snapshot.type + ' options=' + collected.snapshot.options.length);
  check(key + ' · 识别题型', collected.snapshot.type === item.expectedType, '实际=' + collected.snapshot.type);
  const picked = handler.applyAnswer(collected.snapshot, item.answer.data.answer);
  check(key + ' · 填充执行', picked.length > 0, 'picked=' + JSON.stringify(picked));
  const res = item.expect(window.document);
  check(key + ' · 结果校验', res.ok, res.extra);
  window.close();
}

(async () => {
  cases.single.expectedType = '单选题';
  cases.multi.expectedType = '多选题';
  cases.judge.expectedType = '判断题';
  cases.judgeFallback.expectedType = '判断题';
  cases.blank.expectedType = '填空题';

  for (const key of Object.keys(cases)) {
    try {
      await runCase(key);
    } catch (error) {
      check(key + ' · 执行', false, error.message);
    }
  }

  let failed = 0;
  for (const item of results) {
    if (!item.ok) failed += 1;
    console.log((item.ok ? '  PASS  ' : '  FAIL  ') + item.name + (item.extra ? '  [' + item.extra + ']' : ''));
  }
  console.log('\n共 ' + results.length + ' 项，失败 ' + failed + ' 项');
  process.exit(failed ? 1 : 0);
})();
