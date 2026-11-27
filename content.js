// content.js — 跑在 x.com / twitter.com 的内容脚本
// 职责：
//   1. 抓取用户点开的推文（作者、句柄、正文），交给 AI 生成回复草稿
//   2. 抓取右侧热搜 + 时间线高互动推文，交给 AI 生成热门发帖文案
//   3. 在窗口右侧渲染面板（Shadow DOM，与 X 样式隔离）
// 原则：只读页面、只生成文案；不自动插入回复框、不自动发帖、不点赞、不关注、不转发。

(() => {
  'use strict';

  // ================= 常量 =================
  const PANEL_WIDTH = 380;
  const TRENDING_TOP_N = 5; // 热门取时间线前 5 条高互动推文
  const FALLBACK_ERROR = '后端未就绪/请求失败，请稍后再试';

  // ================= 状态 =================
  let currentTweet = null; // { author, handle, text }
  let lastAutoKey = ''; // 上一次自动生成过的推文 key，避免同一条重复生成
  let replyDrafts = []; // 当前回复草稿
  let replyStyles = []; // 每条回复草稿对应的风格（与 replyDrafts 下标对应）
  let trendingDrafts = []; // 当前热门文案
  let trendingContext = null; // { topics: [], tweets: [] }
  let scrapedTopics = []; // 刚从 X 抓到的热搜话题 + 推文关键词
  let customHotWords = []; // 用户自己添加的热词（存在 chrome.storage.sync）
  let selectedHotWords = new Set(); // 当前选中的热词
  let generating = false;
  let replyAngles = []; // 每条回复草稿对应的角度（与 replyDrafts 下标对应）
  let panelLanguage = 'zh'; // 面板语言选择（存在 chrome.storage.sync，和设置页共用 language 键）
  let panelHumanFeel = false; // 真人感开关
  let panelGrowthMode = false; // 涨粉模式开关
  let panelHook = '悬念'; // 热门文案开头钩子
  let panelThread = false; // 热门文案是否写成 thread
  let topicSuggestions = []; // 今日选题列表（展示用）
  let suggestedTopics = []; // 从选题里点出来的热词（显示为虚线 chip）

  // 启动时读出用户保存的热词和面板偏好（语言、真人感、涨粉模式、钩子、thread）
  try {
    chrome.storage.sync.get({ customHotWords: [], language: 'zh', humanFeel: false, growthMode: false, hook: '悬念', thread: false }, (items) => {
      customHotWords = Array.isArray(items.customHotWords) ? items.customHotWords.filter(Boolean) : [];
      panelLanguage = items.language === 'en' ? 'en' : 'zh';
      panelHumanFeel = !!items.humanFeel;
      panelGrowthMode = !!items.growthMode;
      panelHook = items.hook || '悬念';
      panelThread = !!items.thread;
      syncPanelPrefs();
      renderHotwordChips();
    });
  } catch (e) { /* 忽略 */ }

  // ================= 小工具 =================
  // 把 "1.2K" / "3.4万" / "1.2M" / "1,234" 这类文本解析成数字
  function parseCount(raw) {
    if (!raw) return 0;
    const s = String(raw).replace(/,/g, '').trim();
    const m = s.match(/([\d.]+)\s*([KkMm万亿]?)/);
    if (!m) return 0;
    const num = parseFloat(m[1]);
    if (isNaN(num)) return 0;
    const unit = m[2];
    if (unit === 'K' || unit === 'k') return Math.round(num * 1000);
    if (unit === 'M' || unit === 'm') return Math.round(num * 1000000);
    if (unit === '万') return Math.round(num * 10000);
    if (unit === '亿') return Math.round(num * 100000000);
    return Math.round(num);
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // 推文去重 key：句柄 + 正文前 80 字 + 首张配图（纯图推文没有文字，靠图区分）
  function tweetKey(t) {
    return (t.handle || '') + '|' + (t.text || '').slice(0, 80) + '|' + ((t.images || [])[0] || '');
  }

  function formatCount(n) {
    if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + '万';
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(n);
  }

  // ================= 推文抓取 =================
  // 从一条 article[data-testid="tweet"] 里提取作者、句柄、正文
  function extractTweet(article) {
    if (!article) return null;

    // 正文：data-testid="tweetText"（X 官方 testid，相对稳定）
    const textEl = article.querySelector('div[data-testid="tweetText"]');
    const text = textEl ? textEl.innerText.trim() : '';

    // 作者区：data-testid="User-Name"，里面一般是“名字\n@句柄”两行
    let author = '';
    let handle = '';
    const userName = article.querySelector('div[data-testid="User-Name"]');
    if (userName) {
      const raw = userName.innerText || '';
      const hm = raw.match(/@([A-Za-z0-9_]+)/);
      if (hm) handle = '@' + hm[1];
      const lines = raw.split('\n').map((s) => s.trim()).filter(Boolean);
      author = lines.find((l) => !l.startsWith('@')) || '';
    }

    // fallback：从推文链接 /<handle>/status/<id> 里取句柄
    if (!handle) {
      const link = article.querySelector('a[href*="/status/"]');
      if (link) {
        const hm = (link.getAttribute('href') || '').match(/^\/([^/]+)\/status\//);
        if (hm) handle = '@' + hm[1];
      }
    }

    if (!text && !author && !handle) return null;
    return { author, handle, text, images: extractTweetImages(article) };
  }

  // 抓推文配图：优先取 data-testid="tweetPhoto" 里的 img；fallback 再从 article 里找
  // pbs.twimg.com/media 的大图（排除头像 profile_images 和小图）。最多 2 张，
  // 原图链接把 name=small 换成 name=large，让视觉模型看得更清楚。
  function extractTweetImages(article) {
    const urls = [];
    const push = (src) => {
      if (!src || urls.includes(src) || urls.length >= 2) return;
      urls.push(src.replace(/([?&])name=\w+/, '$1name=large'));
    };
    if (!article) return urls;
    article.querySelectorAll('[data-testid="tweetPhoto"] img').forEach((img) => {
      push(img.getAttribute('src') || img.currentSrc || '');
    });
    if (urls.length) return urls;
    article.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src') || '';
      if (!src || /profile_images/.test(src)) return;
      if (img.closest('[data-testid="User-Avatar"], [data-testid="Tweet-User-Avatar"]')) return;
      if (!/pbs\.twimg\.com\/(media|tweet_video_thumb)/.test(src)) return;
      push(src);
    });
    return urls;
  }

  // 详情页（x.com/<handle>/status/<id>）的主推文一般是页面上第一条 article
  function getDetailMainTweet() {
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    if (!articles.length) return null;
    return extractTweet(articles[0]);
  }

  function isStatusPage() {
    return /\/status\/\d+/.test(location.pathname);
  }

  // 推文底部操作栏里的互动数（点赞 / 转发）
  function getActionCount(article, testId) {
    const btn = article.querySelector('[data-testid="' + testId + '"]');
    if (!btn) return 0;
    // 优先读 aria-label，如 "1.2K Likes" / "1234 个赞"
    let n = parseCount(btn.getAttribute('aria-label') || '');
    if (n > 0) return n;
    // 再试按钮内文本
    n = parseCount(btn.innerText || '');
    if (n > 0) return n;
    // 有些版本数字在按钮父级相邻的 span 里
    const span = btn.parentElement ? btn.parentElement.querySelector('span') : null;
    if (span) n = parseCount(span.innerText || '');
    return n;
  }

  // ================= 热门抓取 =================
  // 一个 trend 元素的 innerText 通常是三行：
  //   分类行（如“商业・金融 · 趋势”）/ 真正的话题名 / 帖子数（如“1.2万 条帖子”）
  // 以前取第 1 行，拿到的是分类（商业・金融、日本、美食……），不是话题本身；
  // 现在跳过分类行和帖子数行，取真正的话题名，并按帖子数从高到低排序，最热的排前面。
  function pickTopicLine(lines) {
    return lines.find((l) => !/趋势|Trending/i.test(l) && !/帖子|Posts/i.test(l) && !/^[\d,.]+[KkMm万]?/.test(l) && l.length > 1) || lines[0];
  }

  // 从 trend 元素的各行里找帖子数行（如“1.2万 条帖子”/“12.3K posts”），解析成数字
  function pickPostCount(lines) {
    const line = lines.find((l) => /帖子|Posts/i.test(l));
    return line ? parseCount(line) : 0;
  }

  function extractTrendingTopics() {
    const found = new Map(); // 话题名 -> 帖子数（同一话题出现多次时取最大的）
    const add = (topic, posts) => {
      if (!topic || topic.length <= 1) return;
      const prev = found.get(topic);
      if (prev === undefined || posts > prev) found.set(topic, posts);
    };
    // 首选：data-testid="trend" 的词条
    document.querySelectorAll('[data-testid="trend"]').forEach((el) => {
      const lines = (el.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
      add(pickTopicLine(lines), pickPostCount(lines));
    });
    if (found.size) return [...found.entries()].sort((a, b) => b[1] - a[1]).map(([topic]) => topic);

    // fallback：在“正在发生 / What's happening”标题附近找链接文本
    const headings = Array.from(document.querySelectorAll('h2, span')).filter((el) => {
      const t = (el.textContent || '').trim();
      return t === '正在发生' || t === "What's happening";
    });
    for (const h of headings) {
      const container = h.closest('section') || h.parentElement;
      if (!container) continue;
      container.querySelectorAll('a, [role="link"]').forEach((a) => {
        const lines = (a.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
        add(pickTopicLine(lines), pickPostCount(lines));
      });
      if (found.size) break;
    }
    return [...found.entries()].sort((a, b) => b[1] - a[1]).map(([topic]) => topic);
  }

  // 从高互动推文里提关键词：hashtag + 高频实词（去掉停用词、URL、@提及），按出现次数排序。
  // 用来补热搜栏抓不到的“当下正在聊”的词。
  const KEYWORD_STOPWORDS = new Set(('的 了 在 是 我 有 和 就 不 你 都 也 还 这 那 他 她 它 我们 你们 他们 一个 没有 什么 怎么 可以 这个 那个 就是 但是 因为 所以 如果 还是 不是 不要 现在 今天 今年 大家 真的 以及 或者 而且 然后 之后 这样 那样 那里 这里 时候 可能 应该 进行 通过 the a an and or of to in on for with is are was were be been this that it its as at by from have has had you your we our they their he she his her not but all can will would about into more than then them there what when who which how just like get got one two new now today').split(' '));

  function extractKeywordsFromTweets(tweets, limit) {
    const counts = new Map();
    const add = (w) => {
      const k = String(w || '').trim();
      if (k.length < 2 || KEYWORD_STOPWORDS.has(k) || KEYWORD_STOPWORDS.has(k.toLowerCase())) return;
      counts.set(k, (counts.get(k) || 0) + 1);
    };
    for (const t of tweets || []) {
      let text = String((t && t.text) || '');
      if (!text) continue;
      text = text.replace(/https?:\/\/\S+/g, ' ').replace(/@\w+/g, ' ');
      // hashtag：#词
      const tags = text.match(/#([^\s#.,!?;:，。！？；：]+)/g) || [];
      tags.forEach((tag) => add(tag));
      const plain = text.replace(/#[^\s#.,!?;:，。！？；：]+/g, ' ');
      // 中文：2-4 字连续中文
      const zhWords = plain.match(/[\u4e00-\u9fa5]{2,4}/g) || [];
      zhWords.forEach((w) => add(w));
      // 英文：3 字母以上的单词
      const enWords = plain.match(/[A-Za-z][A-Za-z0-9_]{2,}/g) || [];
      enWords.forEach((w) => add(w.toLowerCase()));
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
      .slice(0, limit || 8)
      .map(([w]) => w);
  }

  // 扫当前时间线，按（点赞 + 转发）取前 N 条高互动推文
  function extractTopTweets(limit) {
    const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
    const scored = [];
    for (const a of articles) {
      const t = extractTweet(a);
      if (!t || !t.text) continue;
      const likes = getActionCount(a, 'like');
      const reposts = getActionCount(a, 'retweet');
      scored.push({ author: t.author, handle: t.handle, text: t.text, likes, reposts, score: likes + reposts });
    }
    scored.sort((x, y) => y.score - x.score);
    // 去重：同一条推文可能在时间线里出现多次
    const seen = new Set();
    const top = [];
    for (const s of scored) {
      const k = tweetKey(s);
      if (seen.has(k)) continue;
      seen.add(k);
      top.push(s);
      if (top.length >= limit) break;
    }
    return top;
  }

  // ================= 面板 UI（Shadow DOM） =================
  const CSS = `
    * { box-sizing: border-box; }
    .xa-toggle {
      position: fixed; top: 42%; right: 0; z-index: 2147483647;
      width: 34px; height: 72px; border: none; border-radius: 8px 0 0 8px;
      background: #1a1a2e; color: #fff; font-size: 16px; font-weight: 700;
      cursor: pointer; box-shadow: -2px 0 8px rgba(0,0,0,.25);
      writing-mode: vertical-rl; letter-spacing: 3px; padding: 0;
    }
    .xa-toggle.open { right: ${PANEL_WIDTH}px; }
    .xa-panel {
      position: fixed; top: 0; right: 0; width: ${PANEL_WIDTH}px; height: 100vh;
      background: #fff; color: #0f1419; z-index: 2147483646;
      box-shadow: -4px 0 16px rgba(0,0,0,.18);
      display: flex; flex-direction: column;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      font-size: 14px; line-height: 1.5;
    }
    .xa-panel.hidden { display: none; }
    .xa-header { display: flex; justify-content: space-between; align-items: center; padding: 12px 14px; border-bottom: 1px solid #eff3f4; }
    .xa-title { font-weight: 700; font-size: 15px; }
    .xa-collapse { border: 1px solid #cfd9de; background: #fff; border-radius: 999px; padding: 4px 12px; cursor: pointer; font-size: 13px; color: #0f1419; }
    .xa-tabs { display: flex; border-bottom: 1px solid #eff3f4; }
    .xa-tab { flex: 1; padding: 10px 0; border: none; background: #fff; font-size: 14px; cursor: pointer; color: #536471; border-bottom: 2px solid transparent; }
    .xa-tab.active { color: #0f1419; font-weight: 700; border-bottom-color: #1d9bf0; }
    .xa-body { flex: 1; overflow-y: auto; padding: 12px 14px; }
    .xa-pane.hidden { display: none; }
    .xa-tweet { background: #f7f9f9; border: 1px solid #eff3f4; border-radius: 12px; padding: 10px 12px; margin-bottom: 10px; }
    .xa-author { font-weight: 700; }
    .xa-handle { color: #536471; margin-left: 6px; }
    .xa-text { margin-top: 4px; white-space: pre-wrap; word-break: break-word; }
    .xa-empty { color: #536471; }
    .xa-btn { width: 100%; padding: 9px 0; border: none; border-radius: 999px; background: #1d9bf0; color: #fff; font-size: 14px; font-weight: 700; cursor: pointer; }
    .xa-btn:disabled { opacity: .5; cursor: default; }
    .xa-status { color: #536471; font-size: 13px; min-height: 20px; margin: 8px 0; }
    .xa-status.error { color: #f4212e; }
    .xa-draft { border: 1px solid #eff3f4; border-radius: 12px; padding: 10px 12px; margin-bottom: 10px; }
    .xa-draft-text { white-space: pre-wrap; word-break: break-word; }
    .xa-draft-actions { display: flex; gap: 8px; margin-top: 8px; }
    .xa-mini { border: 1px solid #cfd9de; background: #fff; border-radius: 999px; padding: 3px 12px; font-size: 13px; cursor: pointer; color: #0f1419; }
    .xa-context { font-size: 13px; color: #536471; margin-bottom: 8px; }
    .xa-context b { color: #0f1419; }
    .xa-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
    .xa-chip { border: 1px solid #cfd9de; background: #fff; border-radius: 999px; padding: 3px 10px; font-size: 13px; cursor: pointer; color: #0f1419; }
    .xa-chip.selected { background: #1d9bf0; border-color: #1d9bf0; color: #fff; }
    .xa-chip .xa-chip-x { margin-left: 4px; color: #f4212e; font-weight: 700; }
    .xa-chip.selected .xa-chip-x { color: #fff; }
    .xa-row { display: flex; gap: 8px; margin: 8px 0; }
    .xa-input { flex: 1; padding: 7px 10px; border: 1px solid #cfd9de; border-radius: 8px; font-size: 13px; }
    .xa-select { width: 100%; padding: 7px 10px; border: 1px solid #cfd9de; border-radius: 8px; font-size: 13px; margin: 4px 0 8px; background: #fff; }
    .xa-label { font-size: 13px; font-weight: 700; margin-top: 10px; }
    .xa-style-tag { display: inline-block; font-size: 12px; color: #1d9bf0; border: 1px solid #1d9bf0; border-radius: 999px; padding: 1px 8px; margin-bottom: 6px; }
    .xa-check { display: flex; align-items: center; gap: 6px; font-size: 13px; margin: 6px 0; cursor: pointer; flex: 1; }
    .xa-check input { accent-color: #1d9bf0; }
    .xa-row .xa-select { flex: 1; margin: 0; }
    .xa-btn-secondary { background: #f7f9f9; color: #0f1419; border: 1px solid #cfd9de; margin-top: 8px; }
    .xa-topic { border: 1px solid #eff3f4; border-radius: 12px; padding: 10px 12px; margin-bottom: 10px; cursor: pointer; }
    .xa-topic:hover { border-color: #1d9bf0; }
    .xa-topic-title { font-weight: 700; }
    .xa-topic-reason { color: #536471; font-size: 13px; margin-top: 4px; white-space: pre-wrap; word-break: break-word; }
    .xa-chip.suggested { border-style: dashed; }
    .xa-footer { border-top: 1px solid #eff3f4; padding: 8px 14px; font-size: 12px; color: #536471; display: flex; justify-content: space-between; align-items: center; }
    .xa-footer button { border: none; background: none; color: #1d9bf0; cursor: pointer; font-size: 12px; padding: 0; }
    .xa-footer #xa-version { color: #536471; margin-right: 8px; }
    .xa-footer .xa-author-link { color: #1d9bf0; text-decoration: none; margin-right: 8px; }
  `;

  let shadow = null;
  let els = {};

  function buildPanel() {
    const host = document.createElement('div');
    host.id = 'xa-host';
    // host 本身不挡点击，里面的面板和开关按钮各自接管点击
    host.style.cssText = 'position: fixed; top: 0; right: 0; z-index: 2147483647; pointer-events: none;';
    document.body.appendChild(host);
    shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);

    const toggle = document.createElement('button');
    toggle.className = 'xa-toggle';
    toggle.textContent = '助手';
    toggle.style.pointerEvents = 'auto';
    toggle.addEventListener('click', () => setPanelOpen(!isPanelOpen()));
    shadow.appendChild(toggle);

    const panel = document.createElement('div');
    panel.className = 'xa-panel hidden';
    panel.style.pointerEvents = 'auto';
    panel.innerHTML =
      '<div class="xa-header">' +
        '<span class="xa-title">X 推文助手</span>' +
        '<button class="xa-collapse" type="button">收起</button>' +
      '</div>' +
      '<div class="xa-tabs">' +
        '<button class="xa-tab active" type="button" data-tab="reply">回复助手</button>' +
        '<button class="xa-tab" type="button" data-tab="trending">热门文案</button>' +
      '</div>' +
      '<div class="xa-body">' +
        '<div class="xa-pane" id="pane-reply">' +
          '<div class="xa-tweet" id="reply-tweet"><span class="xa-empty">点一下任意推文，这里会显示推文内容并自动生成回复草稿。</span></div>' +
          '<div class="xa-label">回复语言</div>' +
          '<select class="xa-select" id="reply-language">' +
            '<option value="zh">中文回复</option>' +
            '<option value="en">English replies</option>' +
          '</select>' +
          '<div class="xa-row">' +
            '<label class="xa-check"><input type="checkbox" id="reply-humanfeel"> 真人感</label>' +
            '<label class="xa-check"><input type="checkbox" id="reply-growth"> 涨粉模式</label>' +
          '</div>' +
          '<button class="xa-btn" type="button" id="btn-gen-reply">生成回复</button>' +
          '<div class="xa-status" id="reply-status"></div>' +
          '<div id="reply-list"></div>' +
        '</div>' +
        '<div class="xa-pane hidden" id="pane-trending">' +
          '<button class="xa-btn" type="button" id="btn-grab-trending">抓取热门</button>' +
          '<button class="xa-btn xa-btn-secondary" type="button" id="btn-topics">今日选题</button>' +
          '<div id="topic-list"></div>' +
          '<div class="xa-context" id="trending-context"></div>' +
          '<div class="xa-label">热词（点一下选中 / 取消）</div>' +
          '<div class="xa-chips" id="hotword-chips"></div>' +
          '<div class="xa-row">' +
            '<input class="xa-input" type="text" id="hotword-input" placeholder="添加热词，比如：Claude、AI 编程">' +
            '<button class="xa-mini" type="button" id="btn-add-hotword">添加</button>' +
          '</div>' +
          '<div class="xa-label">内容风格</div>' +
          '<select class="xa-select" id="trending-style">' +
            '<option value="自然口语">自然口语</option>' +
            '<option value="专业干货">专业干货</option>' +
            '<option value="幽默">幽默</option>' +
          '</select>' +
          '<div class="xa-label">开头钩子</div>' +
          '<select class="xa-select" id="trending-hook">' +
            '<option value="悬念">悬念</option>' +
            '<option value="争议">争议</option>' +
            '<option value="数据">数据</option>' +
            '<option value="故事">故事</option>' +
            '<option value="提问">提问</option>' +
          '</select>' +
          '<div class="xa-label">出文语言</div>' +
          '<select class="xa-select" id="trending-language">' +
            '<option value="zh">中文文案</option>' +
            '<option value="en">English posts</option>' +
          '</select>' +
          '<label class="xa-check"><input type="checkbox" id="trending-thread"> 写成 thread（3-5 条连贯推文）</label>' +
          '<button class="xa-btn" type="button" id="btn-gen-trending">生成文案</button>' +
          '<div class="xa-status" id="trending-status"></div>' +
          '<div id="trending-list"></div>' +
        '</div>' +
      '</div>' +
      '<div class="xa-footer"><span>只生成文案，不自动发帖</span><span><span id="xa-version"></span><a class="xa-author-link" href="https://x.com/zj19890730" target="_blank" rel="noopener">联系作者</a><button type="button" id="btn-options">设置</button></span></div>';
    shadow.appendChild(panel);

    els = {
      toggle,
      panel,
      collapseBtn: panel.querySelector('.xa-collapse'),
      tabs: Array.from(panel.querySelectorAll('.xa-tab')),
      panes: {
        reply: panel.querySelector('#pane-reply'),
        trending: panel.querySelector('#pane-trending'),
      },
      replyTweet: panel.querySelector('#reply-tweet'),
      replyLanguage: panel.querySelector('#reply-language'),
      replyHumanFeel: panel.querySelector('#reply-humanfeel'),
      replyGrowth: panel.querySelector('#reply-growth'),
      btnGenReply: panel.querySelector('#btn-gen-reply'),
      replyStatus: panel.querySelector('#reply-status'),
      replyList: panel.querySelector('#reply-list'),
      btnGrabTrending: panel.querySelector('#btn-grab-trending'),
      btnTopics: panel.querySelector('#btn-topics'),
      topicList: panel.querySelector('#topic-list'),
      trendingContext: panel.querySelector('#trending-context'),
      hotwordChips: panel.querySelector('#hotword-chips'),
      hotwordInput: panel.querySelector('#hotword-input'),
      btnAddHotword: panel.querySelector('#btn-add-hotword'),
      trendingStyle: panel.querySelector('#trending-style'),
      trendingHook: panel.querySelector('#trending-hook'),
      trendingLanguage: panel.querySelector('#trending-language'),
      trendingThread: panel.querySelector('#trending-thread'),
      btnGenTrending: panel.querySelector('#btn-gen-trending'),
      trendingStatus: panel.querySelector('#trending-status'),
      trendingList: panel.querySelector('#trending-list'),
      versionEl: panel.querySelector('#xa-version'),
      btnOptions: panel.querySelector('#btn-options'),
    };
    // 面板底部显示版本号（从 manifest 里读，改版本后自动同步）
    try {
      const ver = chrome.runtime.getManifest().version;
      if (els.versionEl) els.versionEl.textContent = 'v' + ver;
    } catch (e) { /* 忽略 */ }

    els.collapseBtn.addEventListener('click', () => setPanelOpen(false));
    els.tabs.forEach((tab) => {
      tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });
    els.btnGenReply.addEventListener('click', () => generateReplies(false));
    els.btnGrabTrending.addEventListener('click', grabTrending);
    els.btnAddHotword.addEventListener('click', addHotword);
    els.hotwordInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addHotword(); });
    els.btnGenTrending.addEventListener('click', generateTrending);
    els.replyLanguage.addEventListener('change', () => { panelLanguage = els.replyLanguage.value; els.trendingLanguage.value = panelLanguage; savePanelPrefs(); });
    els.trendingLanguage.addEventListener('change', () => { panelLanguage = els.trendingLanguage.value; els.replyLanguage.value = panelLanguage; savePanelPrefs(); });
    els.replyHumanFeel.addEventListener('change', () => { panelHumanFeel = els.replyHumanFeel.checked; savePanelPrefs(); });
    els.replyGrowth.addEventListener('change', () => { panelGrowthMode = els.replyGrowth.checked; savePanelPrefs(); });
    els.trendingHook.addEventListener('change', () => { panelHook = els.trendingHook.value; savePanelPrefs(); });
    els.trendingThread.addEventListener('change', () => { panelThread = els.trendingThread.checked; savePanelPrefs(); });
    els.btnTopics.addEventListener('click', generateTopics);
    els.btnOptions.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'xAssistantOpenOptions' });
    });
  }

  function isPanelOpen() {
    return els.panel && !els.panel.classList.contains('hidden');
  }

  function setPanelOpen(open) {
    if (!els.panel) return;
    els.panel.classList.toggle('hidden', !open);
    els.toggle.classList.toggle('open', open);
    els.toggle.textContent = open ? '收起' : '助手';
  }

  function switchTab(name) {
    els.tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    els.panes.reply.classList.toggle('hidden', name !== 'reply');
    els.panes.trending.classList.toggle('hidden', name !== 'trending');
  }

  // 把面板偏好同步到控件上（启动时读完存储后调一次）
  function syncPanelPrefs() {
    if (!els.replyLanguage) return;
    els.replyLanguage.value = panelLanguage;
    els.trendingLanguage.value = panelLanguage;
    els.replyHumanFeel.checked = panelHumanFeel;
    els.replyGrowth.checked = panelGrowthMode;
    els.trendingHook.value = panelHook;
    els.trendingThread.checked = panelThread;
  }

  // 面板偏好存到 chrome.storage.sync（语言和设置页共用同一个 language 键）
  function savePanelPrefs() {
    try {
      chrome.storage.sync.set({ language: panelLanguage, humanFeel: panelHumanFeel, growthMode: panelGrowthMode, hook: panelHook, thread: panelThread });
    } catch (_) { /* 忽略 */ }
  }

  function setStatus(which, text, isError) {
    const el = which === 'reply' ? els.replyStatus : els.trendingStatus;
    el.textContent = text || '';
    el.classList.toggle('error', !!isError);
  }

  // ================= 文案渲染 =================
  // 兜底清洗：万一某条草稿还带着 JSON 痕迹（如 {"drafts":...} 或 "草稿1":"..."），
  // 在显示前把它剥掉，只留正文，面板永远不直接显示原始 JSON。
  // 正常草稿是纯中文，不会以 { 或 [ 开头，所以这步不会动到正常内容。
  function sanitizeDraft(s) {
    let t = String(s || '').trim();
    if (!t) return t;
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
      try {
        const parsed = JSON.parse(t);
        const arr = Array.isArray(parsed) ? parsed : parsed.drafts;
        if (Array.isArray(arr) && arr.length) return String(arr[0]).trim();
        if (parsed && typeof parsed === 'object') {
          const vals = Object.values(parsed).flatMap((v) => (Array.isArray(v) ? v : [v]));
          if (vals.length) return String(vals[0]).trim();
        }
      } catch { /* 非法 JSON，继续走下面的键值提取 */ }
      // 非法 JSON：提取 "xxx":"yyy" 键值对里的值（如数组里套 "草稿1":"..."）
      const kv = [...t.matchAll(/"[^"\n]*"\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').trim()).filter(Boolean);
      if (kv.length) return kv.join('\n');
    }
    // 去掉行首的 "草稿1：" / "1." 这类标签
    return t.replace(/^(草稿\s*\d+|第\s*\d+\s*条|\(\s*\d+\s*\)|\d+\s*[.、）])\s*[:：]?\s*/, '').trim();
  }

  function renderReplyTweet() {
    if (!currentTweet || (!currentTweet.text && !(currentTweet.images && currentTweet.images.length))) {
      els.replyTweet.innerHTML = '<span class="xa-empty">没抓到推文内容，点一下推文再试。</span>';
      return;
    }
    els.replyTweet.innerHTML =
      '<div><span class="xa-author">' + escapeHtml(currentTweet.author || '未知作者') + '</span>' +
      (currentTweet.handle ? '<span class="xa-handle">' + escapeHtml(currentTweet.handle) + '</span>' : '') + '</div>' +
      (currentTweet.text
        ? '<div class="xa-text">' + escapeHtml(currentTweet.text) + '</div>'
        : '<div class="xa-text xa-empty">这条推文是纯图（没有文字），将按图片内容生成回复。</div>');
  }

  // 渲染草稿列表；kind 为 'reply'（带风格标签 + 重新生成）或 'trending'（只有复制）
  function renderDrafts(kind) {
    const list = kind === 'reply' ? els.replyList : els.trendingList;
    const drafts = kind === 'reply' ? replyDrafts : trendingDrafts;
    list.innerHTML = '';
    drafts.forEach((text, i) => {
      const item = document.createElement('div');
      item.className = 'xa-draft';
      // 回复草稿：每条打上风格 + 角度标签（比如“自然口语 · 共鸣”），方便挑
      if (kind === 'reply' && (replyStyles[i] || replyAngles[i])) {
        const tag = document.createElement('span');
        tag.className = 'xa-style-tag';
        tag.textContent = [replyStyles[i], replyAngles[i]].filter(Boolean).join(' · ');
        item.appendChild(tag);
      }
      const body = document.createElement('div');
      body.className = 'xa-draft-text';
      body.textContent = sanitizeDraft(text);
      const actions = document.createElement('div');
      actions.className = 'xa-draft-actions';

      const copyBtn = document.createElement('button');
      copyBtn.className = 'xa-mini';
      copyBtn.type = 'button';
      copyBtn.textContent = '复制';
      copyBtn.addEventListener('click', () => copyText(text, copyBtn));
      actions.appendChild(copyBtn);

      if (kind === 'reply') {
        const regenBtn = document.createElement('button');
        regenBtn.className = 'xa-mini';
        regenBtn.type = 'button';
        regenBtn.textContent = '重新生成';
        regenBtn.addEventListener('click', () => regenerateOne(i, regenBtn));
        actions.appendChild(regenBtn);
      }

      item.appendChild(body);
      item.appendChild(actions);
      list.appendChild(item);
    });
  }

  async function copyText(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      // clipboard API 不可用时用传统方式兜底
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (_) { /* 忽略 */ }
      ta.remove();
    }
    const old = btn.textContent;
    btn.textContent = '已复制';
    setTimeout(() => { btn.textContent = old; }, 1500);
  }

  // ================= AI 调用 =================
  function callGenerate(task, payload, count) {
    const msg = { type: 'xAssistantGenerate', task, payload };
    if (count) msg.count = count;
    return chrome.runtime.sendMessage(msg);
  }

  // 生成回复草稿；auto 为 true 时是点推文后的自动生成（同一条只自动生成一次）
  async function generateReplies(auto) {
    if (!currentTweet || (!currentTweet.text && !(currentTweet.images && currentTweet.images.length))) {
      renderReplyTweet();
      setStatus('reply', '没抓到推文内容，点一下推文再试', true);
      return;
    }
    if (auto) {
      const key = tweetKey(currentTweet);
      if (key === lastAutoKey) return; // 同一条推文不重复自动生成
      lastAutoKey = key;
    }
    if (generating) return;
    generating = true;
    els.btnGenReply.disabled = true;
    setStatus('reply', '正在生成…');
    let res = null;
    try {
      res = await callGenerate('reply', {
        tweet: { author: currentTweet.author, handle: currentTweet.handle, text: currentTweet.text, images: currentTweet.images || [] },
        language: panelLanguage,
        humanFeel: panelHumanFeel,
        growthMode: panelGrowthMode,
      });
    } catch (e) {
      res = null;
    }
    generating = false;
    els.btnGenReply.disabled = false;
    if (!res || !res.ok) {
      setStatus('reply', (res && res.error) || FALLBACK_ERROR, true);
      return;
    }
    replyDrafts = res.results;
    replyStyles = Array.isArray(res.styles) ? res.styles : [];
    replyAngles = Array.isArray(res.angles) ? res.angles : [];
    renderDrafts('reply');
    const visionNote = res.vision ? '（已识别图片内容）' : '';
    setStatus('reply', (res.model ? '模型：' + res.model : '已生成，自己复制粘贴到 X 回复框里发。') + visionNote);
  }

  // 单条重新生成：只请求 1 条，替换对应位置
  async function regenerateOne(index, btn) {
    if (!currentTweet || (!currentTweet.text && !(currentTweet.images && currentTweet.images.length)) || generating) return;
    generating = true;
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '生成中…';
    let res = null;
    try {
      // 单条重新生成：用这条原来对应的风格和角度，保持三条各不相同
      res = await callGenerate('reply', {
        tweet: { author: currentTweet.author, handle: currentTweet.handle, text: currentTweet.text, images: currentTweet.images || [] },
        style: replyStyles[index] || undefined,
        angle: replyAngles[index] || undefined,
        language: panelLanguage,
        humanFeel: panelHumanFeel,
        growthMode: panelGrowthMode,
      }, 1);
    } catch (e) {
      res = null;
    }
    generating = false;
    btn.disabled = false;
    btn.textContent = old;
    if (!res || !res.ok) {
      setStatus('reply', (res && res.error) || FALLBACK_ERROR, true);
      return;
    }
    if (res.results && res.results.length) {
      replyDrafts[index] = res.results[0];
      if (Array.isArray(res.styles) && res.styles[0]) replyStyles[index] = res.styles[0];
      if (Array.isArray(res.angles) && res.angles[0]) replyAngles[index] = res.angles[0];
      renderDrafts('reply');
    }
  }

  // 渲染热词 chips：上面是刚抓到的热搜话题，下面是用户自己加的热词。
  // 点一下选中 / 取消选中；自己加的热词带 ×，点 × 删掉。
  function renderHotwordChips() {
    const box = els.hotwordChips;
    if (!box) return;
    box.innerHTML = '';
    const addChip = (word, isCustom, isSuggested) => {
      const chip = document.createElement('button');
      chip.className = 'xa-chip' + (selectedHotWords.has(word) ? ' selected' : '') + (isSuggested ? ' suggested' : '');
      chip.type = 'button';
      chip.textContent = word;
      if (isCustom) {
        const x = document.createElement('span');
        x.className = 'xa-chip-x';
        x.textContent = '×';
        x.title = '删除这个热词';
        x.addEventListener('click', (e) => {
          e.stopPropagation();
          customHotWords = customHotWords.filter((w) => w !== word);
          selectedHotWords.delete(word);
          try { chrome.storage.sync.set({ customHotWords }); } catch (_) { /* 忽略 */ }
          renderHotwordChips();
        });
        chip.appendChild(x);
      }
      chip.addEventListener('click', () => {
        if (selectedHotWords.has(word)) selectedHotWords.delete(word);
        else selectedHotWords.add(word);
        renderHotwordChips();
      });
      box.appendChild(chip);
    };
    scrapedTopics.slice(0, 10).forEach((w) => addChip(w, false));
    suggestedTopics.forEach((w) => addChip(w, false, true));
    customHotWords.forEach((w) => addChip(w, true));
    if (!scrapedTopics.length && !customHotWords.length && !suggestedTopics.length) {
      box.innerHTML = '<span class="xa-empty">还没有热词，点“抓取热门”从 X 抓，或在下面自己添加。</span>';
    }
  }

  // 添加热词：保存到 chrome.storage.sync，下次打开还在
  function addHotword() {
    const word = (els.hotwordInput.value || '').trim();
    if (!word) return;
    if (!customHotWords.includes(word)) {
      customHotWords.push(word);
      try { chrome.storage.sync.set({ customHotWords }); } catch (_) { /* 忽略 */ }
    }
    selectedHotWords.add(word);
    els.hotwordInput.value = '';
    renderHotwordChips();
  }

  // 抓取热门：抓热搜话题（按帖子数排，最热在前）+ 高互动推文，再从推文里提关键词，
  // 一起展示成可点的热词，不直接生成；等用户选好热词、选好风格，再点“生成文案”。
  function grabTrending() {
    if (generating) return;
    const topics = extractTrendingTopics();
    const top = extractTopTweets(TRENDING_TOP_N);
    trendingContext = { topics, tweets: top };
    // 从高互动推文里提关键词，补到热搜话题后面（去掉和热搜重复的）
    const keywords = extractKeywordsFromTweets(top, 8).filter((w) => !topics.some((t) => t.toLowerCase() === String(w).toLowerCase()));
    scrapedTopics = [...topics, ...keywords];

    if (!topics.length && !top.length) {
      els.trendingContext.innerHTML = '';
      setStatus('trending', '没抓到热门内容，刷新一下页面再试', true);
      renderHotwordChips();
      return;
    }
    let ctx = '';
    if (top.length) {
      ctx += '<div>已抓到高互动推文 ' + top.length + ' 条（最高 ' + formatCount(top[0].score) + ' 互动），生成时会一起参考。</div>';
    }
    els.trendingContext.innerHTML = ctx;
    // 默认把抓到的前 3 个热搜话题选上，自己加的热词也默认选中，用户可以再点着改
    selectedHotWords = new Set(topics.slice(0, 3));
    customHotWords.forEach((w) => selectedHotWords.add(w));
    renderHotwordChips();
    setStatus('trending', topics.length
      ? '已抓到 ' + topics.length + ' 个热搜话题（按热度排序）' + (keywords.length ? '和 ' + keywords.length + ' 个推文关键词' : '') + '，选好热词和风格后点“生成文案”。'
      : '没抓到热搜话题，可以自己添加热词再生成。');
  }

  // 今日选题：根据已抓的热点话题 + 高互动推文，让 AI 给出今天值得写的 3 个选题。
  // 没抓过热点时先自动抓一次。点一个选题就把它加进热词，再点“生成文案”。
  async function generateTopics() {
    if (generating) return;
    if (!trendingContext) grabTrending();
    const topics = scrapedTopics.slice(0, 10);
    const top = trendingContext ? trendingContext.tweets : [];
    if (!topics.length && !top.length) {
      setStatus('trending', '先点“抓取热门”，抓到内容后再生成选题', true);
      return;
    }
    generating = true;
    els.btnTopics.disabled = true;
    setStatus('trending', '正在想今天的选题…');
    let res = null;
    try {
      res = await callGenerate('topics', {
        topics,
        tweets: (top || []).map((t) => ({ text: t.text, likes: t.likes })),
        language: panelLanguage,
      });
    } catch (e) {
      res = null;
    }
    generating = false;
    els.btnTopics.disabled = false;
    if (!res || !res.ok) {
      setStatus('trending', (res && res.error) || FALLBACK_ERROR, true);
      return;
    }
    topicSuggestions = res.results || [];
    renderTopics();
    setStatus('trending', '已生成今日选题，点一个就能把它加进热词，再点“生成文案”。');
  }

  // 渲染今日选题列表：每条是“一句话选题 + 为什么值得写”，点一下加进热词
  function renderTopics() {
    const box = els.topicList;
    if (!box) return;
    box.innerHTML = '';
    topicSuggestions.forEach((raw) => {
      const text = sanitizeDraft(raw);
      if (!text) return;
      // 拆成标题和原因：原因行以“为什么值得写”或 "Why it is worth writing" 开头
      const m = text.match(/^[\s\S]*?\n\s*(为什么值得写|Why it is worth writing)\s*[:：]?\s*([\s\S]*)$/);
      const title = (m ? text.slice(0, text.indexOf('\n')) : text).replace(/^(选题\s*\d+|Topic\s*\d+)\s*[:：]\s*/, '').trim();
      const reason = m ? m[2].trim() : '';
      if (!title) return;
      const item = document.createElement('div');
      item.className = 'xa-topic';
      const titleEl = document.createElement('div');
      titleEl.className = 'xa-topic-title';
      titleEl.textContent = title;
      item.appendChild(titleEl);
      if (reason) {
        const reasonEl = document.createElement('div');
        reasonEl.className = 'xa-topic-reason';
        reasonEl.textContent = (panelLanguage === 'en' ? 'Why: ' : '为什么值得写：') + reason;
        item.appendChild(reasonEl);
      }
      item.addEventListener('click', () => {
        if (!suggestedTopics.includes(title)) suggestedTopics.push(title);
        selectedHotWords.add(title);
        renderHotwordChips();
        setStatus('trending', '已把「' + title + '」加进热词，选好风格后点“生成文案”。');
        if (els.btnGenTrending) els.btnGenTrending.scrollIntoView({ block: 'nearest' });
      });
      box.appendChild(item);
    });
  }

  // 生成热门文案：用选中的热词 + 选中的风格 + 高互动推文作参考
  async function generateTrending() {
    if (generating) return;
    const topics = [...selectedHotWords];
    const top = trendingContext ? trendingContext.tweets : [];
    if (!topics.length && !top.length) {
      setStatus('trending', '先抓取热门或添加热词，再生成文案', true);
      return;
    }
    generating = true;
    els.btnGenTrending.disabled = true;
    setStatus('trending', '正在生成…');
    let res = null;
    try {
      res = await callGenerate('trending', {
        topics,
        tweets: (top || []).map((t) => ({ text: t.text, likes: t.likes })),
        style: els.trendingStyle ? els.trendingStyle.value : undefined,
        language: panelLanguage,
        hook: panelHook,
        thread: panelThread,
      });
    } catch (e) {
      res = null;
    }
    generating = false;
    els.btnGenTrending.disabled = false;
    if (!res || !res.ok) {
      setStatus('trending', (res && res.error) || FALLBACK_ERROR, true);
      return;
    }
    trendingDrafts = res.results;
    renderDrafts('trending');
    setStatus('trending', (res.model ? '模型：' + res.model + '。' : '') + (panelThread ? '已生成 thread（' + trendingDrafts.length + ' 条），按顺序复制发。' : '已生成，自己复制粘贴到 X 发帖框里发。'));
  }

  // ================= 捕获触发 =================
  // 收到一条新推文：更新面板，打开面板，自动生成回复
  function onTweetCaptured(tweet, auto) {
    currentTweet = tweet;
    renderReplyTweet();
    setPanelOpen(true);
    switchTab('reply');
    if (auto) generateReplies(true);
  }

  // 点击推文：忽略点赞/转发/收藏等操作按钮上的点击，只抓推文本体
  function onDocumentClick(e) {
    if (e.target.closest('[data-testid="like"], [data-testid="retweet"], [data-testid="bookmark"]')) return;
    const article = e.target.closest ? e.target.closest('article[data-testid="tweet"]') : null;
    if (!article) return;
    const tweet = extractTweet(article);
    if (tweet && (tweet.text || (tweet.images && tweet.images.length))) onTweetCaptured(tweet, true);
  }

  // 详情页加载后（SPA 跳转无整页刷新），延迟抓主推文
  function captureDetailDelayed() {
    if (!isStatusPage()) return;
    setTimeout(() => {
      if (!isStatusPage()) return;
      const tweet = getDetailMainTweet();
      if (tweet && (tweet.text || (tweet.images && tweet.images.length))) {
        // 只在推文变了时才重新生成
        if (!currentTweet || tweetKey(tweet) !== tweetKey(currentTweet)) {
          onTweetCaptured(tweet, true);
        }
      }
    }, 900);
  }

  // 监听 SPA 路由变化：patch pushState/replaceState + popstate
  function watchUrlChanges() {
    const origPush = history.pushState.bind(history);
    const origReplace = history.replaceState.bind(history);
    history.pushState = (...args) => { origPush(...args); captureDetailDelayed(); };
    history.replaceState = (...args) => { origReplace(...args); captureDetailDelayed(); };
    window.addEventListener('popstate', captureDetailDelayed);
  }

  // MutationObserver 兜底：详情页异步加载出主推文后补抓一次
  function watchDomChanges() {
    let timer = null;
    const observer = new MutationObserver(() => {
      if (!isStatusPage()) return;
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        if (!isStatusPage()) return;
        const tweet = getDetailMainTweet();
        if (tweet && (tweet.text || (tweet.images && tweet.images.length)) && (!currentTweet || tweetKey(tweet) !== tweetKey(currentTweet))) {
          onTweetCaptured(tweet, true);
        }
      }, 600);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ================= 启动 =================
  buildPanel();
  document.addEventListener('click', onDocumentClick, true);
  watchUrlChanges();
  watchDomChanges();
  // 直接打开就是推文详情页的情况
  captureDetailDelayed();
})();
