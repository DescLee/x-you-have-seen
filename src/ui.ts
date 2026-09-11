import { DEFAULT_SETTINGS, EMPTY_QUERY, type Settings, type SearchQuery, type SearchResult, type PostSummary } from './model';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id);
const select = (id: string) => $<HTMLSelectElement>(id);
const formatNumber = (n: number) => new Intl.NumberFormat('zh-CN').format(n);
let settings: Settings = DEFAULT_SETTINGS;
let count = 0, requestId = 0, nextCursor: SearchQuery['cursor'];
let cursors: Array<SearchQuery['cursor']> = [undefined];
let currentPage = 0, currentPosts: PostSummary[] = [];
let selected = new Set<string>();
let searchTimer: ReturnType<typeof setTimeout>, refreshTimer: ReturnType<typeof setTimeout>, toastTimer: ReturnType<typeof setTimeout>;
let needsRefresh = false, busy = false;
const worker = new Worker(chrome.runtime.getURL('search-worker.js'), { type: 'module' });

async function rpc<T = Record<string, unknown>>(message: Record<string, unknown>): Promise<T> {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || '扩展连接中断，请重新打开历史页。');
  return response as T;
}
function showError(error: unknown) {
  $('error-text').textContent = error instanceof Error ? error.message : String(error);
  $('error-banner').hidden = false;
}
function toast(message: string) {
  clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6000);
}
function on(id: string, handler: () => unknown) {
  $(id).addEventListener('click', () => { Promise.resolve().then(handler).catch(showError); });
}
async function confirmAction(title: string, description: string, action: string) {
  const dialog = $<HTMLDialogElement>('confirm-dialog');
  if (dialog.open) return false;
  $('confirm-title').textContent = title; $('confirm-description').textContent = description;
  $('confirm-action').textContent = action;
  dialog.returnValue = ''; dialog.showModal();
  return new Promise<boolean>(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true }));
}
function applySettings() {
  if (settings.theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = settings.theme;
  $('pause').setAttribute('aria-checked', String(!settings.paused));
  $('pause').setAttribute('aria-label', settings.paused ? '恢复自动记录' : '暂停自动记录');
  $('pause-label').textContent = settings.paused ? '记录已暂停' : '记录已开启';
  select('setting-dwell').value = String(settings.dwellMs);
  select('setting-retention').value = String(settings.retentionDays);
  select('setting-limit').value = String(settings.maxRecords);
  select('setting-theme').value = settings.theme;
  input('setting-images').checked = settings.showImages;
  input('setting-ads').checked = settings.excludePromoted;
  const welcomeDescription = $('welcome').querySelector('p');
  if (welcomeDescription) welcomeDescription.textContent = `打开或刷新 X，正常浏览即可。帖子至少一半可见并停留 ${settings.dwellMs / 1000} 秒后，会自动出现在这里。`;
}
async function refreshStatus() {
  const status = await rpc<{ settings: Settings; count: number; lastViewedAt?: number; lastCaptureAt?: number; captureError?: string }>({ type: 'status' });
  settings = status.settings; count = status.count; applySettings();
  $('total-count').textContent = formatNumber(count); $('nav-count').textContent = formatNumber(count);
  $('last-capture').textContent = status.lastViewedAt ? relativeDate(status.lastViewedAt) : '还没有';
  $('capture-hint').textContent = settings.paused ? '已暂停，可随时恢复自动记录' : status.lastCaptureAt ? '在 X 正常浏览时自动记住' : '打开或刷新 X，开始你的第一条记录';
  if (status.captureError) showError(status.captureError);
}
function relativeDate(time: number) {
  const delta = Math.max(0, Date.now() - time);
  if (delta < 60000) return '刚刚';
  if (delta < 3600000) return `${Math.floor(delta / 60000)} 分钟前`;
  if (delta < 86400000) return `${Math.floor(delta / 3600000)} 小时前`;
  return new Date(time).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}
function getQuery(): SearchQuery {
  const query: SearchQuery = { ...EMPTY_QUERY, text: input('search').value, author: input('author').value, media: select('media').value as SearchQuery['media'], sort: select('sort').value as SearchQuery['sort'], cursor: cursors[currentPage] };
  const dateRange = select('date-range').value;
  if (dateRange === 'custom') {
    const from = input('date-from').value, to = input('date-to').value;
    query.from = from ? new Date(`${from}T00:00:00`).getTime() : null;
    if (to) { const end = new Date(`${to}T00:00:00`); end.setDate(end.getDate() + 1); query.to = end.getTime() - 1; }
    if (query.from && query.to && query.from > query.to) throw new Error('开始日期不能晚于结束日期。');
  } else if (dateRange !== 'all') {
    const date = new Date(); date.setHours(0, 0, 0, 0);
    if (dateRange !== 'today') date.setDate(date.getDate() - Number(dateRange) + 1);
    query.from = date.getTime();
  }
  return query;
}
function filtered() { return !!(input('search').value || input('author').value || select('media').value || select('date-range').value !== 'all'); }
function runSearch(reset = true) {
  clearTimeout(searchTimer);
  if (reset) { cursors = [undefined]; currentPage = 0; }
  try {
    const query = getQuery();
    const id = ++requestId;
    $('results').setAttribute('aria-busy', 'true'); $('search-state').textContent = '正在查找…';
    $<HTMLButtonElement>('next').disabled = true; $<HTMLButtonElement>('previous').disabled = true;
    $('reset').hidden = !filtered();
    worker.postMessage({ id, query });
  } catch (error) { requestId++; $('results').setAttribute('aria-busy', 'false'); $('search-state').textContent = ''; showError(error); }
}
worker.onmessage = (event: MessageEvent<{ id: number; result?: SearchResult; error?: string }>) => {
  if (event.data.id !== requestId) return;
  $('results').setAttribute('aria-busy', 'false');
  if (event.data.error) { $('search-state').textContent = ''; showError(event.data.error); return; }
  const result = event.data.result!;
  currentPosts = result.posts; nextCursor = result.next;
  $('result-count').textContent = formatNumber(result.matched);
  $('result-title').textContent = filtered() ? '搜索结果' : '全部历史';
  $('search-state').textContent = filtered() ? `${Math.round(result.elapsedMs)} ms` : '';
  renderPosts();
  $('pagination').hidden = currentPage === 0 && !nextCursor;
  $<HTMLButtonElement>('previous').disabled = currentPage === 0;
  $<HTMLButtonElement>('next').disabled = !nextCursor;
  $('page-label').textContent = `第 ${currentPage + 1} 页 · 每页最多 50 条`;
};
worker.onerror = () => showError('搜索进程无法启动，请刷新历史页。');

function textNode(tag: string, text: string, className = '') {
  const el = document.createElement(tag); el.textContent = text; el.className = className; return el;
}
function highlight(el: HTMLElement, text: string) {
  const terms = input('search').value.trim().split(/\s+/).filter(Boolean).sort((a, b) => b.length - a.length);
  // Preserve original Unicode offsets. Fullwidth normalization still matches in the index, but may not highlight.
  if (!terms.length) { el.textContent = text; return; }
  const regex = new RegExp(terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'giu');
  let end = 0;
  for (const match of text.matchAll(regex)) {
    if (match.index! > end) el.append(document.createTextNode(text.slice(end, match.index)));
    el.append(textNode('mark', match[0])); end = match.index! + match[0].length;
  }
  el.append(document.createTextNode(text.slice(end)));
}
function updateSelection() {
  $('selection-bar').hidden = selected.size === 0;
  $('selection-label').textContent = `已选择 ${selected.size} 条`;
}
function dayTitle(time: number) {
  const date = new Date(time); const today = new Date(); today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const key = date.toLocaleDateString('zh-CN');
  const label = time >= today.getTime() ? '今天' : time >= yesterday.getTime() ? '昨天' : date.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
  return { key, label };
}
function renderPosts() {
  const fragment = document.createDocumentFragment(); let previousDay = '';
  for (const post of currentPosts) {
    const day = dayTitle(post.lastViewedAt);
    if (day.key !== previousDay) { const heading = textNode('div', day.label, 'date-heading'); heading.append(textNode('span', day.key)); fragment.append(heading); previousDay = day.key; }
    const article = document.createElement('article'); article.className = 'post'; article.dataset.id = post.id;
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.className = 'post-select'; checkbox.checked = selected.has(post.id); checkbox.setAttribute('aria-label', `选择 ${post.authorName} 的帖子`);
    checkbox.addEventListener('change', () => { if (checkbox.checked) selected.add(post.id); else selected.delete(post.id); updateSelection(); });
    const header = document.createElement('div'); header.className = 'post-header';
    header.append(textNode('span', Array.from(post.authorName)[0]?.toUpperCase() || 'X', 'avatar'));
    const author = document.createElement('div'); author.className = 'author-info';
    const authorName = textNode('span', '', 'author-name'); highlight(authorName, post.authorName);
    author.append(authorName, textNode('span', `@${post.authorHandle}`, 'author-handle'));
    const time = textNode('time', `${new Date(post.lastViewedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })} 看过`, 'post-time');
    time.setAttribute('datetime', new Date(post.lastViewedAt).toISOString());
    time.title = `最后浏览：${new Date(post.lastViewedAt).toLocaleString('zh-CN')}\n首次浏览：${new Date(post.firstViewedAt).toLocaleString('zh-CN')}${post.postedAt ? `\n发布时间：${new Date(post.postedAt).toLocaleString('zh-CN')}` : ''}`;
    header.append(author, time); article.append(checkbox, header);
    const body = textNode('p', '', 'post-text collapsed'); highlight(body, post.text || (post.media === 'text' ? '这条帖子没有可提取的正文。' : '这是一条媒体帖子。'));
    if (post.text || !post.article) article.append(body);
    if (post.article?.cover && post.article.title) {
      const card = document.createElement('div'); card.className = 'article-card';
      const cover = document.createElement('div'); cover.className = 'article-cover';
      const image = document.createElement('img'); image.src = post.article.cover; image.loading = 'lazy'; image.decoding = 'async'; image.referrerPolicy = 'no-referrer'; image.alt = '文章封面图片';
      image.addEventListener('error', () => image.remove(), { once: true });
      const badge = textNode('span', '𝕏 文章', 'article-badge'); cover.append(image, badge);
      const info = document.createElement('div'); info.className = 'article-body'; info.append(textNode('div', post.article.title, 'article-title'));
      if (post.article.description) info.append(textNode('div', post.article.description, 'article-description'));
      card.append(cover, info); article.append(card);
    }
    if (post.text.length > 220 || post.text.split('\n').length > 5) {
      const expand = textNode('button', '显示更多', 'text-button expand-button'); expand.setAttribute('aria-expanded', 'false');
      expand.addEventListener('click', () => { const collapsed = body.classList.toggle('collapsed'); expand.textContent = collapsed ? '显示更多' : '收起'; expand.setAttribute('aria-expanded', String(!collapsed)); }); article.append(expand);
    }
    if (post.quotedText) {
      const quote = document.createElement('div'); quote.className = 'quoted';
      quote.append(textNode('span', '引用内容', 'quoted-label')); const quoteText = textNode('p', ''); highlight(quoteText, post.quotedText); quote.append(quoteText);
      if (post.quotedText.length > 130 || post.quotedText.split('\n').length > 3) {
        const expand = textNode('button', '显示更多引用', 'text-button');
        expand.addEventListener('click', () => { const expanded = quote.classList.toggle('expanded'); expand.textContent = expanded ? '收起引用' : '显示更多引用'; expand.setAttribute('aria-expanded', String(expanded)); }); quote.append(expand);
      }
      article.append(quote);
    }
    if (settings.showImages && post.images.length) {
      const grid = document.createElement('div'); grid.className = 'preview-grid';
      for (const url of post.images) {
        const image = document.createElement('img'); const src = new URL(url); src.searchParams.set('name', 'small');
        image.src = src.href; image.loading = 'lazy'; image.decoding = 'async'; image.referrerPolicy = 'no-referrer'; image.alt = '帖子图片预览';
        image.addEventListener('error', () => { image.remove(); if (!grid.childElementCount) grid.replaceWith(textNode('p', '图片暂时无法访问，已保存的正文仍可阅读。', 'muted')); }, { once: true });
        grid.append(image);
      }
      article.append(grid);
    }
    const footer = document.createElement('div'); footer.className = 'post-footer';
    footer.append(textNode('span', { text: '文字', image: '图片', video: '视频 / GIF' }[post.media], 'media-chip'));
    const views = textNode('span', `看过 ${post.viewCount} 次`, 'view-count'); views.title = '间隔 30 分钟以上再次浏览，计为新的一次。'; footer.append(views);
    const actions = document.createElement('div'); actions.className = 'post-actions';
    const copy = textNode('button', '复制链接', 'text-button');
    copy.addEventListener('click', () => { navigator.clipboard.writeText(post.url).then(() => toast('已复制帖子链接')).catch(() => toast('复制失败，请右键「查看原帖」复制链接。')); });
    const remove = textNode('button', '删除', 'text-button'); remove.setAttribute('aria-label', `删除 ${post.authorName} 的帖子`);
    remove.addEventListener('click', () => { void removePosts([post.id]).catch(showError); });
    const link = document.createElement('a'); link.className = 'open-original'; link.href = post.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = '查看原帖 ↗';
    actions.append(copy, remove, link); footer.append(actions); article.append(footer); fragment.append(article);
  }
  $('results').replaceChildren(fragment);
  $('empty').hidden = currentPosts.length > 0;
  if (!currentPosts.length) {
    $('empty-title').textContent = filtered() ? '暂时没有找到这段记忆。' : settings.paused ? '记录已暂停，随时可以继续。' : '让看过的好内容，有迹可循。';
    $('empty-description').textContent = filtered() ? '试试更短的关键词，或放宽作者与时间筛选。多个关键词需要同时出现；作者填写完整 @用户名。' : settings.paused ? '点击右上角恢复记录，再打开或刷新 X 页面。已有备份也可以在偏好与数据中导入。' : '开启记录后，去 X 正常浏览。你的第一条浏览记忆就会出现在这里。';
    $('go-x').hidden = filtered();
  }
  updateSelection();
}
async function removePosts(ids: string[]) {
  if (!await confirmAction(`删除 ${ids.length} 条浏览历史？`, '只删除本机保存的记录，不影响 X 上的原帖。删除后无法撤销。', '删除记录')) return;
  await rpc({ type: 'delete', ids }); ids.forEach(id => selected.delete(id));
  await refreshStatus(); runSearch(); toast('已删除所选记录');
}
async function saveSettings(change: Partial<Settings>) {
  const response = await rpc<{ settings: Settings }>({ type: 'settings', settings: change });
  settings = response.settings; applySettings(); await refreshStatus(); renderPosts(); toast('偏好已保存');
}
function showView(view: 'history' | 'settings') {
  $('history-view').hidden = view !== 'history'; $('settings-view').hidden = view !== 'settings';
  $('nav-history').classList.toggle('active', view === 'history'); $('nav-settings').classList.toggle('active', view === 'settings');
  $('crumb').textContent = view === 'history' ? '浏览历史' : '偏好与数据';
  history.replaceState(null, '', view === 'settings' ? '?view=settings' : 'history.html');
  window.scrollTo(0, 0);
  if (view === 'settings') void storageEstimate();
}
async function storageEstimate() {
  try {
    const estimate = await navigator.storage.estimate(); const bytes = estimate.usage ?? 0;
    $('storage-size').textContent = bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
    $('storage-detail').textContent = `${formatNumber(count)} / ${formatNumber(settings.maxRecords)} 条；含搜索索引的估算值。`;
  } catch { $('storage-detail').textContent = '浏览器暂未提供空间估算。'; }
}
async function exportBackup() {
  if (busy) return; busy = true;
  try {
    toast('正在准备备份…');
    const { blob, count: exported } = await backupJob<{ blob: Blob; count: number }>({ type: 'export' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `seen-backup-${new Date().toLocaleDateString('sv-SE')}.json`;
    document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast(`已导出 ${formatNumber(exported)} 条记录。请妥善保存备份。`);
  } finally { busy = false; }
}
function backupJob<T>(message: { type: 'export' | 'parse'; file?: File }): Promise<T> {
  return new Promise((resolve, reject) => {
    const job = new Worker(chrome.runtime.getURL('backup-worker.js'), { type: 'module' });
    job.onmessage = event => { job.terminate(); if (event.data.ok) resolve(event.data); else reject(new Error(event.data.error)); };
    job.onerror = () => { job.terminate(); reject(new Error('备份进程无法启动，请刷新历史页。')); };
    job.postMessage(message);
  });
}
async function importBackup() {
  const file = input('import-file').files?.[0]; input('import-file').value = '';
  if (!file || busy) return;
  if (file.size > 50 * 1024 * 1024) throw new Error('备份超过 50 MB，请拆分后再导入。');
  if (!await confirmAction('导入浏览历史？', `将读取「${file.name}」，合并到本机历史。会遵循当前保存时长和 ${formatNumber(settings.maxRecords)} 条上限，超出时清理最早的记录。`, '导入并合并')) return;
  busy = true;
  try {
    toast('正在导入，请保持此页面打开…');
    const { backup } = await backupJob<{ backup: unknown }>({ type: 'parse', file });
    const result = await rpc<{ imported: number; skipped: number; total: number }>({ type: 'import', backup });
    await refreshStatus(); runSearch(); await storageEstimate();
    toast(`已处理 ${formatNumber(result.imported)} 条记录，跳过 ${result.skipped} 条无效或过期记录；合并后保留 ${formatNumber(result.total)} 条。`);
  } finally { busy = false; }
}

on('pause', async () => { const button = $<HTMLButtonElement>('pause'); button.disabled = true; try { await saveSettings({ paused: !settings.paused }); } finally { button.disabled = false; } });
on('nav-history', () => showView('history')); on('back-history', () => showView('history'));
on('nav-settings', () => showView('settings')); on('compact-settings', () => showView($('settings-view').hidden ? 'settings' : 'history'));
on('open-tab', () => chrome.tabs.create({ url: chrome.runtime.getURL(`history.html${$('settings-view').hidden ? '' : '?view=settings'}`) }));
on('dismiss-welcome', () => { $('welcome').hidden = true; localStorage.setItem('seen-welcomed', '1'); });
on('retry', async () => { $('error-banner').hidden = true; await refreshStatus(); runSearch(); });
on('export', exportBackup); on('settings-export', exportBackup);
on('import', () => { if (!busy) input('import-file').click(); });
input('import-file').addEventListener('change', () => { void importBackup().catch(showError); });
on('clear', async () => {
  if (!await confirmAction('清空所有历史并暂停记录？', '此浏览器中所有已保存的帖子会被永久删除，记录功能将暂停。请确认已经导出需要保留的备份。', '清空并暂停')) return;
  await rpc({ type: 'clear' }); selected.clear(); await refreshStatus(); runSearch(); await storageEstimate(); toast('历史已清空，自动记录已暂停。');
});
on('delete-selected', () => removePosts([...selected]));
on('cancel-selection', () => { selected.clear(); renderPosts(); });
on('next', () => { if (nextCursor) { cursors[++currentPage] = nextCursor; selected.clear(); runSearch(false); $('search-form').scrollIntoView({ block: 'start' }); } });
on('previous', () => { if (currentPage > 0) { currentPage--; selected.clear(); runSearch(false); $('search-form').scrollIntoView({ block: 'start' }); } });
on('reset', () => {
  input('search').value = ''; input('author').value = ''; input('date-from').value = ''; input('date-to').value = '';
  select('media').value = ''; select('date-range').value = 'all'; $('custom-dates').hidden = true; $('error-banner').hidden = true; selected.clear(); runSearch();
});
$('search-form').addEventListener('submit', event => { event.preventDefault(); runSearch(); });
for (const id of ['search', 'author']) input(id).addEventListener('input', () => {
  clearTimeout(searchTimer); requestId++; selected.clear(); searchTimer = setTimeout(() => runSearch(), 200);
});
for (const id of ['media', 'sort', 'date-range', 'date-from', 'date-to']) $(id).addEventListener('change', () => {
  $('custom-dates').hidden = select('date-range').value !== 'custom'; selected.clear(); $('error-banner').hidden = true; runSearch();
});
for (const [id, key] of [['setting-dwell', 'dwellMs'], ['setting-retention', 'retentionDays'], ['setting-limit', 'maxRecords']] as const) {
  select(id).addEventListener('change', () => { void (async () => {
    const value = Number(select(id).value);
    if ((key === 'retentionDays' && value && (!settings.retentionDays || value < settings.retentionDays)) || (key === 'maxRecords' && value < settings.maxRecords)) {
      if (!await confirmAction('更新保存规则？', '将立即按新规则清理过期或超出上限的记录。清理无法撤销，建议先导出备份。', '更新并清理')) { applySettings(); return; }
    }
    await saveSettings({ [key]: value }); runSearch(); await storageEstimate();
  })().catch(error => { applySettings(); showError(error); }); });
}
select('setting-theme').addEventListener('change', () => { void saveSettings({ theme: select('setting-theme').value as Settings['theme'] }).catch(showError); });
input('setting-images').addEventListener('change', () => { void saveSettings({ showImages: input('setting-images').checked }).catch(showError); });
input('setting-ads').addEventListener('change', () => { void saveSettings({ excludePromoted: input('setting-ads').checked }).catch(showError); });
on('diagnose', async () => {
  $('diagnosis').textContent = '检查中…';
  const tabs = await chrome.tabs.query({});
  const responses = await Promise.all(tabs.filter(t => t.id).map(async tab => {
    try { return await chrome.tabs.sendMessage(tab.id!, { type: 'health' }); } catch { return null; }
  }));
  const found = responses.filter(Boolean);
  $('diagnosis').textContent = found.length ? found.map((state, index) => `X 标签页 ${index + 1}：${state.paused ? '记录已暂停' : !state.supported ? '此页面不采集（例如私信）' : state.running ? `正在观察 ${state.tracked} 条帖子` : '标签页在后台或窗口未聚焦，已停止采集'}${state.lastError ? `；错误：${state.lastError}` : ''}${state.pending ? `；${state.pending} 条待写入` : ''}`).join('\n') : '没有检测到已加载 Seen 的 X 页面。请打开 https://x.com 或刷新已有的 X 标签页后重试；首次安装和扩展更新后都需要刷新。';
});
document.addEventListener('keydown', event => {
  const editing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement;
  if (event.key === '/' && !editing && !$<HTMLDialogElement>('confirm-dialog').open) { event.preventDefault(); showView('history'); input('search').focus(); }
});
chrome.runtime.onMessage.addListener(message => {
  if (message.type !== 'history-changed') return;
  needsRefresh = true; clearTimeout(refreshTimer);
  if (document.visibilityState === 'visible') refreshTimer = setTimeout(() => {
    needsRefresh = false;
    void refreshStatus().then(() => {
      // Preserve a selected page while the user is reading or deleting. Refresh via navigation/search.
      if (!selected.size && !currentPage) runSearch();
    }).catch(showError);
  }, 600);
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && needsRefresh) { needsRefresh = false; void refreshStatus().then(() => runSearch()).catch(showError); } });
window.addEventListener('pagehide', () => { worker.terminate(); }, { once: true });
$('welcome').hidden = localStorage.getItem('seen-welcomed') === '1';
const params = new URLSearchParams(location.search);
void refreshStatus().then(() => { showView(params.get('view') === 'settings' ? 'settings' : 'history'); runSearch(); }).catch(showError);
