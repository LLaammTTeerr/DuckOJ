import { writeFile } from 'node:fs/promises';
import { buildPackage } from './lib/build-package.js';

const dir = process.argv[2];
const out = process.argv[3];
if (!dir || !out) {
  console.error('usage: package-build <package-dir> <output.tar.zst>');
  process.exit(1);
}

try {
  const { archive, files, hash } = await buildPackage(dir);
  await writeFile(out, archive);
  console.log(JSON.stringify({ hash, files: files.length, bytes: archive.length }));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
