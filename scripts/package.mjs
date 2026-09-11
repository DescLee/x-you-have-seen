import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
await mkdir('release', { recursive: true });
const file = `release/seen-${version}.zip`;
execFileSync('/usr/bin/zip', ['-q', '-r', '-FS', `../${file}`, '.'], { cwd: 'dist' });
await writeFile(`${file}.sha256`, `${createHash('sha256').update(await readFile(file)).digest('hex')}  seen-${version}.zip\n`);
console.log(file);
