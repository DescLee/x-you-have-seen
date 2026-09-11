import Dexie, { type EntityTable } from 'dexie';
import { type Capture, type Post, type Settings, type SearchQuery, type SearchResult, cleanPost, makeGrams, normalize, searchData, summarize, validTime } from './model';

export const db = new Dexie('seen-history') as Dexie & { posts: EntityTable<Post, 'id'> };
db.version(1).stores({ posts: 'id, lastViewedAt, [lastViewedAt+id], authorHandle, *grams' });

export async function saveCaptures(captures: Capture[], settings: Settings): Promise<number> {
  if (settings.paused) return 0;
  let saved = 0;
  await db.transaction('rw', db.posts, async () => {
    for (const capture of captures.slice(0, 30)) {
      const post = cleanPost(capture.post);
      if (!post || !validTime(capture.viewedAt) || typeof capture.eventId !== 'string' || capture.eventId.length > 100) continue;
      const old = await db.posts.get(post.id);
      const dwell = Math.min(300000, Math.max(0, Number(capture.dwellMs) || 0));
      const sameEvent = old?.lastEventId === capture.eventId;
      const addDwell = sameEvent ? Math.max(0, dwell - old.lastEventDwell) : dwell;
      // A refreshed/virtualized timeline is not a new read. Count another visit after 30 minutes.
      const increment = old && capture.viewedAt - old.lastViewedAt >= 30 * 60000 ? 1 : 0;
      const merged = old ? {
        ...post,
        text: post.text.length >= old.text.length ? post.text : old.text,
        quotedText: post.quotedText.length >= old.quotedText.length ? post.quotedText : old.quotedText,
        images: post.images.length ? post.images : old.images,
        media: old.media === 'video' ? 'video' as const : post.media === 'text' ? old.media : post.media,
        article: post.article ?? old.article
      } : post;
      await db.posts.put({
        ...merged, ...searchData(merged), firstViewedAt: old ? Math.min(old.firstViewedAt, capture.viewedAt) : capture.viewedAt,
        lastViewedAt: Math.max(old?.lastViewedAt ?? 0, capture.viewedAt), viewCount: old ? old.viewCount + increment : 1,
        dwellMs: (old?.dwellMs ?? 0) + addDwell,
        lastEventId: capture.eventId, lastEventDwell: dwell
      });
      saved++;
    }
    const overflow = (await db.posts.count()) - settings.maxRecords;
    if (overflow > 0) await db.posts.bulkDelete(await db.posts.orderBy('lastViewedAt').limit(overflow).primaryKeys());
  });
  return saved;
}

export async function prune(settings: Settings) {
  await db.transaction('rw', db.posts, async () => {
    if (settings.retentionDays) await db.posts.where('lastViewedAt').below(Date.now() - settings.retentionDays * 86400000).delete();
    const overflow = await db.posts.count() - settings.maxRecords;
    if (overflow > 0) await db.posts.bulkDelete(await db.posts.orderBy('lastViewedAt').limit(overflow).primaryKeys());
  });
}

export async function search(query: SearchQuery, isCancelled = () => false): Promise<SearchResult> {
  const start = performance.now();
  const terms = normalize(query.text.slice(0, 300)).split(' ').filter(Boolean);
  const author = normalize(query.author).replace(/^@/, '');
  const direction = query.sort === 'oldest' ? 1 : -1;
  const compare = (a: Post, b: Post) => direction * (a.lastViewedAt - b.lastViewedAt || a.id.localeCompare(b.id));
  let collection = db.posts.orderBy('[lastViewedAt+id]');
  if (direction < 0) collection = collection.reverse();
  const grams = [...new Set(terms.flatMap(makeGrams))];
  let ordered = true;
  if (grams.length) {
    // At most three frequency reads: common words should not issue six large index counts.
    const sampled = [...new Set([grams[0], grams[Math.floor(grams.length / 2)], grams.at(-1)!])];
    const counts = await Promise.all(sampled.map(async gram => ({ gram, count: await db.posts.where('grams').equals(gram).count() })));
    counts.sort((a, b) => a.count - b.count);
    collection = db.posts.where('grams').equals(counts[0].gram);
    ordered = false;
  } else if (author) {
    collection = db.posts.where('authorHandle').equals(author);
    ordered = false;
  } else {
    const low = query.from ?? 0, high = query.to ?? Number.MAX_SAFE_INTEGER;
    let lower: [number, string] = [low, ''], upper: [number, string] = [high, '\uffff'];
    let includeLower = true, includeUpper = true;
    if (query.cursor && !terms.length && !query.media && query.cursor.time >= low && query.cursor.time <= high) {
      if (direction < 0) { upper = [query.cursor.time, query.cursor.id]; includeUpper = false; }
      else { lower = [query.cursor.time, query.cursor.id]; includeLower = false; }
    }
    collection = db.posts.where('[lastViewedAt+id]').between(lower, upper, includeLower, includeUpper);
    if (direction < 0) collection = collection.reverse();
  }
  const found: Post[] = []; let matched = 0; let scanned = 0;
  // Ordered, unfiltered browsing can stop at the page boundary. Filtered queries count all matches.
  const quick = ordered && !terms.length && !author && !query.media;
  await collection.until(() => isCancelled() || (quick && found.length >= 51)).each(post => {
    scanned++;
    if (query.from && post.lastViewedAt < query.from || query.to && post.lastViewedAt > query.to) return;
    if ((author && post.authorHandle !== author) || (query.media === 'article' ? !post.article : query.media && post.media !== query.media)) return;
    if (!terms.every(term => post.searchText.includes(term))) return;
    matched++;
    if (query.cursor) {
      const cmp = direction * (post.lastViewedAt - query.cursor.time || post.id.localeCompare(query.cursor.id));
      if (cmp <= 0) return;
    }
    if (found.length >= 51 && compare(post, found[50]) >= 0) return;
    let left = 0, right = found.length;
    while (left < right) { const mid = (left + right) >>> 1; if (compare(found[mid], post) <= 0) left = mid + 1; else right = mid; }
    found.splice(left, 0, post);
    if (found.length > 51) found.pop();
  });
  if (isCancelled()) throw new DOMException('搜索已取消', 'AbortError');
  if (quick) matched = query.from || query.to ? await db.posts.where('lastViewedAt').between(query.from ?? 0, query.to ?? Number.MAX_SAFE_INTEGER, true, true).count() : await db.posts.count();
  const more = found.length > 50; const posts = found.slice(0, 50);
  return { posts: posts.map(summarize), next: more ? { time: posts.at(-1)!.lastViewedAt, id: posts.at(-1)!.id } : undefined, matched, scanned, elapsedMs: performance.now() - start };
}

export async function exportBackup(): Promise<{ blob: Blob; count: number }> {
  const chunks: BlobPart[] = [`{"format":"seen-backup","version":1,"exportedAt":${JSON.stringify(new Date().toISOString())},"posts":[`];
  let count = 0;
  // One readonly transaction gives a consistent snapshot, even if new captures arrive.
  await db.transaction('r', db.posts, async () => {
    let after: string | undefined;
    while (true) {
      const rows = after ? await db.posts.where('id').above(after).limit(250).toArray() : await db.posts.orderBy('id').limit(250).toArray();
      if (!rows.length) break;
      chunks.push(`${count ? ',' : ''}${rows.map(row => JSON.stringify(summarize(row))).join(',')}`);
      count += rows.length; after = rows.at(-1)!.id;
    }
  });
  chunks.push(']}');
  return { blob: new Blob(chunks, { type: 'application/json' }), count };
}

export async function importPosts(input: unknown, settings: Settings) {
  if (!input || typeof input !== 'object' || (input as { format?: string }).format !== 'seen-backup' || (input as { version?: number }).version !== 1 || !Array.isArray((input as { posts?: unknown }).posts)) throw new Error('不是支持的 Seen 备份文件（version 1）。');
  const items = (input as { posts: unknown[] }).posts;
  if (items.length > 50000) throw new Error('单次最多导入 50,000 条记录。');
  let imported = 0, skipped = 0;
  // Validate the whole file before writing; invalid rows are skipped and reported.
  const valid = items.flatMap(item => {
    const post = cleanPost(item); const row = item as Post;
    if (!post || !validTime(row.firstViewedAt) || !validTime(row.lastViewedAt) || row.firstViewedAt > row.lastViewedAt) { skipped++; return []; }
    if (settings.retentionDays && row.lastViewedAt < Date.now() - settings.retentionDays * 86400000) { skipped++; return []; }
    return [{ ...post, ...searchData(post), firstViewedAt: row.firstViewedAt, lastViewedAt: row.lastViewedAt,
      viewCount: Math.min(1000000, Math.max(1, Math.floor(Number(row.viewCount) || 1))), dwellMs: Math.min(1e12, Math.max(0, Number(row.dwellMs) || 0)),
      lastEventId: '', lastEventDwell: 0 }];
  });
  await db.transaction('rw', db.posts, async () => {
    for (let i = 0; i < valid.length; i += 200) {
      const batch = valid.slice(i, i + 200);
      const old = await db.posts.bulkGet(batch.map(p => p.id));
      // Duplicate ids within a backup are also merged safely.
      const merged = new Map<string, Post>();
      batch.forEach((p, n) => {
        const existing = merged.get(p.id) ?? old[n];
        if (existing) {
          const latest = existing.lastViewedAt >= p.lastViewedAt ? existing : p;
          merged.set(p.id, { ...latest, firstViewedAt: Math.min(existing.firstViewedAt, p.firstViewedAt), lastViewedAt: Math.max(existing.lastViewedAt, p.lastViewedAt), viewCount: Math.max(existing.viewCount, p.viewCount), dwellMs: Math.max(existing.dwellMs, p.dwellMs) });
        } else merged.set(p.id, p);
        imported++;
      });
      await db.posts.bulkPut([...merged.values()]);
    }
    const overflow = (await db.posts.count()) - settings.maxRecords;
    if (overflow > 0) await db.posts.bulkDelete(await db.posts.orderBy('lastViewedAt').limit(overflow).primaryKeys());
  });
  return { imported, skipped, total: await db.posts.count() };
}
