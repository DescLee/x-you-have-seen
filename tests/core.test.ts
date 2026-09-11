import 'fake-indexeddb/auto';
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, exportBackup, importPosts, prune, saveCaptures, search } from '../src/db.ts';
import { DEFAULT_SETTINGS, EMPTY_QUERY, cleanPost, safeImage, cleanSettings, type CapturedPost } from '../src/model.ts';
import { enoughVisible, isAllowedPage } from '../src/extract.ts';

const now = Date.now() - 1000;
const make = (id = '1234567890123456789', text = 'Claude Code 多智能体工作流 🧠') : CapturedPost => ({ id, url: `https://x.com/alice/status/${id}`, authorName: 'Alice', authorHandle: 'alice', text, quotedText: '', postedAt: now - 86400000, images: [], media: 'text' });
const capture = (post = make(), viewedAt = now, eventId = 'event-a', dwellMs = 1100) => ({ post, viewedAt, eventId, dwellMs });
beforeEach(async () => { await db.posts.clear(); });
after(async () => { await db.delete(); });

test('只保存停留事件，暂停时不写入，重复消息不累加停留', async () => {
  assert.equal(await saveCaptures([capture()], { ...DEFAULT_SETTINGS, paused: true }), 0);
  await saveCaptures([capture(), capture()], DEFAULT_SETTINGS);
  let row = (await db.posts.get(make().id))!;
  assert.equal(row.viewCount, 1); assert.equal(row.dwellMs, 1100);
  await saveCaptures([capture(make(), now, 'event-a', 4500)], DEFAULT_SETTINGS);
  row = (await db.posts.get(make().id))!; assert.equal(row.dwellMs, 4500);
});
test('并发重复帖子不丢失，30 分钟内去重，较晚访问会增加次数', async () => {
  await Promise.all([saveCaptures([capture(make(), now - 3600000, 'a')], DEFAULT_SETTINGS), saveCaptures([capture(make(), now, 'b')], DEFAULT_SETTINGS)]);
  assert.equal(await db.posts.count(), 1);
  assert.equal((await db.posts.get(make().id))!.viewCount, 2);
  await saveCaptures([capture(make(), now, 'c')], DEFAULT_SETTINGS);
  assert.equal((await db.posts.get(make().id))!.viewCount, 2);
});
test('中文、英文、子串、多关键词、引用、作者、媒体、日期可组合检索', async () => {
  await saveCaptures([
    capture({ ...make(), quotedText: '向量数据库', media: 'image' }),
    capture({ ...make('2234567890123456789', 'claude coding tips'), authorHandle: 'bob' }, now - 86400000, 'b')
  ], DEFAULT_SETTINGS);
  for (const text of ['智能体', 'laude', 'ＣＬＡＵＤＥ', 'Code 智能', '🧠', '向量', 'A']) assert.equal((await search({ ...EMPTY_QUERY, text, author: '@alice' })).posts.length, 1, text);
  assert.equal((await search({ ...EMPTY_QUERY, text: 'claude', media: 'image', from: now - 1000 })).posts.length, 1);
  assert.equal((await search({ ...EMPTY_QUERY, text: 'Claude 不存在' })).posts.length, 0);
  assert.equal((await search({ ...EMPTY_QUERY, author: 'ali' })).posts.length, 0);
});
test('文章帖子保留封面、标题摘要，并可按文章内容搜索', async () => {
  const article = { ...make(), media: 'image' as const, article: {
    cover: 'https://pbs.twimg.com/media/article-cover?format=jpg&name=medium',
    title: 'AI 婚礼视频定制教程', description: '从选题到交付的完整流程。'
  } };
  await saveCaptures([capture(article)], DEFAULT_SETTINGS);
  const saved = (await db.posts.get(article.id))!;
  assert.deepEqual(saved.article, article.article);
  assert.equal((await search({ ...EMPTY_QUERY, text: '婚礼视频' })).posts[0].article?.title, 'AI 婚礼视频定制教程');
  assert.equal((await search({ ...EMPTY_QUERY, media: 'article' })).posts.length, 1);
  assert.equal((await search({ ...EMPTY_QUERY, media: 'video' })).posts.length, 0);
  const unsafe = cleanPost({ ...article, article: { ...article.article, cover: 'https://evil.example/article.jpg' } });
  assert.equal(unsafe?.article, undefined);
});
test('相同时间的稳定分页，无遗漏、无重复；正反序一致', async () => {
  for (let i = 0; i < 120; i += 30) await saveCaptures(Array.from({ length: 30 }, (_, j) => capture(make(String(1000000000 + i + j)), now, String(i + j))), DEFAULT_SETTINGS);
  for (const sort of ['oldest', 'newest'] as const) {
    const ids = []; let cursor;
    do { const page = await search({ ...EMPTY_QUERY, sort, cursor }); assert.ok(page.scanned <= 51); ids.push(...page.posts.map(p => p.id)); cursor = page.next; } while (cursor);
    assert.equal(ids.length, 120); assert.equal(new Set(ids).size, 120);
  }
});
test('快照导出可重新导入，备份不含内部搜索索引', async () => {
  await saveCaptures([capture()], DEFAULT_SETTINGS);
  const { blob, count } = await exportBackup(); const backup = JSON.parse(await blob.text());
  assert.equal(count, 1); assert.equal(backup.posts[0].grams, undefined);
  await db.posts.clear(); await importPosts(backup, DEFAULT_SETTINGS);
  assert.equal((await search({ ...EMPTY_QUERY, text: '智能体' })).posts.length, 1);
});
test('全文索引分页及只含一个汉字的搜索仍正确', async () => {
  for (let i = 0; i < 75; i += 25) await saveCaptures(Array.from({ length: 25 }, (_, j) => capture(make(String(1000000000 + i + j), '帖子 苹果'), now - i - j, String(i + j))), DEFAULT_SETTINGS);
  for (const text of ['苹果', '果']) {
    const first = await search({ ...EMPTY_QUERY, text }); const second = await search({ ...EMPTY_QUERY, text, cursor: first.next });
    assert.equal(first.matched, 75); assert.equal(second.matched, 75);
    assert.equal(new Set([...first.posts, ...second.posts].map(p => p.id)).size, 75);
  }
});
test('DOM 收缩不能用短正文覆盖展开过的长正文', async () => {
  await saveCaptures([capture(make(undefined, '完整正文 '.repeat(100)))], DEFAULT_SETTINGS);
  await saveCaptures([capture(make(undefined, '完整正文 …'), now, 'b')], DEFAULT_SETTINGS);
  assert.equal((await db.posts.get(make().id))!.text, '完整正文 '.repeat(100));
});
test('不可信导入不会引入任意 URL、脚本或跟踪图片；非法记录跳过', async () => {
  const row = { ...make(), url: 'javascript:alert(1)', images: ['https://evil.example/track', 'https://pbs.twimg.com/media/test.jpg'], authorName: '<img onerror=alert(1)>', firstViewedAt: now, lastViewedAt: now, viewCount: 1, dwellMs: 1000 };
  const result = await importPosts({ format: 'seen-backup', version: 1, posts: [row, { ...row, id: 'broken' }] }, DEFAULT_SETTINGS);
  assert.equal(result.imported, 1); assert.equal(result.skipped, 1);
  const saved = (await db.posts.get(make().id))!;
  assert.equal(saved.url, make().url); assert.deepEqual(saved.images, ['https://pbs.twimg.com/media/test.jpg']);
});
test('备份重复导入合并且不重复增加次数，非法文件不更改已有数据', async () => {
  await saveCaptures([capture()], DEFAULT_SETTINGS);
  const row = (await db.posts.toArray())[0];
  const backup = { format: 'seen-backup', version: 1, posts: [row, row] };
  await importPosts(backup, DEFAULT_SETTINGS); await importPosts(backup, DEFAULT_SETTINGS);
  assert.equal(await db.posts.count(), 1); assert.equal((await db.posts.get(row.id))!.viewCount, 1);
  await assert.rejects(importPosts({ format: 'unknown', posts: [] }, DEFAULT_SETTINGS));
  assert.equal(await db.posts.count(), 1);
});
test('保留期限和容量上限淘汰最早记录', async () => {
  await saveCaptures([capture(make('123456'), now - 100 * 86400000), capture(make('123457'), now - 1000, 'b'), capture(make('123458'), now, 'c')], DEFAULT_SETTINGS);
  await prune({ ...DEFAULT_SETTINGS, retentionDays: 30 }); assert.equal(await db.posts.count(), 2);
  await prune({ ...DEFAULT_SETTINGS, maxRecords: 1 }); assert.equal((await db.posts.toArray())[0].id, '123458');
});
test('导入遵守过期规则，取消搜索会中止', async () => {
  await saveCaptures([capture()], DEFAULT_SETTINGS);
  const row = (await db.posts.toArray())[0];
  const result = await importPosts({ format: 'seen-backup', version: 1, posts: [{ ...row, lastViewedAt: now - 100 * 86400000, firstViewedAt: now - 100 * 86400000 }] }, { ...DEFAULT_SETTINGS, retentionDays: 30 });
  assert.equal(result.skipped, 1);
  await assert.rejects(search(EMPTY_QUERY, () => true), { name: 'AbortError' });
});
test('安全边界：排除私信和 Grok，媒体 URL 白名单，设置归一化', () => {
  for (const path of ['/messages', '/messages/123', '/i/chat', '/i/grok', '/settings/privacy']) assert.equal(isAllowedPage(path), false);
  for (const path of ['/home', '/alice/status/123456', '/search']) assert.equal(isAllowedPage(path), true);
  assert.equal(safeImage('https://pbs.twimg.com.evil.example/media/a'), null);
  assert.equal(safeImage('http://pbs.twimg.com/media/a'), null);
  assert.equal(cleanPost({ ...make(), authorHandle: '../script' }), null);
  assert.equal(cleanSettings({ dwellMs: 1 }).dwellMs, 1000);
});
test('50% 可见与长帖按屏幕高度判定，完全移出不触发', () => {
  assert.equal(enoughVisible({ width: 600, height: 400 }, { width: 600, height: 199 }, 1440, 900), false);
  assert.equal(enoughVisible({ width: 600, height: 400 }, { width: 600, height: 200 }, 1440, 900), true);
  assert.equal(enoughVisible({ width: 600, height: 5000 }, { width: 600, height: 700 }, 1440, 900), true);
  assert.equal(enoughVisible({ width: 600, height: 5000 }, { width: 600, height: 0 }, 1440, 900), false);
});
