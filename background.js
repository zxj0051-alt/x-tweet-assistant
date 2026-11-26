// background.js — Service Worker
// 职责：接收 content script 的生成请求，按设置的 AI 提供商调用后端，把结果返回。
// 提供商：worker（你自己的 Cloudflare Worker 免费 AI）、gemini（Google AI Studio 免费 Key 直连）、claude（Anthropic Key 直连）、
// glm（智谱 GLM-4-Flash，国内永久免费）、siliconflow（硅基流动，国内免费模型）。
// 放在 background 里调接口，可以绕开 content script 直接 fetch 会遇到的 CORS 限制
// （manifest 里给各接口域名加了 host_permissions）。
// 注意：本文件不自动发帖、不做任何 X 操作，只做 AI 接口调用。

// 默认设置（与 options.js 保持一致；用户在设置页改过后以 chrome.storage.sync 为准）
const DEFAULT_SETTINGS = {
  provider: 'glm', // glm | siliconflow | gemini | claude
  geminiKey: '',
  geminiModel: 'gemini-3.8-flash',
  claudeKey: '',
  claudeModel: 'claude-haiku-4-5',
  glmKey: '',
  glmModel: 'glm-4-flash',
  siliconKey: '',
  siliconModel: 'Qwen/Qwen3-8B',
  count: 3,
  domain: '',
  style: '自然口语',
};

// 从 chrome.storage.sync 读设置，缺失的字段用默认值补齐
function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(DEFAULT_SETTINGS, (items) => resolve(items));
  });
}

// 三种回复风格：默认一次生成 3 条时，每条用一种不同风格，方便用户挑。
const ALL_STYLES = ['自然口语', '专业干货', '幽默'];

// 按条数分配风格：1 条用所选风格；多条时从所选风格开始轮换，保证每条风格不同。
function pickStyles(selected, count) {
  if (count <= 1) return [selected || ALL_STYLES[0]];
  const start = ALL_STYLES.indexOf(selected);
  const base = start >= 0 ? start : 0;
  const out = [];
  for (let i = 0; i < count; i++) out.push(ALL_STYLES[(base + i) % ALL_STYLES.length]);
  return out;
}

function styleHintFor(style) {
  return style === '专业干货' ? '专业、有干货、条理清晰' : style === '幽默' ? '幽默风趣、带点调侃' : '自然口语、像真人聊天';
}

// 解析 AI 返回的草稿：先试标准 JSON，再修复模型常犯的格式错误。
// 模型常把 {"drafts":["草稿1":"...","草稿2":"..."]} 写成数组里套键值对（非法 JSON），
// 或写成 {"草稿1":"...","草稿2":"..."} 对象——这两种都要能取出来，别原样显示。
function parseDrafts(raw, count) {
  // 去掉草稿开头的编号/标签（如“草稿1：”“1.”），只留正文
  const clean = (s) => String(s).trim().replace(/^(草稿\s*\d+|第\s*\d+\s*条|\(\s*\d+\s*\)|\d+\s*[.、）])\s*[:：]?\s*/, '').trim();
  const m = raw.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (m) {
    try {
      const parsed = JSON.parse(m[0]);
      const arr = Array.isArray(parsed) ? parsed : parsed.drafts;
      if (Array.isArray(arr)) {
        const out = arr.map(clean).filter(Boolean);
        if (out.length) return out.slice(0, count);
      }
      // {"草稿1":"...","草稿2":"..."} 这种对象形式：取它的值
      if (parsed && typeof parsed === 'object') {
        const vals = Object.values(parsed).flatMap((v) => (Array.isArray(v) ? v : [v])).map(clean).filter(Boolean);
        if (vals.length) return vals.slice(0, count);
      }
    } catch { /* 继续走修复提取 */ }
  }
  // 修复：提取 "xxx":"yyy" 键值对里的值（数组里套键值对的非法 JSON 就靠这步）
  const kv = [...raw.matchAll(/"[^"\n]*"\s*:\s*"((?:[^"\\]|\\.)*)"/g)]
    .map((x) => clean(x[1].replace(/\\"/g, '"').replace(/\\n/g, '\n')))
    .filter(Boolean);
  if (kv.length) return kv.slice(0, count);
  // 提取所有双引号字符串（去掉“drafts”“草稿1”这类键名本身）
  const quoted = [...raw.matchAll(/"((?:[^"\\]|\\.)*)"/g)]
    .map((x) => clean(x[1].replace(/\\"/g, '"')))
    .filter((s) => s.length > 1 && !/^草稿\s*\d+$/.test(s) && s !== 'drafts');
  if (quoted.length) return quoted.slice(0, count);
  // 最后按行拆
  return raw.split(/\n+/).map((l) => clean(l)).filter((l) => l.length > 1).slice(0, count);
}

// 按任务与设置拼提示词（与 Worker 端的文案口径一致；领域为空 = 自由发挥）。
// 返回 { sys, user, styles }：styles 是每条草稿用的风格名，供面板给每条打标签。
// reply：payload.style 有值时（单条重新生成）只用那一种；否则按条数分配不同风格。
// trending：payload.style 有值时（面板里选的风格）优先用它，否则用设置页的风格。
function buildPrompts(task, payload, settings, count) {
  const domain = (settings.domain || '').trim();
  const persona = domain ? `${domain}领域` : 'X';
  if (task === 'reply') {
    const t = payload.tweet || {};
    const text = String(t.text || '').slice(0, 1000);
    const styles = payload.style ? [payload.style] : pickStyles((settings.style || '').trim(), count || 3);
    const styleList = styles.map((s, i) => `第${i + 1}条用${styleHintFor(s)}风格`).join('，');
    const sys = `你是${persona}的 X 账号运营助手。给下面这条推文写回复草稿：中文，不要像广告；可以共鸣、提问、补充一个小观点；不要生硬推销、不要算命断言、不要迷信口吻。每条 30-120 字。${styleList}。只输出 JSON，格式示例：{"drafts":["这是第一条草稿的全文","这是第二条草稿的全文","这是第三条草稿的全文"]}。不要加任何其他文字，不要给草稿编号，不要用"草稿1"这样的键名。`;
    const user = `作者：${t.author || ''} ${t.handle || ''}\n推文：\n${text}`;
    return { sys, user, styles };
  }
  // trending
  const topics = Array.isArray(payload.topics) ? payload.topics.map(String).slice(0, 10) : [];
  const tweets = Array.isArray(payload.tweets) ? payload.tweets.slice(0, 5).map((x) => String((x && x.text) || '').slice(0, 300)) : [];
  const styleRaw = (payload.style || settings.style || '').trim();
  const styleHint = styleHintFor(styleRaw);
  const angle = domain ? `可以结合${domain}的角度，也可以就事论事自由发挥。` : '就事论事自由发挥，写得有趣、有观点，不必往特定方向靠。';
  const sys = `你是${persona}的 X 账号运营助手。根据下面 X 上的热门话题和热门推文，写新的发帖文案：中文、${styleHint}、有钩子（开头一句抓人）。${angle}不要生硬推销、不要算命断言、不要迷信口吻。每条 60-180 字。只输出 JSON，格式示例：{"drafts":["这是第一条文案的全文","这是第二条文案的全文","这是第三条文案的全文"]}。不要加任何其他文字，不要给文案编号，不要用"文案1"这样的键名。`;
  const user = `热门话题：${topics.join('；') || '无'}\n热门推文：\n${tweets.map((x, i) => `${i + 1}. ${x}`).join('\n') || '无'}`;
  return { sys, user, styles: [styleRaw || ALL_STYLES[0]] };
}

// 带超时的 fetch（超时后 AbortController 取消请求）
function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// Gemini 直连（Google AI Studio 免费 Key）
async function callGemini(task, payload, settings, count) {
  if (!settings.geminiKey) return { ok: false, error: '请先在设置里填 Gemini API Key（Google AI Studio 免费领取）' };
  const { sys, user, styles } = buildPrompts(task, payload, settings, count);
  let model = (settings.geminiModel || 'gemini-3.8-flash').trim();
  // 旧版默认模型 gemini-2.5-flash 已下线（新用户不可用），已存的旧值自动改用新模型
  if (model === 'gemini-2.5-flash') model = 'gemini-3.8-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(settings.geminiKey)}`;
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: sys }] },
      contents: [{ parts: [{ text: user }] }],
      generationConfig: { maxOutputTokens: 700, temperature: 0.9 },
    }),
  }, 60000);
  const data = await res.json().catch(() => null);
  if (data && data.error) return { ok: false, error: `Gemini 报错：${data.error.message || '未知错误'}` };
  if (!res.ok || !data) return { ok: false, error: 'Gemini 请求失败，请检查 Key 与网络，稍后再试' };
  const text = (data.candidates && data.candidates[0] && data.candidates[0].content && Array.isArray(data.candidates[0].content.parts))
    ? data.candidates[0].content.parts.map((p) => p.text || '').join('') : '';
  const drafts = parseDrafts(text, count);
  if (!drafts.length) return { ok: false, error: 'Gemini 未返回可用文案，请稍后再试' };
  return { ok: true, results: drafts, model, styles };
}

// Claude 直连（Anthropic）
async function callClaude(task, payload, settings, count) {
  if (!settings.claudeKey) return { ok: false, error: '请先在设置里填 Claude API Key（console.anthropic.com）' };
  const { sys, user, styles } = buildPrompts(task, payload, settings, count);
  const model = (settings.claudeModel || 'claude-haiku-4-5').trim();
  const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': settings.claudeKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: 700,
      system: sys,
      messages: [{ role: 'user', content: user }],
    }),
  }, 60000);
  const data = await res.json().catch(() => null);
  if (data && data.error) return { ok: false, error: `Claude 报错：${data.error.message || '未知错误'}` };
  if (!res.ok || !data) return { ok: false, error: 'Claude 请求失败，请检查 Key 与网络，稍后再试' };
  const text = Array.isArray(data.content) ? data.content.map((c) => c.text || '').join('') : '';
  const drafts = parseDrafts(text, count);
  if (!drafts.length) return { ok: false, error: 'Claude 未返回可用文案，请稍后再试' };
  return { ok: true, results: drafts, model, styles };
}

// OpenAI 兼容接口通用调用（智谱 GLM、硅基流动等国内接口都用这个格式）
// config: { baseUrl, apiKey, model, label, keyHint }
async function callOpenAICompatible(task, payload, settings, count, config) {
  if (!config.apiKey) return { ok: false, error: `请先在设置里填 ${config.label} API Key（${config.keyHint}）` };
  const { sys, user, styles } = buildPrompts(task, payload, settings, count);
  const model = (config.model || '').trim();
  const res = await fetchWithTimeout(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
      max_tokens: 700,
      temperature: 0.9,
    }),
  }, 60000);
  const data = await res.json().catch(() => null);
  if (data && data.error) {
    const msg = typeof data.error === 'string' ? data.error : (data.error.message || '未知错误');
    return { ok: false, error: `${config.label} 报错：${msg}` };
  }
  if (!res.ok || !data) return { ok: false, error: `${config.label} 请求失败，请检查 Key 与网络，稍后再试` };
  const text = (data.choices && data.choices[0] && data.choices[0].message) ? String(data.choices[0].message.content || '') : '';
  const drafts = parseDrafts(text, count);
  if (!drafts.length) return { ok: false, error: `${config.label} 未返回可用文案，请稍后再试` };
  return { ok: true, results: drafts, model, styles };
}

// 智谱 GLM 直连（GLM-4-Flash 永久免费，每天 100 万 token；国内直接访问，不用代理）
async function callGlm(task, payload, settings, count) {
  return callOpenAICompatible(task, payload, settings, count, {
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: (settings.glmKey || '').trim(),
    model: settings.glmModel || 'glm-4-flash',
    label: '智谱 GLM',
    keyHint: 'open.bigmodel.cn 免费领取',
  });
}

// 硅基流动直连（Qwen3-8B 等模型免费；国内直接访问，不用代理）
async function callSiliconFlow(task, payload, settings, count) {
  return callOpenAICompatible(task, payload, settings, count, {
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiKey: (settings.siliconKey || '').trim(),
    model: settings.siliconModel || 'Qwen/Qwen3-8B',
    label: '硅基流动',
    keyHint: 'cloud.siliconflow.cn 免费领取',
  });
}

// 按提供商分发；网络不通、超时、后端未上线时统一给友好提示
async function callAi(task, payload, settings, countOverride) {
  const count = countOverride || settings.count;
  try {
    if (settings.provider === 'gemini') return await callGemini(task, payload, settings, count);
    if (settings.provider === 'claude') return await callClaude(task, payload, settings, count);
    if (settings.provider === 'glm') return await callGlm(task, payload, settings, count);
    if (settings.provider === 'siliconflow') return await callSiliconFlow(task, payload, settings, count);
    return await callGlm(task, payload, settings, count); // 默认智谱 GLM
  } catch (err) {
    return { ok: false, error: '后端未就绪/请求失败，请稍后再试' };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 生成文案：{ type: 'xAssistantGenerate', task: 'reply' | 'trending', payload: {...}, count?: number }
  if (message && message.type === 'xAssistantGenerate') {
    (async () => {
      const settings = await getSettings();
      const result = await callAi(message.task, message.payload || {}, settings, message.count);
      sendResponse(result);
    })();
    return true; // 异步回包
  }

  // 打开设置页：{ type: 'xAssistantOpenOptions' }
  if (message && message.type === 'xAssistantOpenOptions') {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
