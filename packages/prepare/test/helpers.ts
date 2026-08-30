/**
 * Fixtures are copied into a temp directory before every test that touches
 * them, so a test can BREAK one — delete an answer, replace the model — and
 * the next test still sees the good version. Each broken case is therefore a
 * named mutation of a readable fixture rather than a fifth near-copy of the
 * same eight files, and the mutation itself is the documentation of what the
 * case is about.
 */
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const created: string[] = [];

export async function cloneFixture(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `prepare-fixture-${name}-`));
  const dest = join(dir, name);
  await cp(join(HERE, 'fixtures', name), dest, { recursive: true });
  created.push(dir);
  return dest;
}

/** A temp directory with nothing in it — for "this is neither layout". */
export async function emptyDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'prepare-empty-'));
  created.push(dir);
  return dir;
}

export async function write(path: string, content: string): Promise<void> {
  await writeFile(path, content);
}

export async function cleanupFixtures(): Promise<void> {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}
