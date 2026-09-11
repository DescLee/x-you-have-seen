import { search } from './db';
import { type SearchQuery } from './model';
let latest = 0;
self.onmessage = async (event: MessageEvent<{ id: number; query: SearchQuery }>) => {
  const { id, query } = event.data; latest = id;
  try {
    const result = await search(query, () => latest !== id);
    if (latest === id) self.postMessage({ id, result });
  } catch (error) {
    if (latest === id) self.postMessage({ id, error: error instanceof Error ? error.message : '搜索失败' });
  }
};
