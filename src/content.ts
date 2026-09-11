import { DEFAULT_SETTINGS, cleanSettings, type Settings, type Capture } from './model';
import { enoughVisible, extractPost, isAllowedPage, statusLink } from './extract';

(() => {
  // Reloading an unpacked extension leaves old isolated scripts until page refresh.
  const global = globalThis as typeof globalThis & { __seenStop?: () => void; __seenWidget?: HTMLElement; __seenOpen?: () => void };
  global.__seenStop?.();
  type Tracked = { id: string; visible: boolean; since: number; capture?: Capture; sent: boolean };
  const tracked = new Map<Element, Tracked>();
  const remembered = new Map<string, number>();
  const pending = new Map<string, Capture>();
  const dirty = new Set<Node>();
  let settings: Settings = DEFAULT_SETTINGS;
  let widgetThemeUpdate: ((theme: Settings['theme']) => void) | undefined;
  let stopped = false, running = false, inFlight = false, failures = 0;
  let dwellTimer: ReturnType<typeof setTimeout> | undefined;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let scanTimer: ReturnType<typeof setTimeout> | undefined;
  let idleId: number | undefined;
  let observer: IntersectionObserver | undefined;
  let overlayObserver: MutationObserver | undefined;
  let overlayTimer: ReturnType<typeof setInterval> | undefined;
  let historyRefreshTimer: ReturnType<typeof setInterval> | undefined;
  let pathname = location.pathname;
  let lastError = '', captured = 0, scans = 0, mutationBatches = 0;
  let mutationWindow = 0;
  const events = new AbortController();
  const active = () => !stopped && !settings.paused && document.visibilityState === 'visible' && document.hasFocus() && isAllowedPage(location.pathname);
  const clearDwell = () => { clearTimeout(dwellTimer); dwellTimer = undefined; };

  function remember(id: string) {
    remembered.delete(id); remembered.set(id, Date.now());
    if (remembered.size > 2000) remembered.delete(remembered.keys().next().value!);
  }
  function queue(capture: Capture) {
    if (stopped || settings.paused) return;
    if (pending.size >= 100 && !pending.has(capture.eventId)) pending.delete(pending.keys().next().value!);
    pending.set(capture.eventId, { ...capture });
    if (!flushTimer && !inFlight) flushTimer = setTimeout(flush, 400);
  }
  async function flush() {
    clearTimeout(flushTimer); flushTimer = undefined;
    if (stopped || settings.paused || inFlight || !pending.size) return;
    inFlight = true;
    const batch = [...pending.values()].slice(0, 30);
    try {
      const result = await chrome.runtime.sendMessage({ type: 'capture', captures: batch });
      if (!result?.ok) throw new Error(result?.error || '保存失败');
      for (const item of batch) if (pending.get(item.eventId)?.dwellMs === item.dwellMs) pending.delete(item.eventId);
      lastError = ''; failures = 0; captured += result.saved;
    } catch (error) {
      lastError = error instanceof Error ? error.message : '无法连接扩展';
      failures++;
      if (/context invalidated|extension context/i.test(lastError)) stop();
    } finally {
      inFlight = false;
      // Bounded retries; another eligible post/focus event can retry after connectivity recovers.
      if (!stopped && pending.size && failures < 4) flushTimer = setTimeout(flush, failures ? 1000 * 2 ** failures : 400);
    }
  }
  function leave(state: Tracked) {
    if (state.capture && state.since) {
      state.capture.dwellMs = Math.min(300000, performance.now() - state.since);
      queue(state.capture);
    }
    state.visible = false; state.since = 0; state.capture = undefined; state.sent = false;
  }
  function measure(article: Element) {
    // Article cards can be taller than the viewport. Once the cover itself is
    // substantially visible, the user has clearly seen the post's identity;
    // use that region for dwell detection while keeping ordinary posts intact.
    const target = article.querySelector('[data-testid="article-cover-image"]') ?? article;
    const rect = target.getBoundingClientRect();
    const intersection = { width: Math.max(0, Math.min(innerWidth, rect.right) - Math.max(0, rect.left)), height: Math.max(0, Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top)) };
    return enoughVisible(rect, intersection, innerWidth, innerHeight);
  }
  function updateVisibility(article: Element, visible: boolean) {
    const state = tracked.get(article); if (!state) return;
    if (visible && !state.visible) { state.visible = true; state.since = performance.now(); }
    else if (!visible && state.visible) leave(state);
  }
  function scheduleDwell() {
    clearDwell(); if (!active()) return;
    let next = Infinity;
    for (const state of tracked.values()) if (state.visible && !state.sent) next = Math.min(next, settings.dwellMs - (performance.now() - state.since));
    if (next !== Infinity) dwellTimer = setTimeout(checkDwell, Math.max(1, next + 5));
  }
  function checkDwell() {
    dwellTimer = undefined; if (!active()) { reconcile(); return; }
    for (const [article, state] of tracked) {
      if (!state.visible || state.sent || performance.now() - state.since < settings.dwellMs) continue;
      if (!article.isConnected || !measure(article)) { leave(state); continue; }
      const post = extractPost(article, settings.excludePromoted);
      if (!post || post.id !== state.id) { state.sent = true; continue; }
      state.sent = true;
      if (Date.now() - (remembered.get(post.id) ?? 0) < 30 * 60000) continue;
      remember(post.id);
      state.capture = { post, viewedAt: Date.now(), dwellMs: performance.now() - state.since, eventId: crypto.randomUUID() };
      queue(state.capture);
    }
    scheduleDwell();
  }
  function track(article: Element) {
    const link = statusLink(article); const id = link?.pathname.match(/\/status\/(\d+)/)?.[1];
    if (!id) return;
    const existing = tracked.get(article);
    if (existing?.id === id) {
      // "Show more" / media hydration can enrich an already captured post once the DOM settles.
      if (existing.capture) {
        const post = extractPost(article, settings.excludePromoted);
        if (post && (post.text !== existing.capture.post.text || post.images.join() !== existing.capture.post.images.join() || post.media !== existing.capture.post.media || JSON.stringify(post.article) !== JSON.stringify(existing.capture.post.article))) {
          existing.capture.post = post;
          existing.capture.dwellMs = Math.min(300000, performance.now() - existing.since);
          queue(existing.capture);
        }
      }
      return;
    }
    if (existing) leave(existing);
    tracked.set(article, { id, visible: false, since: 0, sent: false });
    observer?.observe(article);
    if (running) updateVisibility(article, measure(article));
  }
  function scan() {
    scanTimer = undefined; idleId = undefined;
    if (!running || stopped) { dirty.clear(); return; }
    scans++;
    for (const [article, state] of tracked) if (!article.isConnected) { leave(state); tracked.delete(article); observer?.unobserve(article); }
    for (const node of dirty) {
      if (!(node instanceof Element) || !node.isConnected) continue;
      const ancestor = node.closest('article[data-testid="tweet"]');
      if (ancestor) track(ancestor);
      else {
        if (node.matches('article[data-testid="tweet"]')) track(node);
        node.querySelectorAll('article[data-testid="tweet"]').forEach(track);
      }
    }
    dirty.clear(); scheduleDwell();
  }
  function scheduleScan() {
    if (scanTimer || idleId !== undefined || !running) return;
    scanTimer = setTimeout(() => {
      scanTimer = undefined;
      idleId = requestIdleCallback(scan, { timeout: 400 });
    }, 120);
  }
  const mutations = new MutationObserver(records => {
    mutationBatches++;
    // X updates counters, video controls and accessibility nodes frequently. Process at most
    // one mutation batch per 180 ms; the idle scan below coalesces the actual DOM work.
    const now = performance.now();
    if (now - mutationWindow < 180) { if (records.length > 80) { dirty.clear(); dirty.add(document.body); scheduleScan(); } return; }
    mutationWindow = now;
    if (records.length > 160) { dirty.clear(); dirty.add(document.body); scheduleScan(); return; }
    if (pathname !== location.pathname) { pathname = location.pathname; reconcile(true); }
    if (!running) return;
    for (const record of records) {
      if (record.type === 'characterData') { if (record.target.parentElement?.closest('[data-testid="tweetText"]')) dirty.add(record.target.parentElement); continue; }
      // Ignore counters, SVG animation and other irrelevant changes inside tweets.
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      if (target?.closest('article[data-testid="tweet"]')) {
        if (target.closest('[data-testid="tweetText"], [data-testid="tweetPhoto"], [data-testid="User-Name"]') || [...record.addedNodes].some(n => n instanceof Element && (n.matches('a, time, [data-testid]') || !!n.querySelector('time, [data-testid="tweetText"]')))) dirty.add(target);
      } else for (const node of record.addedNodes) if (node instanceof Element && !['SVG', 'PATH'].includes(node.tagName.toUpperCase())) dirty.add(node);
      if (record.removedNodes.length && tracked.size) scheduleScan();
    }
    // Bound retained mutation references during large timeline replacements.
    if (dirty.size > 200) { dirty.clear(); dirty.add(document.body); }
    if (dirty.size) scheduleScan();
  });
  function reconcile(force = false) {
    const shouldRun = active();
    if (running === shouldRun && !force) { if (shouldRun && pending.size) void flush(); return; }
    running = shouldRun; clearDwell();
    clearTimeout(scanTimer); scanTimer = undefined;
    if (idleId !== undefined) cancelIdleCallback(idleId); idleId = undefined;
    observer?.disconnect(); mutations.disconnect(); dirty.clear();
    for (const state of tracked.values()) leave(state);
    tracked.clear();
    if (!running) return;
    observer ??= new IntersectionObserver(entries => {
      if (!active()) { reconcile(); return; }
      for (const entry of entries) updateVisibility(entry.target, measure(entry.target));
      scheduleDwell();
    // Three thresholds are enough for the 50% visibility rule and avoid hundreds of
    // callbacks while the user scrolls through a long timeline.
    }, { threshold: [0, 0.5, 1] });
    dirty.add(document.body); scan();
    mutations.observe(document.body, { subtree: true, childList: true, characterData: true });
    if (pending.size) { failures = 0; void flush(); }
  }
  function onStorage(changes: Record<string, chrome.storage.StorageChange>, area: string) {
    if (area !== 'local' || !changes.settings) return;
    settings = cleanSettings(changes.settings.newValue ?? {});
    widgetThemeUpdate?.(settings.theme);
    if (settings.paused) { pending.clear(); clearTimeout(flushTimer); flushTimer = undefined; }
    reconcile(true);
  }
  function onMessage(message: { type?: string }, _sender: chrome.runtime.MessageSender, reply: (response: unknown) => void) {
    if (message.type === 'health') reply({ running, paused: settings.paused, supported: isAllowedPage(location.pathname), tracked: tracked.size, captured, pending: pending.size, lastError, scans, mutationBatches });
  }
  function stop() {
    stopped = true; running = false; clearDwell(); clearTimeout(flushTimer); clearTimeout(scanTimer);
    if (idleId !== undefined) cancelIdleCallback(idleId);
    observer?.disconnect(); overlayObserver?.disconnect(); if (overlayTimer) clearInterval(overlayTimer); if (historyRefreshTimer) clearInterval(historyRefreshTimer); historyRefreshTimer = undefined; mutations.disconnect(); events.abort();
    tracked.clear(); dirty.clear(); pending.clear();
    mutationWindow = 0;
    global.__seenWidget?.remove(); global.__seenWidget = undefined;
    chrome.storage.onChanged.removeListener(onStorage); chrome.runtime.onMessage.removeListener(onMessage);
  }
  function installInlineHistory() {
    // Use a regular light-DOM container for maximum compatibility with X's SPA
    // renderer and browser accessibility tree. Shadow DOM controls can be
    // omitted from AX trees and are occasionally covered during route swaps.
    const host = document.createElement('div');
    host.id = 'seen-history-widget';
    host.setAttribute('role', 'region');
    host.setAttribute('aria-label', 'Seen 浏览历史');
    // Give the host an explicit box so Chromium cannot collapse the fixed
    // control while X is hydrating its SPA root.
    // Keep Seen in the same right-hand vertical rail as X's floating controls.
    // Keep the three controls in X's lower-right rail.  A modest stacking
    // level lets X dialogs/popovers cover this rail when they are open.
    host.style.cssText = 'all:initial;display:block;width:max-content;height:max-content;position:fixed;z-index:900;inset:auto 20px 146px auto;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;pointer-events:auto;';
    // Keep the embedded control accessible to Chromium's accessibility tree and
    // browser automation. The host is extension-owned and contains no page data.
    const root = host;
    root.innerHTML = `<style>
      :host{all:initial}*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}button,input{font:inherit}.toggle{display:grid;place-items:center;width:55px;height:55px;border:1px solid #cfd9de;border-radius:16px;background:#fff;color:#0f1419;padding:0;box-shadow:0 2px 10px #0000001f;cursor:pointer;transition:background .15s,border-color .15s}.toggle:hover{background:#f7f9f9;border-color:#aab8c2}.toggle:active{background:#eff3f4}.toggle:focus-visible{outline:2px solid #1d9bf0;outline-offset:3px}.toggle-icon{display:grid;place-items:center;width:32px;height:32px}.toggle-icon svg{width:32px;height:32px;fill:none;stroke:currentColor;stroke-width:1.85;stroke-linecap:round;stroke-linejoin:round}.panel{display:none;flex-direction:column;width:min(360px,calc(100vw - 24px));height:min(650px,calc(100vh - 36px));margin-bottom:10px;border:1px solid #eff3f4;border-radius:16px;background:#fff;color:#0f1419;box-shadow:0 8px 28px #00000026;overflow:hidden}.panel.open{display:flex}.head{display:flex;align-items:center;justify-content:space-between;padding:16px;border-bottom:1px solid #eff3f4}.head b{font-size:20px;font-weight:700;letter-spacing:-.2px}.close{border:0;background:transparent;font-size:24px;line-height:1;color:#536471;cursor:pointer;width:32px;height:32px;border-radius:999px}.close:hover{background:#eff3f4}.sub{font-size:12px;color:#536471;margin-top:4px}.search{margin:12px 14px 8px;display:flex;align-items:center;border:1px solid #cfd9de;border-radius:999px;padding:9px 13px;gap:8px}.search:focus-within{border-color:#1d9bf0;box-shadow:0 0 0 1px #1d9bf0}.search input{border:0;outline:0;min-width:0;flex:1;font-size:14px;background:transparent;color:#0f1419}.search span{color:#536471;font-size:17px}.meta{display:flex;justify-content:space-between;color:#536471;font-size:12px;padding:0 16px 8px}.list{overflow:auto;padding:0 16px 16px}.card{padding:14px 0;border-top:1px solid #eff3f4}.author{font-size:14px;font-weight:700}.handle{font-weight:400;color:#536471;margin-left:5px}.text{font-size:14px;line-height:1.45;margin:6px 0;color:#0f1419;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-wrap}.foot{display:flex;justify-content:space-between;align-items:center;font-size:12px;color:#536471;gap:8px}.open{color:#1d9bf0;text-decoration:none;white-space:nowrap}.open:hover{text-decoration:underline}.empty{text-align:center;color:#536471;font-size:14px;line-height:1.5;padding:42px 20px}.more{display:block;width:100%;border:1px solid #cfd9de;background:#fff;border-radius:999px;padding:9px;color:#1d9bf0;cursor:pointer;font-weight:600}.more:hover{background:#eff3f4}.error{padding:10px 16px;color:#b00020;font-size:12px;background:#fde8e8}.theme-dark .panel{background:#000;color:#e7e9ea;border-color:#2f3336}.theme-dark .head{border-color:#2f3336}.theme-dark .close{color:#8b98a5}.theme-dark .close:hover,.theme-dark .more:hover{background:#181818}.theme-dark .sub,.theme-dark .meta,.theme-dark .handle,.theme-dark .foot,.theme-dark .empty{color:#8b98a5}.theme-dark .search{border-color:#536471}.theme-dark .search input,.theme-dark .text{color:#e7e9ea}.theme-dark .search span{color:#8b98a5}.theme-dark .card{border-color:#2f3336}.theme-dark .more{background:#000;border-color:#536471;color:#1d9bf0}.theme-dark .toggle{background:#000;color:#e7e9ea;border-color:#2f3336}.theme-dark .toggle:hover{background:#181818}@media(max-width:600px){#seen-history-widget{right:12px!important}.panel{width:calc(100vw - 24px)}}
    </style><div class="panel"><div class="head"><div><b>浏览历史</b><div class="sub">只显示你真正停留过的帖子</div></div><button class="close" aria-label="关闭历史">×</button></div><label class="search"><span>⌕</span><input maxlength="120" placeholder="搜索正文或作者…" aria-label="搜索浏览历史"></label><div class="meta"><span class="count">加载中…</span><span class="hint"></span></div><div class="error" hidden></div><div class="list"><div class="empty">正在读取你的本地历史…</div></div></div><button class="toggle" aria-expanded="false" aria-label="打开浏览历史" title="浏览历史"><span class="toggle-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 2.5-6.2L3 8m0-5v5h5M12 7v5l3 2"/></svg></span></button>`;
    /* X ships global rules for common names such as .open and .text. Keep the
       lightweight DOM for accessibility, but scope the overrides to our host. */
    root.querySelector('style')!.textContent += [
      '#seen-history-widget .panel{color:#0f1419;background:#fff;box-shadow:0 16px 42px rgba(0,0,0,.38),0 2px 12px rgba(0,0,0,.24)!important}',
      '#seen-history-widget .panel.open{display:flex}',
      '#seen-history-widget .panel .text{color:#0f1419;font-size:14px;line-height:1.45;margin:6px 0;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-wrap}',
      '#seen-history-widget .panel,#seen-history-widget .panel *,#seen-history-widget .panel:hover *,#seen-history-widget .panel *:hover{ text-decoration:none!important;text-decoration-line:none!important;-webkit-text-decoration-line:none!important}',
      '#seen-history-widget .panel .open{color:#1d9bf0;text-decoration:none!important;white-space:nowrap}',
      '#seen-history-widget .panel .open:hover{text-decoration:none!important}',
      '#seen-history-widget .panel.theme-dark{background:#000;color:#e7e9ea;border-color:#2f3336}',
      '#seen-history-widget .panel.theme-dark .head{border-color:#2f3336}',
      '#seen-history-widget .panel.theme-dark .close{color:#8b98a5}',
      '#seen-history-widget .panel.theme-dark .close:hover{background:#181818}',
      '#seen-history-widget .panel.theme-dark .sub,#seen-history-widget .panel.theme-dark .meta,#seen-history-widget .panel.theme-dark .handle,#seen-history-widget .panel.theme-dark .foot,#seen-history-widget .panel.theme-dark .empty{color:#8b98a5}',
      '#seen-history-widget .panel.theme-dark .search{border-color:#536471}',
      '#seen-history-widget .panel.theme-dark .search input,#seen-history-widget .panel.theme-dark .text{color:#e7e9ea}',
      '#seen-history-widget .panel.theme-dark .search span{color:#8b98a5}',
      '#seen-history-widget .panel.theme-dark .card{border-color:#2f3336}',
      '#seen-history-widget .panel.theme-dark .more{background:#000;border-color:#536471;color:#1d9bf0}',
      '#seen-history-widget .media-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px;margin:8px 0 10px;max-height:180px;overflow:hidden;border-radius:8px}',
      '#seen-history-widget .media-grid img{display:block;width:100%;height:86px;object-fit:cover;background:#202327;border-radius:4px}',
      '#seen-history-widget .article-card{margin:8px 0 10px;border:1px solid #cfd9de;border-radius:10px;overflow:hidden;background:#f7f9f9}',
      '#seen-history-widget .article-cover{position:relative;aspect-ratio:2.5/1;background:#202327;overflow:hidden}',
      '#seen-history-widget .article-cover img{display:block;width:100%;height:100%;object-fit:cover}',
      '#seen-history-widget .article-badge{position:absolute;left:8px;bottom:8px;padding:3px 7px;border-radius:5px;background:#536471d9;color:#fff;font-size:11px;font-weight:700}',
      '#seen-history-widget .article-body{padding:9px 10px}',
      '#seen-history-widget .article-title{font-size:14px;line-height:1.35;font-weight:700;color:#0f1419;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
      '#seen-history-widget .article-description{margin-top:4px;font-size:12px;line-height:1.4;color:#536471;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-wrap}',
      '#seen-history-widget .panel.theme-dark .article-card{border-color:#536471;background:#16181c}',
      '#seen-history-widget .panel.theme-dark .article-title{color:#e7e9ea}',
      '#seen-history-widget .panel.theme-dark .article-description{color:#8b98a5}',
      '#seen-history-widget .author-link{color:inherit;text-decoration:none!important;font-weight:700}',
      '#seen-history-widget .author-link:hover{color:#1d9bf0;text-decoration:none!important}',
      '#seen-history-widget .post-time{font-weight:400;color:#536471;margin-left:6px}',
      '#seen-history-widget .toggle{display:grid;place-items:center!important;color:#0f1419;background:rgba(255,255,255,.85);border:1px solid rgb(159,181,195);width:55px!important;height:55px!important;border-radius:16px;line-height:0;box-shadow:0 0 15px rgba(101,119,134,.2),0 0 3px 1px rgba(101,119,134,.15)!important}',
      '#seen-history-widget .toggle:hover{background:rgba(255,255,255,.95);border-color:rgb(101,119,134)}',
      '#seen-history-widget .toggle-icon{width:32px;height:32px;display:grid;place-items:center}',
      '#seen-history-widget .toggle-icon svg{width:32px;height:32px;stroke-width:2.15}',
      '#seen-history-widget .panel.theme-dark~.toggle{background:#000;color:#e7e9ea;border-color:#2f3336;box-shadow:0 0 15px rgba(255,255,255,.2),0 0 3px 1px rgba(255,255,255,.15)!important}',
      '#seen-history-widget .panel.theme-dark~.toggle:hover{background:#181818}',
      '#seen-history-widget .panel.docked{position:fixed;left:var(--seen-dock-left);top:8px;width:var(--seen-dock-width);height:calc(100vh - 16px);margin:0;z-index:950;border-radius:14px;}',
      '#seen-history-widget .panel.docked .head,#seen-history-widget .panel.docked .search,#seen-history-widget .panel.docked .filters,#seen-history-widget .panel.docked .meta,#seen-history-widget .panel.docked .error{flex-shrink:0}',
      '#seen-history-widget .panel.docked .list{min-height:0;flex:1;overscroll-behavior:contain}',
      '#seen-history-widget.under-overlay{visibility:hidden;pointer-events:none}',
      '#seen-history-widget .list{scrollbar-width:thin;scrollbar-color:#9aa5ad transparent}',
      '#seen-history-widget .list::-webkit-scrollbar{width:6px}',
      '#seen-history-widget .list::-webkit-scrollbar-track{background:transparent}',
      '#seen-history-widget .list::-webkit-scrollbar-thumb{background:#9aa5ad;border-radius:999px;border:1px solid transparent;background-clip:padding-box}',
      '#seen-history-widget .panel.theme-dark .list{scrollbar-color:#536471 transparent}',
      '#seen-history-widget .panel.theme-dark .list::-webkit-scrollbar-thumb{background:#536471}',
      '#seen-history-widget .filters{display:grid;grid-template-columns:1fr;gap:8px;margin:0 14px 10px}',
      '#seen-history-widget .filter-field{display:flex;flex-direction:column;gap:4px;color:#536471;font-size:11px}',
      '#seen-history-widget .range-field{position:relative}',
      '#seen-history-widget .range-trigger{display:flex;align-items:center;justify-content:space-between;width:100%;min-width:0;border:1px solid #cfd9de;border-radius:8px;padding:8px 10px;background:#fff;color:#536471;font-size:12px;text-align:left;cursor:pointer}',
      '#seen-history-widget .range-trigger:hover,#seen-history-widget .range-trigger[aria-expanded="true"]{border-color:#1d9bf0;box-shadow:0 0 0 1px #1d9bf0}',
      '#seen-history-widget .range-trigger .range-value{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '#seen-history-widget .range-trigger .range-icon{font-size:15px;line-height:1;margin-left:8px}',
      '#seen-history-widget .range-popover{position:absolute;top:calc(100% + 6px);left:0;right:0;z-index:20;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px;padding:10px;border:1px solid #cfd9de;border-radius:10px;background:#fff;box-shadow:0 8px 24px rgba(0,0,0,.2);overflow:hidden}',
      '#seen-history-widget .range-popover[hidden]{display:none}',
      '#seen-history-widget .range-popover label{display:flex;flex-direction:column;gap:4px;min-width:0;color:#536471;font-size:11px}',
      '#seen-history-widget .range-popover input,#seen-history-widget .filters select{width:100%;min-width:0;max-width:100%;box-sizing:border-box;border:1px solid #cfd9de;border-radius:8px;padding:7px 6px;background:#fff;color:#0f1419;font-size:11px}',
      '#seen-history-widget .range-presets{grid-column:1/-1;display:flex;gap:5px;flex-wrap:wrap;padding-top:2px}',
      '#seen-history-widget .range-presets button{border:1px solid #cfd9de;border-radius:999px;padding:4px 8px;background:#fff;color:#536471;font-size:11px;cursor:pointer}',
      '#seen-history-widget .range-presets button:hover{border-color:#1d9bf0;color:#1d9bf0;background:#e8f5fd}',
      '#seen-history-widget .range-actions{grid-column:1/-1;display:flex;justify-content:flex-end;gap:6px;padding-top:3px}',
      '#seen-history-widget .range-actions button{border:1px solid #cfd9de;border-radius:7px;padding:5px 11px;background:#fff;color:#536471;font-size:11px;cursor:pointer}',
      '#seen-history-widget .range-actions .range-apply{border-color:#1d9bf0;background:#1d9bf0;color:#fff}',
      '#seen-history-widget .range-actions .range-apply:hover{background:#168bd2}',
      '#seen-history-widget .range-actions .range-apply:disabled{opacity:.5;cursor:not-allowed}',
      '#seen-history-widget .range-validation{grid-column:1/-1;color:#b00020;font-size:11px}',
      '#seen-history-widget .filters select{grid-column:1/-1}',
      '#seen-history-widget .filter-reset{grid-column:1/-1;color:#1d9bf0;background:transparent;border:0;text-align:left;padding:0;font-size:11px;cursor:pointer}',
      '#seen-history-widget .panel.theme-dark .filter-field,#seen-history-widget .panel.theme-dark .range-popover label{color:#8b98a5}',
      '#seen-history-widget .panel.theme-dark .range-trigger{border-color:#536471;background:#000;color:#8b98a5}',
      '#seen-history-widget .panel.theme-dark .range-trigger:hover,#seen-history-widget .panel.theme-dark .range-trigger[aria-expanded="true"]{border-color:#1d9bf0}',
      '#seen-history-widget .panel.theme-dark .range-popover{border-color:#536471;background:#000}',
      '#seen-history-widget .panel.theme-dark .range-popover input,#seen-history-widget .panel.theme-dark .filters select{border-color:#536471;background:#000;color:#e7e9ea}',
      '#seen-history-widget .panel.theme-dark .range-presets button,#seen-history-widget .panel.theme-dark .range-actions button{border-color:#536471;background:#000;color:#8b98a5}',
      '#seen-history-widget .panel.theme-dark .range-presets button:hover{border-color:#1d9bf0;color:#1d9bf0;background:#071b29}',
      '#seen-history-widget .panel.theme-dark .range-validation{color:#f4212e}',
      '@media(max-width:600px){#seen-history-widget{right:20px!important;bottom:146px!important}#seen-history-widget .panel{height:min(600px,calc(100vh - 104px))}}'
    ].join('');
    root.querySelector('.search')!.insertAdjacentHTML('afterend', '<div class="filters"><div class="filter-field range-field"><span>浏览时间</span><button type="button" class="range-trigger" aria-haspopup="dialog" aria-expanded="false"><span class="range-value">开始日期 - 结束日期</span><span class="range-icon" aria-hidden="true">▣</span></button><div class="range-popover" role="dialog" aria-label="选择浏览时间范围" hidden><label>开始时间<input class="filter-from" type="datetime-local" step="60" aria-label="开始浏览时间"></label><label>结束时间<input class="filter-to" type="datetime-local" step="60" aria-label="结束浏览时间"></label><div class="range-presets" role="group" aria-label="快速选择浏览时间"><button type="button" data-range="today">今天</button><button type="button" data-range="7d">最近 7 天</button><button type="button" data-range="30d">最近 30 天</button></div><div class="range-validation" hidden></div><div class="range-actions"><button type="button" class="range-cancel">取消</button><button type="button" class="range-apply">确定</button></div></div></div><select class="filter-media" aria-label="按内容类型筛选"><option value="">全部内容</option><option value="text">纯文字</option><option value="image">图片</option><option value="video">视频 / GIF</option><option value="article">文章</option></select><button type="button" class="filter-reset" hidden>清除筛选</button></div>');
    document.documentElement.append(host);
    const q = (s: string) => root.querySelector(s) as HTMLElement;
    const panel = q('.panel'), toggle = q('.toggle') as HTMLButtonElement, close = q('.close') as HTMLButtonElement, searchInput = q('.search input') as HTMLInputElement, rangeTrigger = q('.range-trigger') as HTMLButtonElement, rangeValue = q('.range-value'), rangePopover = q('.range-popover'), dateFrom = q('.filter-from') as HTMLInputElement, dateTo = q('.filter-to') as HTMLInputElement, rangeCancel = q('.range-cancel') as HTMLButtonElement, rangeApply = q('.range-apply') as HTMLButtonElement, rangeValidation = q('.range-validation'), rangePresets = root.querySelectorAll<HTMLButtonElement>('.range-presets button'), mediaFilter = q('.filter-media') as HTMLSelectElement, resetFilters = q('.filter-reset') as HTMLButtonElement, list = q('.list'), count = q('.count'), error = q('.error');
    const syncDockedPanel = () => {
      if (!panel.classList.contains('open')) {
        panel.classList.remove('docked');
        return;
      }
      // The right column is rendered by X as a responsive sidebar. Anchor to
      // its search box so the history layer follows layout changes and route
      // transitions instead of relying on a viewport-specific offset.
      const search = document.querySelector<HTMLElement>('[data-testid="sidebarColumn"] [role="search"]') ?? document.querySelector<HTMLElement>('[role="search"]');
      const sidebar = search ?? document.querySelector<HTMLElement>('[data-testid="sidebarColumn"]');
      if (!sidebar) {
        panel.classList.remove('docked');
        return;
      }
      const rect = sidebar.getBoundingClientRect();
      const left = Math.max(0, Math.round(rect.left));
      const width = Math.min(Math.round(rect.width), Math.round(innerWidth - left - 8));
      if (width < 280 || left >= innerWidth - 8) {
        panel.classList.remove('docked');
        return;
      }
      const dockLeft = `${left}px`;
      const dockWidth = `${width}px`;
      if (panel.style.getPropertyValue('--seen-dock-left') !== dockLeft) panel.style.setProperty('--seen-dock-left', dockLeft);
      if (panel.style.getPropertyValue('--seen-dock-width') !== dockWidth) panel.style.setProperty('--seen-dock-width', dockWidth);
      if (!panel.classList.contains('docked')) panel.classList.add('docked');
    };
    const syncOverlayState = () => {
      const hasVisibleOverlay = (selector: string) => [...document.querySelectorAll(selector)].some(element => {
        let node: Element | null = element; let fixed: Element | null = null;
        while (node && node !== document.documentElement) {
          if (getComputedStyle(node).position === 'fixed') { fixed = node; break; }
          node = node.parentElement;
        }
        const ownRect = element.getBoundingClientRect();
        const rect = (fixed ?? element).getBoundingClientRect();
        // Grok's open drawer exposes a wide header node rather than a dialog;
        // the compact closed control remains a 55px square.
        const wideDrawer = ownRect.width > 200 && ownRect.height > 50;
        const largeFixed = rect.width > 300 && rect.height > 120;
        const visibleRect = wideDrawer ? ownRect : rect;
        return (wideDrawer || largeFixed) && visibleRect.top < innerHeight && visibleRect.bottom > 0 && getComputedStyle(element).display !== 'none';
      });
      const dialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].some(element => {
        const rect = element.getBoundingClientRect(); const style = getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 260 && rect.height > 160 && rect.bottom > 0 && rect.top < innerHeight;
      });
      const underOverlay = hasVisibleOverlay('[data-testid="GrokDrawerHeader"], [data-testid="chat-drawer-main"]') || dialog;
      host.classList.toggle('under-overlay', underOverlay);
      host.style.visibility = underOverlay ? 'hidden' : 'visible';
      host.style.pointerEvents = underOverlay ? 'none' : 'auto';
      syncDockedPanel();
    };
    // X mutates classes and inline styles continuously while scrolling. A
    // subtree-wide attribute observer makes every one of those mutations run
    // a full overlay scan and can stall the feed. Structural changes plus the
    // bounded poll below are sufficient to catch drawer and route transitions.
    overlayObserver = new MutationObserver(syncOverlayState);
    overlayObserver.observe(document.documentElement, { subtree: true, childList: true });
    // X opens its drawers by changing internal layout state without always
    // mutating an attribute we can observe; a light poll keeps the layer
    // relationship correct during those transitions.
    overlayTimer = setInterval(syncOverlayState, 250);
    window.addEventListener('resize', syncOverlayState, { signal: events.signal });
    syncOverlayState();
    let timer: ReturnType<typeof setTimeout> | undefined, cursor: { time: number; id: string } | undefined, loading = false, queuedReset = false;
    let statusRefreshInFlight = false;
    let lastRefreshSignature = '';
    let configuredTheme: Settings['theme'] = settings.theme;
    const relative = (time: number) => { const d = Date.now() - time; return d < 60000 ? '刚刚' : d < 3600000 ? `${Math.floor(d / 60000)} 分钟前` : d < 86400000 ? `${Math.floor(d / 3600000)} 小时前` : new Date(time).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }); };
    const fullDateTime = (time: number) => { const date = new Date(time); const pad = (value: number) => String(value).padStart(2, '0'); return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}时${pad(date.getMinutes())}分`; };
    const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
    async function load(reset = true) {
      if (loading) { if (reset) queuedReset = true; return; }
      loading = true; error.hidden = true;
      if (reset) cursor = undefined;
      const from = dateFrom.value ? new Date(dateFrom.value).getTime() : null;
      const to = dateTo.value ? new Date(dateTo.value).getTime() + 59999 : null;
      const query = { text: searchInput.value.trim(), author: '', media: mediaFilter.value, sort: 'newest', from, to, cursor };
      try {
        if (from !== null && to !== null && from > to) throw new Error('开始时间不能晚于结束时间。');
        const response = await chrome.runtime.sendMessage({ type: 'inline-search', query });
        if (!response?.ok) throw new Error(response?.error || '历史读取失败');
        const result = response.posts ? response : response;
        if (reset) list.replaceChildren();
        if (reset && !result.posts.length) list.innerHTML = '<div class="empty">还没有匹配的浏览记忆。<br>试试更短的关键词。</div>';
        for (const post of result.posts) {
          const card = document.createElement('div'); card.className = 'card';
          const images = Array.isArray(post.images) ? post.images.slice(0, 4).filter((url: unknown): url is string => typeof url === 'string') : [];
          const media = images.length ? `<div class="media-grid">${images.map((url: string) => `<img loading="lazy" decoding="async" referrerpolicy="no-referrer" alt="帖子图片预览" src="${escape(url)}">`).join('')}</div>` : '';
          const article = post.article?.cover && post.article.title ? `<div class="article-card"><div class="article-cover"><img loading="lazy" decoding="async" referrerpolicy="no-referrer" alt="文章封面图片" src="${escape(post.article.cover)}"><span class="article-badge">𝕏 文章</span></div><div class="article-body"><div class="article-title">${escape(post.article.title)}</div>${post.article.description ? `<div class="article-description">${escape(post.article.description)}</div>` : ''}</div></div>` : '';
          const text = post.text?.trim() ? `<div class="text">${escape(post.text)}</div>` : '';
          const authorUrl = `https://x.com/${encodeURIComponent(post.authorHandle || '')}`;
          const postedTime = post.postedAt ? `<span class="post-time" title="发布于 ${escape(fullDateTime(post.postedAt))}">· ${relative(post.postedAt)}</span>` : '';
          card.innerHTML = `<div class="author"><a class="author-link" target="_blank" rel="noopener noreferrer" href="${escape(authorUrl)}">${escape(post.authorName)}<span class="handle">@${escape(post.authorHandle)}</span>${postedTime}</a></div>${text}${article}${media}<div class="foot"><span class="view-time" title="浏览于 ${escape(fullDateTime(post.lastViewedAt))}">${relative(post.lastViewedAt)} · 看过 ${post.viewCount} 次</span><a class="open" target="_blank" rel="noopener noreferrer" href="${escape(post.url)}">查看原帖 ↗</a></div>`;
          card.querySelectorAll<HTMLImageElement>('.media-grid img').forEach(image => image.addEventListener('error', () => { image.remove(); const grid = card.querySelector('.media-grid'); if (grid && !grid.childElementCount) grid.remove(); }, { once: true }));
          card.querySelector<HTMLImageElement>('.article-cover img')?.addEventListener('error', event => { (event.currentTarget as HTMLImageElement).remove(); }, { once: true });
          list.append(card);
        }
        cursor = result.next;
        const more = q('.more'); more?.remove();
        if (cursor) { const button = document.createElement('button'); button.className = 'more'; button.textContent = '加载更多'; button.onclick = () => void load(false); list.append(button); }
        count.textContent = `${result.matched} 条记录`; q('.hint').textContent = result.elapsedMs ? `${Math.round(result.elapsedMs)} ms` : '';
      } catch (e) { error.textContent = e instanceof Error ? e.message : '历史读取失败'; error.hidden = false; }
      finally {
        loading = false;
        if (queuedReset) { queuedReset = false; void load(true); }
      }
    }
    const applyTheme = () => {
      const darkMode = configuredTheme === 'dark' || (configuredTheme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
      panel.classList.toggle('theme-dark', darkMode);
    };
    widgetThemeUpdate = theme => { configuredTheme = theme; applyTheme(); };
    const refreshIfChanged = async (force = false) => {
      if (!panel.classList.contains('open') || statusRefreshInFlight) return;
      statusRefreshInFlight = true;
      try {
        const status = await chrome.runtime.sendMessage({ type: 'inline-status' });
        if (!status?.ok) return;
        const signature = `${status.count}:${status.lastViewedAt ?? 0}`;
        if (force || signature !== lastRefreshSignature) {
          lastRefreshSignature = signature;
          void load();
        }
      } finally { statusRefreshInFlight = false; }
    };
    async function open() {
      host.style.bottom = '18px'; panel.classList.add('open'); syncDockedPanel(); toggle.setAttribute('aria-expanded', 'true'); toggle.style.display = 'none'; searchInput.focus({ preventScroll: true });
      const status = await chrome.runtime.sendMessage({ type: 'inline-status' });
      if (!panel.classList.contains('open')) return;
      if (status?.ok) { count.textContent = `${status.count} 条记录`; lastRefreshSignature = `${status.count}:${status.lastViewedAt ?? 0}`; }
      void load();
      clearInterval(historyRefreshTimer);
      historyRefreshTimer = setInterval(() => { void refreshIfChanged(); }, 3000);
    }
    const closePanel = () => { panel.classList.remove('open'); clearInterval(historyRefreshTimer); historyRefreshTimer = undefined; lastRefreshSignature = ''; syncDockedPanel(); host.style.bottom = '146px'; toggle.setAttribute('aria-expanded', 'false'); toggle.style.display = 'grid'; toggle.focus(); };
    toggle.onclick = () => void open(); close.onclick = closePanel;
    document.addEventListener('pointerdown', event => { if (panel.classList.contains('open') && !host.contains(event.target as Node)) closePanel(); }, { capture: true, signal: events.signal });
    close.addEventListener('keydown', event => { if (event.key === 'Escape') close.click(); });
    searchInput.addEventListener('keydown', event => { if (event.key === 'Escape') { searchInput.value = ''; closePanel(); } });
    searchInput.oninput = () => { resetFilters.hidden = !(searchInput.value || dateFrom.value || dateTo.value || mediaFilter.value); clearTimeout(timer); timer = setTimeout(() => void load(), 240); };
    const updateFilters = () => { resetFilters.hidden = !(searchInput.value || dateFrom.value || dateTo.value || mediaFilter.value); clearTimeout(timer); timer = setTimeout(() => void load(), 120); };
    const formatRange = () => { const format = (value: string) => { if (!value) return ''; const date = new Date(value); if (Number.isNaN(date.getTime())) return value.replace('T', ' '); const pad = (part: number) => String(part).padStart(2, '0'); return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`; }; rangeValue.textContent = dateFrom.value || dateTo.value ? `${format(dateFrom.value) || '开始日期'} - ${format(dateTo.value) || '结束日期'}` : '开始日期 - 结束日期'; };
    let rangeSnapshot: { from: string; to: string } | undefined;
    const syncRangeInputs = () => {
      dateFrom.max = dateTo.value || '';
      dateTo.min = dateFrom.value || '';
      const invalid = Boolean(dateFrom.value && dateTo.value && dateFrom.value > dateTo.value);
      rangeValidation.textContent = invalid ? '开始时间不能晚于结束时间' : '';
      rangeValidation.hidden = !invalid;
      dateFrom.setAttribute('aria-invalid', invalid ? 'true' : 'false');
      dateTo.setAttribute('aria-invalid', invalid ? 'true' : 'false');
      rangeApply.disabled = invalid;
    };
    const openRange = () => { rangeSnapshot = { from: dateFrom.value, to: dateTo.value }; rangePopover.hidden = false; rangeTrigger.setAttribute('aria-expanded', 'true'); syncRangeInputs(); dateFrom.focus({ preventScroll: true }); };
    const closeRange = (restore = true) => { rangePopover.hidden = true; rangeTrigger.setAttribute('aria-expanded', 'false'); if (restore && rangeSnapshot) { dateFrom.value = rangeSnapshot.from; dateTo.value = rangeSnapshot.to; formatRange(); } rangeSnapshot = undefined; };
    rangeTrigger.onclick = () => { if (rangePopover.hidden) openRange(); else closeRange(true); };
    dateFrom.oninput = syncRangeInputs; dateTo.oninput = syncRangeInputs; mediaFilter.onchange = updateFilters;
    rangeApply.onclick = () => { syncRangeInputs(); if (rangeApply.disabled) { dateTo.focus({ preventScroll: true }); return; } formatRange(); closeRange(false); updateFilters(); };
    rangeCancel.onclick = () => closeRange(true);
    const localInput = (date: Date) => { const pad = (value: number) => String(value).padStart(2, '0'); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`; };
    rangePresets.forEach(button => { button.onclick = () => { const now = new Date(); const from = new Date(now); const to = new Date(now); if (button.dataset.range === 'today') from.setHours(0, 0, 0, 0); else if (button.dataset.range === '7d') { from.setDate(from.getDate() - 7); from.setHours(0, 0, 0, 0); } else { from.setDate(from.getDate() - 30); from.setHours(0, 0, 0, 0); } to.setHours(23, 59, 0, 0); dateFrom.value = localInput(from); dateTo.value = localInput(to); syncRangeInputs(); }; });
    rangePopover.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); closeRange(true); rangeTrigger.focus({ preventScroll: true }); } else if (event.key === 'Enter' && (event.target === dateFrom || event.target === dateTo)) { event.preventDefault(); rangeApply.click(); } });
    document.addEventListener('pointerdown', event => { const target = event.target as Element; if (!rangePopover.hidden && !rangePopover.contains(target) && !target.closest?.('.range-trigger')) closeRange(true); }, { capture: true, signal: events.signal });
    resetFilters.onclick = () => { searchInput.value = ''; dateFrom.value = ''; dateTo.value = ''; mediaFilter.value = ''; formatRange(); closeRange(false); updateFilters(); searchInput.focus({ preventScroll: true }); };
    chrome.runtime.onMessage.addListener(message => { if (message.type === 'history-changed' && panel.classList.contains('open')) void refreshIfChanged(true); });
    const dark = matchMedia('(prefers-color-scheme: dark)'); dark.addEventListener('change', applyTheme); applyTheme();
    global.__seenWidget = host;
    global.__seenOpen = open;
    chrome.storage.local.get('settings').then(value => { configuredTheme = cleanSettings(value.settings ?? {}).theme; applyTheme(); }).catch(() => {});
  }
  global.__seenStop = stop;
  chrome.storage.onChanged.addListener(onStorage);
  chrome.runtime.onMessage.addListener(onMessage);
  document.addEventListener('visibilitychange', () => reconcile(), { signal: events.signal });
  window.addEventListener('focus', () => reconcile(), { signal: events.signal });
  window.addEventListener('blur', () => reconcile(), { signal: events.signal });
  window.addEventListener('pagehide', () => { reconcile(); void flush(); }, { signal: events.signal });
  window.addEventListener('pageshow', () => reconcile(true), { signal: events.signal });
  window.addEventListener('popstate', () => reconcile(true), { signal: events.signal });
  // Navigation API observes X's pushState routes even while collection is paused on private pages.
  const navigation = (window as unknown as { navigation?: EventTarget }).navigation;
  navigation?.addEventListener('navigatesuccess', () => { pathname = location.pathname; reconcile(true); }, { signal: events.signal });
  chrome.storage.local.get('settings').then(value => { settings = cleanSettings(value.settings ?? {}); reconcile(); }).catch(error => { lastError = String(error); });
  // X can briefly execute document_idle while replacing the root document during a SPA navigation.
  // Retry once the document root is available instead of throwing into the page.
  const install = () => {
    if (!document.documentElement) { setTimeout(install, 300); return; }
    if (!global.__seenWidget) installInlineHistory();
  };
  install();
})();
