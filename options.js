// options.js — 设置页逻辑：读 / 写 chrome.storage.sync
// 与 background.js 的 DEFAULT_SETTINGS 保持一致。

const DEFAULT_SETTINGS = {
  provider: 'glm',
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

const $ = (id) => document.getElementById(id);

// 按提供商显示/隐藏对应设置区（只显示当前选中的提供商那一组）
function updateSections() {
  const p = $('provider').value;
  $('section-glm').style.display = p === 'glm' ? '' : 'none';
  $('section-siliconflow').style.display = p === 'siliconflow' ? '' : 'none';
  $('section-gemini').style.display = p === 'gemini' ? '' : 'none';
  $('section-claude').style.display = p === 'claude' ? '' : 'none';
}

// 显示版本号（从 manifest 里读，改版本后自动同步）
try {
  const ver = chrome.runtime.getManifest().version;
  const verEl = document.getElementById('version');
  if (verEl) verEl.textContent = '版本 v' + ver;
} catch (e) { /* 忽略 */ }

// 打开设置页时，把已保存的值（没有则用默认值）填进表单
chrome.storage.sync.get(DEFAULT_SETTINGS, (items) => {
  $('provider').value = items.provider;
  $('geminiKey').value = items.geminiKey;
  $('geminiModel').value = items.geminiModel;
  $('claudeKey').value = items.claudeKey;
  $('claudeModel').value = items.claudeModel;
  $('glmKey').value = items.glmKey;
  $('glmModel').value = items.glmModel;
  $('siliconKey').value = items.siliconKey;
  $('siliconModel').value = items.siliconModel;
  $('count').value = items.count;
  $('domain').value = items.domain;
  $('style').value = items.style;
  updateSections();
});

$('provider').addEventListener('change', updateSections);

$('save').addEventListener('click', () => {
  const count = Math.min(5, Math.max(1, parseInt($('count').value, 10) || 3));
  chrome.storage.sync.set({
    provider: $('provider').value,
    geminiKey: $('geminiKey').value.trim(),
    geminiModel: $('geminiModel').value.trim() || DEFAULT_SETTINGS.geminiModel,
    claudeKey: $('claudeKey').value.trim(),
    claudeModel: $('claudeModel').value.trim() || DEFAULT_SETTINGS.claudeModel,
    glmKey: $('glmKey').value.trim(),
    glmModel: $('glmModel').value.trim() || DEFAULT_SETTINGS.glmModel,
    siliconKey: $('siliconKey').value.trim(),
    siliconModel: $('siliconModel').value.trim() || DEFAULT_SETTINGS.siliconModel,
    count,
    domain: $('domain').value.trim() || DEFAULT_SETTINGS.domain,
    style: $('style').value,
  }, () => {
    const saved = $('saved');
    saved.style.display = 'inline';
    setTimeout(() => { saved.style.display = 'none'; }, 2000);
  });
});
