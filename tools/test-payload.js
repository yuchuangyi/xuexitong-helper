const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DIR = 'C:\\Users\\wangn\\WorkBuddy\\2026-09-11-10-00-35';
const SCRIPT = path.join(DIR, fs.readdirSync(DIR).find((name) => name.endsWith('.user.js')));
const src = fs.readFileSync(SCRIPT, 'utf8');

const start = src.indexOf('const DEEPSEEK_SYSTEM_PROMPT');
const end = src.indexOf('const getAnswer = async');
if (start < 0 || end < 0) throw new Error('未能定位 DeepSeek 调用逻辑');
const apiCode = src.slice(start, end);

const results = [];
const check = (name, ok, extra) => results.push({ name, ok: !!ok, extra: extra === undefined ? '' : String(extra) });

const ctx = vm.createContext({
  capturedBodies: [],
  console
});
vm.runInContext(`
  var capturedBodies = [];
  var _GM_xmlhttpRequest = (options) => {
    capturedBodies.push({ url: options.url, headers: options.headers, body: JSON.parse(options.data) });
    options.onload({
      status: 200,
      responseText: JSON.stringify({
        choices: [{ message: { content: '{"answers":["B. 球体"],"analysis":"地球是球体"}' } }]
      })
    });
  };
  var globalThis_ = null;
  globalThis.__captured = capturedBodies;
`, ctx);
vm.runInContext(apiCode + '\nglobalThis.callDeepseekAPI = callDeepseekAPI;\nglobalThis.DEEPSEEK_SYSTEM_PROMPT = DEEPSEEK_SYSTEM_PROMPT;', ctx);

const question = {
  type: '单选题',
  title: '地球的形状是（ ）',
  optionsText: ['方的', '球体', '三角形'],
  options: {},
  answer: []
};

(async () => {
  const res = await ctx.callDeepseekAPI('sk-test', 'https://api.deepseek.com', 'deepseek-flash', question);
  const captured = vm.runInContext('__captured', ctx);
  const body = captured[0] && captured[0].body;
  const url = captured[0] && captured[0].url;

  check('请求地址正确', url === 'https://api.deepseek.com/v1/chat/completions', url);
  check('请求携带 Authorization', captured[0] && captured[0].headers.Authorization === 'Bearer sk-test');
  check('model 使用 V4.1（deepseek-flash）', body && body.model === 'deepseek-flash', body && body.model);
  check('已关闭思考模式 thinking.type=disabled', body && body.thinking && body.thinking.type === 'disabled', JSON.stringify(body && body.thinking));
  check('保留 JSON Output', body && body.response_format && body.response_format.type === 'json_object');
  check('temperature 保留（非思考模式生效）', body && body.temperature === 0.1, body && body.temperature);
  check('max_tokens 保留', body && body.max_tokens === 2048);
  check('system 提示词包含 json 关键字（JSON Output 前提）', /json/i.test(vm.runInContext('DEEPSEEK_SYSTEM_PROMPT', ctx)));
  check('user 提示词包含题干与选项', body && /地球的形状是/.test(body.messages[1].content) && /球体/.test(body.messages[1].content));
  check('响应解析正确', res.code === 200 && res.data.answer[0] === 'B. 球体', JSON.stringify(res.data && res.data.answer));

  // 脚本默认配置里的模型必须是 V4.1
  check('默认配置 model 已改为 deepseek-flash', /model:\s*"deepseek-flash"/.test(src));
  check('默认配置已无 deepseek-chat', !/model:\s*"deepseek-chat"/.test(src));

  let failed = 0;
  for (const item of results) {
    if (!item.ok) failed += 1;
    console.log((item.ok ? '  PASS  ' : '  FAIL  ') + item.name + (item.extra ? '  [' + item.extra + ']' : ''));
  }
  console.log('\n共 ' + results.length + ' 项，失败 ' + failed + ' 项');
  process.exit(failed ? 1 : 0);
})();
