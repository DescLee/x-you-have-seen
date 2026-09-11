import { build, context } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await cp('public', 'dist', { recursive: true });
for (const file of ['LICENSE', 'NOTICE']) await cp(file, `dist/${file}`);
const configs = [
  { entryPoints: ['src/background.ts', 'src/ui.ts', 'src/search-worker.ts', 'src/backup-worker.ts'], outdir: 'dist', format: 'esm' },
  { entryPoints: ['src/content.ts'], outfile: 'dist/content.js', format: 'iife' }
].map(config => ({ ...config, bundle: true, target: 'chrome116', minify: true, sourcemap: false, legalComments: 'eof' }));
if (process.argv.includes('--watch')) {
  for (const config of configs) await (await context(config)).watch();
  console.log('正在监听 TypeScript；public 文件变化后请重新运行 build。Chrome 扩展更新后须刷新 X 页面。');
} else {
  for (const config of configs) await build(config);
  console.log('已构建 dist/，可在 Chrome / Edge 中加载。');
}
