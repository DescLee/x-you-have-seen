import { db, saveCaptures, prune, importPosts, search } from './db';
import { cleanSettings, DEFAULT_SETTINGS, summarize, EMPTY_QUERY, type SearchQuery } from './model';

let mutations = Promise.resolve<unknown>(undefined);
const serial = <T>(operation: () => Promise<T>): Promise<T> => {
  const result = mutations.then(operation);
  mutations = result.catch(() => undefined);
  return result;
};
const getSettings = async () => cleanSettings((await chrome.storage.local.get('settings')).settings ?? DEFAULT_SETTINGS);
const notify = () => { void chrome.runtime.sendMessage({ type: 'history-changed' }).catch(() => {}); };
const xPage = (url: string | undefined) => /^https:\/\/(www\.)?(x\.com|twitter\.com)\//.test(url ?? '');
// Some Chromium profiles remember a per-site "on click" access mode for
// unpacked extensions and skip declarative content scripts. Re-inject once a
// matching tab has finished loading so the embedded history control remains
// available after an extension reload or browser restart.
const injectContent = (tabId: number, url?: string) => {
  if (!xPage(url)) return;
  void chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }).catch(error => {
    void chrome.storage.local.set({ injectionError: errorText(error) });
  });
};
chrome.tabs?.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') injectContent(tabId, tab.url);
});
const injectOpenTabs = () => { void chrome.tabs.query({}).then(tabs => { for (const tab of tabs) if (tab.id != null) injectContent(tab.id, tab.url); }).catch(() => {}); };
chrome.runtime.onStartup.addListener(injectOpenTabs);
function errorText(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  return /quota/i.test(text) ? '本机存储空间不足。请先导出备份，再删除部分历史。' : text.slice(0, 300);
}
chrome.runtime.onInstalled.addListener(async details => {
  const settings = await getSettings();
  await chrome.storage.local.set({ settings });
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  await chrome.alarms.create('maintenance', { periodInMinutes: 24 * 60 });
  if (details.reason === 'install') await chrome.tabs.create({ url: chrome.runtime.getURL('history.html?welcome=1') });
});
chrome.runtime.onStartup.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  await chrome.alarms.create('maintenance', { periodInMinutes: 24 * 60 });
  await serial(async () => prune(await getSettings()));
});
chrome.commands.onCommand.addListener(command => {
  if (command === 'open-history') void chrome.tabs.create({ url: chrome.runtime.getURL('history.html') });
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'maintenance') void serial(async () => { await prune(await getSettings()); notify(); }).catch(console.error);
});

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!message || typeof message.type !== 'string' || sender.id !== chrome.runtime.id) return;
  const fromUI = !!sender.url?.startsWith(chrome.runtime.getURL('history.html'));
  const fromX = !!sender.tab && /^https:\/\/(www\.)?(x\.com|twitter\.com)\//.test(sender.url ?? '');
  if (message.type === 'history-changed' || message.type === 'health') return;
  const inlineRead = ['inline-status', 'inline-search'].includes(message.type);
  if (message.type === 'capture' ? !fromX : inlineRead ? !fromX : !fromUI) { reply({ ok: false, error: '来源未授权' }); return; }
  const execute = async () => {
    switch (message.type) {
      case 'capture': {
        if (!Array.isArray(message.captures) || message.captures.length > 30 || JSON.stringify(message.captures).length > 1500000) throw new Error('无效的采集批次');
        const saved = await saveCaptures(message.captures, await getSettings());
        if (saved) { await chrome.storage.local.set({ lastCaptureAt: Date.now(), captureError: '' }); notify(); }
        return { saved };
      }
      case 'status': {
        const settings = await getSettings();
        const [count, latest, meta] = await Promise.all([db.posts.count(), db.posts.orderBy('lastViewedAt').last(), chrome.storage.local.get(['lastCaptureAt', 'captureError'])]);
        return { settings, count, lastViewedAt: latest?.lastViewedAt, ...meta };
      }
      case 'inline-status': {
        const settings = await getSettings();
        const [count, latest] = await Promise.all([db.posts.count(), db.posts.orderBy('lastViewedAt').last()]);
        return { settings, count, lastViewedAt: latest?.lastViewedAt };
      }
      case 'inline-search': {
        const query = message.query as SearchQuery;
        if (!query || typeof query !== 'object') throw new Error('无效的搜索条件');
        return await search({ ...EMPTY_QUERY, ...query, text: String(query.text ?? '').slice(0, 120), author: String(query.author ?? '').slice(0, 16) });
      }
      case 'settings': {
        const settings = cleanSettings({ ...await getSettings(), ...message.settings });
        await chrome.storage.local.set({ settings });
        await prune(settings); notify(); return { settings };
      }
      case 'delete': {
        if (!Array.isArray(message.ids) || message.ids.length > 100 || !message.ids.every((id: unknown) => typeof id === 'string' && /^\d{5,25}$/.test(id))) throw new Error('无效记录');
        await db.posts.bulkDelete(message.ids); notify(); return {};
      }
      case 'clear': {
        await chrome.storage.local.set({ settings: { ...await getSettings(), paused: true } });
        await db.posts.clear();
        await chrome.storage.local.remove(['lastCaptureAt', 'captureError']); notify(); return {};
      }
      case 'import': {
        const result = await importPosts(message.backup, await getSettings()); notify(); return result;
      }
      case 'export-page': {
        const rows = message.after ? await db.posts.where('id').above(String(message.after)).limit(250).toArray() : await db.posts.orderBy('id').limit(250).toArray();
        return { posts: rows.map(summarize), next: rows.length === 250 ? rows.at(-1)!.id : null };
      }
      default: throw new Error('未知操作');
    }
  };
  // Serialize mutations, including settings and clear, to avoid resurrecting deleted data.
  const result = ['status', 'export-page'].includes(message.type) ? execute() : serial(execute);
  result.then(data => reply({ ok: true, ...data })).catch(async error => {
    const text = errorText(error);
    if (message.type === 'capture') await chrome.storage.local.set({ captureError: text });
    reply({ ok: false, error: text });
  });
  return true;
});
