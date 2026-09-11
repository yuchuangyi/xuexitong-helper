const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DIR = 'C:\\Users\\wangn\\WorkBuddy\\2026-09-11-10-00-35';
const SCRIPT = path.join(DIR, fs.readdirSync(DIR).find((name) => name.endsWith('.user.js')));
const src = fs.readFileSync(SCRIPT, 'utf8');

const start = src.indexOf('const isPlainObject = (value) => {');
const end = src.indexOf('const getLocalStorageConfig = () => {');
if (start < 0 || end < 0) throw new Error('未能定位配置合并逻辑');
const mergeCode = src.slice(start, end);

const results = [];
const check = (name, ok, extra) => results.push({ name, ok: !!ok, extra: extra === undefined ? '' : String(extra) });

const ctx = vm.createContext({});
vm.runInContext(mergeCode + '\nglobalThis.migrateConfig = migrateConfig;', ctx);

const SCRIPT_VERSION = (src.match(/^\/\/ @version\s+(\S+)/m) || [])[1] || '0.0.0';

const defaultConfig = {
  version: SCRIPT_VERSION,
  platformName: 'cx',
  platformParams: {
    cx: { name: '超星网课助手', parts: [{ name: '章节设置', params: [{ name: '章节作业自动提交', value: true, type: 'boolean' }] }] },
    zhs: { name: '智慧树网课助手', parts: [{ name: '答题设置', params: [{ name: '是否自动切换', value: true, type: 'boolean' }] }] },
    zhsAi: {
      name: '智慧树AI课程助手',
      parts: [
        { name: '学习设置', params: [{ name: '自动播放并静音视频', value: true, type: 'boolean' }, { name: '学完自动下一个任务点', value: true, type: 'boolean' }, { name: '视频倍速', value: 1, type: 'number' }] },
        { name: '答题设置', params: [{ name: '是否自动答题', value: true, type: 'boolean' }, { name: '答完自动提交/切题', value: true, type: 'boolean' }] }
      ]
    }
  },
  otherParams: { name: '其他参数', params: [{ name: '切换、答题间隔，单位秒', value: 3, type: 'number' }] }
};

// 模拟一个 0.2.4 老用户已保存的配置：没有 zhsAi，且关掉了智慧树的自动切换
const stored = {
  version: '0.2.4',
  platformName: 'zhs',
  platformParams: {
    cx: { name: '超星网课助手', parts: [{ name: '章节设置', params: [{ name: '章节作业自动提交', value: false, type: 'boolean' }] }] },
    zhs: { name: '智慧树网课助手', parts: [{ name: '答题设置', params: [{ name: '是否自动切换', value: false, type: 'boolean' }] }] }
  },
  otherParams: { name: '其他参数', params: [{ name: '切换、答题间隔，单位秒', value: 8, type: 'number' }] }
};

const merged = ctx.migrateConfig(stored, defaultConfig);

check('新增 zhsAi 平台配置已注入', !!merged.platformParams.zhsAi, merged.platformParams.zhsAi && merged.platformParams.zhsAi.name);
check('zhsAi 答题设置参数完整', (merged.platformParams.zhsAi.parts[1].params || []).length === 2);
check('zhsAi 视频倍速默认值保留', merged.platformParams.zhsAi.parts[0].params[2].value === 1);
check('老用户 zhs 设置未被覆盖', merged.platformParams.zhs.parts[0].params[0].value === false, 'value=' + merged.platformParams.zhs.parts[0].params[0].value);
check('老用户 cx 设置未被覆盖', merged.platformParams.cx.parts[0].params[0].value === false);
check('老用户全局间隔未被覆盖', merged.otherParams.params[0].value === 8, 'value=' + merged.otherParams.params[0].value);
check('version 已升级到默认版本', merged.version === SCRIPT_VERSION, merged.version);

// 用户已对新平台做过设置时，应该尊重用户值
const stored2 = JSON.parse(JSON.stringify(stored));
stored2.platformParams.zhsAi = { name: '智慧树AI课程助手', parts: [{ name: '学习设置', params: [{ name: '自动播放并静音视频', value: false, type: 'boolean' }, { name: '学完自动下一个任务点', value: true, type: 'boolean' }, { name: '视频倍速', value: 2, type: 'number' }] }] };
const merged2 = ctx.migrateConfig(stored2, defaultConfig);
check('用户改过的视频倍速被保留', merged2.platformParams.zhsAi.parts[0].params[2].value === 2, 'value=' + merged2.platformParams.zhsAi.parts[0].params[2].value);
check('用户关掉的自动播放被保留', merged2.platformParams.zhsAi.parts[0].params[0].value === false);
check('用户未设置的答题设置补默认值', merged2.platformParams.zhsAi.parts[1].params[0].value === true);

// ---- DeepSeek 模型升级（0.2.6：deepseek-chat → deepseek-flash） ----
const cfgWithModel = JSON.parse(JSON.stringify(defaultConfig));
cfgWithModel.deepseek = { apiKey: 'sk-user', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com' };

const legacyModels = ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-flash', 'deepseek-v4.1', 'deepseek-v4-pro'];
for (const legacy of legacyModels) {
  const storedModel = JSON.parse(JSON.stringify(stored));
  storedModel.deepseek = { apiKey: 'sk-user', model: legacy, baseUrl: 'https://api.deepseek.com' };
  const out = ctx.migrateConfig(storedModel, cfgWithModel);
  check('旧模型 ' + legacy + ' 升级为 deepseek-flash', out.deepseek.model === 'deepseek-flash', 'model=' + out.deepseek.model);
  check('旧模型 ' + legacy + ' 升级后 API Key 保留', out.deepseek.apiKey === 'sk-user');
}

const customModel = JSON.parse(JSON.stringify(stored));
customModel.deepseek = { apiKey: 'sk-user', model: 'my-custom-model', baseUrl: 'https://my-proxy.local' };
const outCustom = ctx.migrateConfig(customModel, cfgWithModel);
check('自定义模型不被覆盖', outCustom.deepseek.model === 'my-custom-model', 'model=' + outCustom.deepseek.model);
check('自定义 baseUrl 不被覆盖', outCustom.deepseek.baseUrl === 'https://my-proxy.local');

const freshUser = ctx.migrateConfig({ version: '0.2.4' }, cfgWithModel);
check('全新用户拿到 deepseek-flash 默认值', freshUser.deepseek.model === 'deepseek-flash', 'model=' + freshUser.deepseek.model);

let failed = 0;
for (const item of results) {
  if (!item.ok) failed += 1;
  console.log((item.ok ? '  PASS  ' : '  FAIL  ') + item.name + (item.extra ? '  [' + item.extra + ']' : ''));
}
console.log('\n共 ' + results.length + ' 项，失败 ' + failed + ' 项');
process.exit(failed ? 1 : 0);
