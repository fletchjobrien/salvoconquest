// Scans public/audio/voice for recordings and writes manifest.json.
// File layout: [<faction>/]<category>/<event>_<n>.<mp3|ogg|wav|m4a|webm>
import { readdirSync, statSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, relative, extname, basename, dirname } from 'node:path';

const root = 'public/audio/voice';
if (!existsSync(root)) mkdirSync(root, { recursive: true });
const exts = new Set(['.mp3', '.ogg', '.wav', '.m4a', '.webm']);
const manifest = {};

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (exts.has(extname(name).toLowerCase())) {
      const rel = relative(root, p).split('\\').join('/');
      const event = basename(name, extname(name)).replace(/[_-]?\d+$/, '');
      const key = `${dirname(rel)}/${event}`;
      (manifest[key] ??= []).push(rel);
    }
  }
}
walk(root);
for (const k of Object.keys(manifest)) manifest[k].sort();
writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`voice manifest: ${Object.keys(manifest).length} events, ${Object.values(manifest).flat().length} files`);
