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
  language: 'zh', // 默认出文语言：zh 中文 / en English（面板和设置页共用）
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

// 回复角度：3 条草稿按不同角度出（而不是只按风格分），方便用户挑。
const ALL_ANGLES = ['共鸣', '提问', '补充观点', '温和反驳'];
const ANGLE_EN = { '共鸣': 'Empathy', '提问': 'Question', '补充观点': 'Add a viewpoint', '温和反驳': 'Gentle rebuttal' };
const ANGLE_ZH = { 'Empathy': '共鸣', 'Question': '提问', 'Add a viewpoint': '补充观点', 'Gentle rebuttal': '温和反驳' };

// 开头钩子：热门文案第一句的抓人方式。
const ALL_HOOKS = ['悬念', '争议', '数据', '故事', '提问'];
const HOOK_EN = { '悬念': 'Suspense', '争议': 'Contrarian', '数据': 'Data', '故事': 'Story', '提问': 'Question' };

// 风格名中英互转（面板标签按当前语言显示；传回来的名字可能是中文也可能是英文）
const STYLE_EN = { '自然口语': 'Casual', '专业干货': 'Insightful', '幽默': 'Witty' };
const STYLE_ZH = { 'Casual': '自然口语', 'Insightful': '专业干货', 'Witty': '幽默' };
function normalizeStyle(s) {
  return STYLE_ZH[s] || s;
}

// 按条数分配角度：默认按顺序取前 N 个（3 条就是共鸣、提问、补充观点）。
function pickAngles(count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(ALL_ANGLES[i % ALL_ANGLES.length]);
  return out;
}

function styleHintFor(style, lang) {
  const s = normalizeStyle(style);
  if (lang === 'en') {
    return s === '专业干货' ? 'insightful, packed with value, well structured' : s === '幽默' ? 'witty with light teasing' : 'casual, like a real person chatting';
  }
  return s === '专业干货' ? '专业、有干货、条理清晰' : s === '幽默' ? '幽默风趣、带点调侃' : '自然口语、像真人聊天';
}

function angleHintFor(angle, lang) {
  const a = ANGLE_ZH[angle] || angle;
  if (lang === 'en') {
    return a === '提问' ? 'ask a good question that invites a reply' : a === '补充观点' ? 'add a small viewpoint they did not mention' : a === '温和反驳' ? 'offer a different view gently, without arguing' : 'start with empathy and echo what they said';
  }
  return a === '提问' ? '提一个能引发对方回答的好问题' : a === '补充观点' ? '补充一个对方没提到的小观点' : a === '温和反驳' ? '温和地提出不同看法，不抬杠' : '先共鸣、再顺着对方的话说';
}

function hookHintFor(hook, lang) {
  const h = hook || '悬念';
  if (lang === 'en') {
    return h === '争议' ? 'open with a contrarian take' : h === '数据' ? 'open with a striking number or data point' : h === '故事' ? 'open with a short story or scene' : h === '提问' ? 'open with a pointed question' : 'open with suspense that makes people want to keep reading';
  }
  return h === '争议' ? '开头抛出一个有争议的观点' : h === '数据' ? '开头用一个具体数字或数据抓人' : h === '故事' ? '开头讲一个小故事或场景' : h === '提问' ? '开头提一个直击人心的问题' : '开头留一个悬念，让人想往下看';
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
// payload 可带：language（'zh' | 'en'，默认取 settings.language）、humanFeel（真人感）、
// growthMode（涨粉模式）、hook（热门文案开头钩子）、thread（热门文案是否写成 thread）、
// angle（单条重新生成时指定角度）。
// 返回 { sys, user, styles, angles }：styles/angles 是每条草稿用的风格名/角度名（按当前语言），供面板打标签。
// reply：payload.style 有值时（单条重新生成）只用那一种；否则按条数分配不同风格；角度同理。
// trending：payload.style 有值时（面板里选的风格）优先用它，否则用设置页的风格。
function buildPrompts(task, payload, settings, count) {
  const domain = (settings.domain || '').trim();
  const lang = payload.language === 'en' || (payload.language !== 'zh' && settings.language === 'en') ? 'en' : 'zh';
  const persona = domain ? (lang === 'en' ? `${domain}` : `${domain}领域`) : 'X';
  const humanFeelText = payload.humanFeel
    ? (lang === 'en'
      ? 'Sound like a real person posting casually: colloquial, with filler words, varied sentence lengths, slightly imperfect — not too polished or AI-like. '
      : '语气要像真人随手发的：口语化、带语气词、句子长短不一、偶尔有点不完美，不要写得太工整、太像 AI。')
    : '';
  const growthText = payload.growthMode
    ? (lang === 'en'
      ? 'Goal is growth and engagement: ask questions, leave hooks, make readers want to reply and check out your profile. '
      : '目标是涨粉互动：多提问、多留钩子，让看到的人想回你、想点进你的主页看看。')
    : '';
  const displayStyle = (s) => (lang === 'en' ? (STYLE_EN[normalizeStyle(s)] || s) : normalizeStyle(s));
  const displayAngle = (a) => (lang === 'en' ? (ANGLE_EN[ANGLE_ZH[a] || a] || a) : (ANGLE_ZH[a] || a));

  if (task === 'reply') {
    const t = payload.tweet || {};
    const text = String(t.text || '').slice(0, 1000);
    const images = Array.isArray(t.images) ? t.images.filter(Boolean).slice(0, 2) : [];
    const styles = payload.style ? [normalizeStyle(payload.style)] : pickStyles(normalizeStyle(settings.style || ''), count || 3);
    const angles = payload.angle ? [(ANGLE_ZH[payload.angle] || payload.angle)] : pickAngles(count || 3);
    const perDraft = styles.map((s, i) => {
      const a = angles[i % angles.length];
      return lang === 'en'
        ? `Draft ${i + 1}: ${styleHintFor(s, 'en')} style, from the "${displayAngle(a)}" angle (${angleHintFor(a, 'en')})`
        : `第${i + 1}条用${styleHintFor(s)}风格，从「${a}」的角度写（${angleHintFor(a)}）`;
    }).join(lang === 'en' ? '; ' : '；');
    const visionText = images.length
      ? (lang === 'en'
        ? 'The tweet includes images — look at them first, then write replies based on the images together with the text; if there is almost no text, reply based on what is in the images. '
        : '推文配了图片，先看懂图片内容，再结合图片和文字写回复；如果推文几乎没有文字，就按图片内容回。')
      : '';
    const sys = lang === 'en'
      ? `You are the X account operator assistant for ${persona}. Write reply drafts for the tweet below: in English, don't sound like an ad; you can resonate, ask a question, or add a small viewpoint; don't hard-sell, don't make fortune-telling claims, don't use a superstitious tone. Each draft 30-120 words. ${perDraft}. ${visionText}${humanFeelText}${growthText}Output JSON only, example format: {"drafts":["full text of draft 1","full text of draft 2","full text of draft 3"]}. Don't add any other text, don't number the drafts, don't use keys like "draft1".`
      : `你是${persona}的 X 账号运营助手。给下面这条推文写回复草稿：中文，不要像广告；可以共鸣、提问、补充一个小观点；不要生硬推销、不要算命断言、不要迷信口吻。每条 30-120 字。${perDraft}。${visionText}${humanFeelText}${growthText}只输出 JSON，格式示例：{"drafts":["这是第一条草稿的全文","这是第二条草稿的全文","这是第三条草稿的全文"]}。不要加任何其他文字，不要给草稿编号，不要用"草稿1"这样的键名。`;
    const user = lang === 'en'
      ? `Author: ${t.author || ''} ${t.handle || ''}\nTweet:\n${text}`
      : `作者：${t.author || ''} ${t.handle || ''}\n推文：\n${text}`;
    return { sys, user, styles: styles.map(displayStyle), angles: angles.map(displayAngle) };
  }

  if (task === 'topics') {
    const topics = Array.isArray(payload.topics) ? payload.topics.map(String).slice(0, 10) : [];
    const tweets = Array.isArray(payload.tweets) ? payload.tweets.slice(0, 5).map((x) => String((x && x.text) || '').slice(0, 300)) : [];
    const sys = lang === 'en'
      ? `You are the X account operator assistant for ${persona}. Based on the hot topics and popular tweets below on X, suggest 3 topics worth writing about today: for each, one sentence saying what to write, plus one short line explaining why it is worth writing (e.g. trending right now, controversial, likely to go viral). Output JSON only, example format: {"drafts":["Topic one sentence\\nWhy it is worth writing: ...","Topic two sentence\\nWhy it is worth writing: ...","Topic three sentence\\nWhy it is worth writing: ..."]}. Don't add any other text.`
      : `你是${persona}的 X 账号运营助手。根据下面 X 上的热门话题和热门推文，给出今天值得写的 3 个选题：每个选题一句话说清写什么，再加一行简短说明为什么值得写（比如正热、争议大、容易出爆款）。只输出 JSON，格式示例：{"drafts":["一句话选题1\\n为什么值得写：……","一句话选题2\\n为什么值得写：……","一句话选题3\\n为什么值得写：……"]}。不要加任何其他文字。`;
    const user = lang === 'en'
      ? `Hot topics: ${topics.join('; ') || 'none'}\nPopular tweets:\n${tweets.map((x, i) => `${i + 1}. ${x}`).join('\n') || 'none'}`
      : `热门话题：${topics.join('；') || '无'}\n热门推文：\n${tweets.map((x, i) => `${i + 1}. ${x}`).join('\n') || '无'}`;
    return { sys, user, styles: [], angles: [] };
  }

  // trending
  const topics = Array.isArray(payload.topics) ? payload.topics.map(String).slice(0, 10) : [];
  const tweets = Array.isArray(payload.tweets) ? payload.tweets.slice(0, 5).map((x) => String((x && x.text) || '').slice(0, 300)) : [];
  const styleRaw = normalizeStyle(payload.style || settings.style || '');
  const styleHint = styleHintFor(styleRaw, lang);
  const hook = payload.hook || '悬念';
  const hookText = hookHintFor(hook, lang);
  const angle = domain
    ? (lang === 'en' ? `You may write from a ${domain} angle, or just write freely about the topic itself.` : `可以结合${domain}的角度，也可以就事论事自由发挥。`)
    : (lang === 'en' ? 'Write freely about the topic itself — be interesting and opinionated, no need to lean toward any specific direction.' : '就事论事自由发挥，写得有趣、有观点，不必往特定方向靠。');
  const threadText = payload.thread
    ? (lang === 'en'
      ? 'Write it as a thread: output 3-5 connected tweets that form one coherent short essay, each building on the previous one. '
      : '写成一个 thread：输出 3-5 条前后连贯的推文，组成一个完整的小长文，每条承接上一条、层层递进。')
    : '';
  const sys = lang === 'en'
    ? `You are the X account operator assistant for ${persona}. Based on the hot topics and popular tweets below on X, write new post copy: in English, ${styleHint}, ${hookText}. ${threadText}${angle} Don't hard-sell, don't make fortune-telling claims, don't use a superstitious tone. Each post 60-180 words. Output JSON only, example format: {"drafts":["full text of post 1","full text of post 2","full text of post 3"]}. Don't add any other text, don't number the posts, don't use keys like "post1", and don't write "1/5" style numbering inside the text.`
    : `你是${persona}的 X 账号运营助手。根据下面 X 上的热门话题和热门推文，写新的发帖文案：中文、${styleHint}、${hookText}。${threadText}${angle}不要生硬推销、不要算命断言、不要迷信口吻。每条 60-180 字。只输出 JSON，格式示例：{"drafts":["这是第一条文案的全文","这是第二条文案的全文","这是第三条文案的全文"]}。不要加任何其他文字，不要给文案编号，不要用"文案1"这样的键名，也不要在正文里写"1/5"这样的编号。`;
  const user = lang === 'en'
    ? `Hot topics: ${topics.join('; ') || 'none'}\nPopular tweets:\n${tweets.map((x, i) => `${i + 1}. ${x}`).join('\n') || 'none'}`
    : `热门话题：${topics.join('；') || '无'}\n热门推文：\n${tweets.map((x, i) => `${i + 1}. ${x}`).join('\n') || '无'}`;
  return { sys, user, styles: [displayStyle(styleRaw || ALL_STYLES[0])], angles: [] };
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
  const { sys, user, styles, angles } = buildPrompts(task, payload, settings, count);
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
  return { ok: true, results: drafts, model, styles, angles };
}

// Claude 直连（Anthropic）
async function callClaude(task, payload, settings, count) {
  if (!settings.claudeKey) return { ok: false, error: '请先在设置里填 Claude API Key（console.anthropic.com）' };
  const { sys, user, styles, angles } = buildPrompts(task, payload, settings, count);
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
  return { ok: true, results: drafts, model, styles, angles };
}

// OpenAI 兼容接口通用调用（智谱 GLM、硅基流动等国内接口都用这个格式）
// config: { baseUrl, apiKey, model, label, keyHint }
async function callOpenAICompatible(task, payload, settings, count, config) {
  if (!config.apiKey) return { ok: false, error: `请先在设置里填 ${config.label} API Key（${config.keyHint}）` };
  const { sys, user, styles, angles } = buildPrompts(task, payload, settings, count);
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
  return { ok: true, results: drafts, model, styles, angles };
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

// 纯图/带图回复：GLM-4V-Flash 视觉模型（免费），不论当前 provider 是谁都走这里。
// messages 的 user 部分用 OpenAI 兼容的 image_url 格式。
async function callGlmVision(task, payload, settings, count) {
  const glmKey = (settings.glmKey || '').trim();
  if (!glmKey) return { ok: false, error: '纯图回复需要填 GLM Key（设置页 → 智谱 GLM，免费领取）' };
  const { sys, user, styles, angles } = buildPrompts(task, payload, settings, count);
  const images = (payload.tweet && Array.isArray(payload.tweet.images) ? payload.tweet.images : []).filter(Boolean).slice(0, 2);
  const userContent = [{ type: 'text', text: user }];
  images.forEach((url) => userContent.push({ type: 'image_url', image_url: { url } }));
  const res = await fetchWithTimeout('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${glmKey}`,
    },
    body: JSON.stringify({
      model: 'glm-4v-flash',
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: userContent },
      ],
      max_tokens: 700,
      temperature: 0.9,
    }),
  }, 60000);
  const data = await res.json().catch(() => null);
  if (data && data.error) {
    const msg = typeof data.error === 'string' ? data.error : (data.error.message || '未知错误');
    return { ok: false, error: `智谱 GLM 报错：${msg}` };
  }
  if (!res.ok || !data) return { ok: false, error: '智谱 GLM 请求失败，请检查 Key 与网络，稍后再试' };
  const text = (data.choices && data.choices[0] && data.choices[0].message) ? String(data.choices[0].message.content || '') : '';
  const drafts = parseDrafts(text, count);
  if (!drafts.length) return { ok: false, error: '智谱 GLM 未返回可用文案，请稍后再试' };
  return { ok: true, results: drafts, model: 'glm-4v-flash', styles, angles, vision: true };
}

// 按提供商分发；网络不通、超时、后端未上线时统一给友好提示
async function callAi(task, payload, settings, countOverride) {
  let count = countOverride || settings.count;
  // 今日选题固定 3 个；thread 固定 3-5 条
  if (task === 'topics') count = 3;
  if (task === 'trending' && payload.thread) count = Math.min(5, Math.max(3, count));
  try {
    // 纯图/带图回复：不论当前 provider 是谁，都走 GLM-4V-Flash 视觉识别
    if (task === 'reply' && payload.tweet && Array.isArray(payload.tweet.images) && payload.tweet.images.length) {
      return await callGlmVision(task, payload, settings, count);
    }
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
  // 生成文案：{ type: 'xAssistantGenerate', task: 'reply' | 'trending' | 'topics', payload: {...}, count?: number }
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
