// Run a bounded, repeatable browser scenario through the Playwright CLI.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import { homedir } from 'node:os';
const file = process.argv[2];
if (!file) throw new Error('用法：node scripts/run-browser.mjs scripts/qa-capture.js');
const code = await readFile(file, 'utf8');
let output;
try {
  output = execFileSync(process.env.PLAYWRIGHT_CLI ?? `${homedir()}/.codex/skills/playwright/scripts/playwright_cli.sh`, ['-s=seen', 'run-code', code], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
} catch (error) { output = String(error.stdout || error.message); process.exitCode = 1; }
await mkdir('output/playwright', { recursive: true });
await writeFile(`output/playwright/${basename(file, '.js')}.log`, output);
console.log(output.split('### Ran Playwright code')[0]);
if (output.includes('### Error')) process.exitCode = 1;
