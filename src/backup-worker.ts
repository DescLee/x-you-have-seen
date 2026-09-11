import { exportBackup } from './db';
// Large JSON parsing/stringifying stays off the page's UI thread.
self.onmessage = async (event: MessageEvent<{ type: 'export' | 'parse'; file?: File }>) => {
  try {
    if (event.data.type === 'export') self.postMessage({ ok: true, ...await exportBackup() });
    else {
      let backup: unknown;
      try { backup = JSON.parse(await event.data.file!.text()); } catch { throw new Error('文件不是有效的 JSON，未导入任何记录。'); }
      self.postMessage({ ok: true, backup });
    }
  } catch (error) { self.postMessage({ ok: false, error: error instanceof Error ? error.message : '备份处理失败' }); }
};
