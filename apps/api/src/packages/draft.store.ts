import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';

export const DRAFT_STORE = Symbol('DRAFT_STORE');

/**
 * How long a held draft lock may go untouched before a waiter takes it over
 * (D93).
 *
 * The lock is a directory on the shared package volume, so the process that
 * created it can die — a killed worker, a container restart mid-PUT — with
 * nothing left to release it. Without a takeover that draft would be frozen
 * for the rest of its 24 hours, which is the one state nothing recovers from
 * on its own; the same reasoning `read()` applies to an unreadable
 * `meta.json`.
 *
 * Two minutes: comfortably longer than any single PUT (bounded by
 * `PACKAGE_UPLOAD_MAX_BYTES` of already-buffered bytes reaching the disk) and
 * short enough that a setter who met a crash retries rather than gives up.
 */
export const DRAFT_LOCK_STALE_MS = 120_000;

/** How long a waiter blocks for the lock before refusing. */
const DRAFT_LOCK_WAIT_MS = 30_000;

/** How long a waiter sleeps between attempts. */
const DRAFT_LOCK_POLL_MS = 20;

/**
 * What a draft knows about itself, beside its files.
 *
 * Kept in a `meta.json` OUTSIDE the `files/` subdirectory, not inside it:
 * `buildPackage` tars the whole directory it is given, so a meta file sitting
 * among the draft's own files would be packed into the problem's package as
 * an extra entry, changing its hash and shipping the author's user id to
 * every judge that ever materialises it.
 */
export interface DraftMeta {
  /** The problem this draft belongs to. A draft is never portable between problems. */
  problemId: number;
  /** The code as the opening request spelled it — for logs and for nothing else. */
  problemCode: string;
  createdBy: number;
  createdAt: string;
}

export interface DraftStats {
  fileCount: number;
  totalBytes: number;
}

export interface DraftStore {
  create(meta: Omit<DraftMeta, 'createdAt'>, now?: Date): Promise<{ draftId: string; meta: DraftMeta }>;
  read(draftId: string): Promise<DraftMeta | null>;
  /** The directory `buildPackage` is pointed at — the draft's files and nothing else. */
  filesDir(draftId: string): string;
  stats(draftId: string): Promise<DraftStats>;
  putFile(draftId: string, name: string, bytes: Buffer): Promise<void>;
  /** One file's bytes, or `null` if the draft holds no such file. */
  getFile(draftId: string, name: string): Promise<Buffer | null>;
  delete(draftId: string): Promise<void>;
  /** Removes every draft created more than `ttlMs` ago; returns how many. */
  sweep(now: Date, ttlMs: number): Promise<number>;
  /**
   * Runs `fn` with this draft held exclusively against every other worker.
   *
   * The draft's caps are read-modify-write — count the files, decide, write —
   * and the record they read is the filesystem, which every `API_WORKERS`
   * process shares. Without this, two PUTs in flight against one draft both
   * measure the state BEFORE either wrote and both are admitted, so the caps
   * bound a one-file-at-a-time client and nothing else (D93).
   */
  withLock<T>(draftId: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * Whether a draft is past its life, decided from `meta.createdAt` alone.
 *
 * Shared by the sweeper and by every request that resolves a draft, because
 * expiry has to be enforced at ACCESS time and not merely swept: the sweep
 * runs on an interval, so between two ticks an expired draft still has a
 * directory, and a rule that only the sweeper applied would keep accepting
 * files into it for up to an hour after it died.
 *
 * A missing draft, and one whose `createdAt` will not parse, are both
 * expired. A meta nothing can read a date out of can never be shown to be
 * live, and treating "unreadable" as "fresh" would make a corrupt directory
 * immortal — the one state from which nothing recovers on its own.
 */
export function isDraftExpired(meta: DraftMeta | null, now: Date, ttlMs: number): boolean {
  if (meta === null) return true;
  const created = Date.parse(meta.createdAt);
  if (!Number.isFinite(created)) return true;
  return now.getTime() - created > ttlMs;
}

const DRAFT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FILE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Filesystem-backed draft store, rooted at `drafts/` under the package store
 * directory (D87).
 *
 * **The filesystem is the whole record — there is no drafts table.** A draft
 * is bytes on a shared volume by necessity (every `API_WORKERS` process must
 * see the file another worker accepted), so a database row beside it would be
 * a second source of truth for the same object, with a window in which one
 * exists and the other does not. Expiry is decided from `meta.createdAt` at
 * read time and the sweeper only reclaims disk, so a stale directory that
 * outlives its sweep is already unreachable rather than merely untidy.
 *
 * `draftId` and `name` both become path components, so both are re-validated
 * here as well as at the contract boundary — `FilesystemPackageStore`'s
 * reason for re-checking its hash: the caller is the thing most likely to
 * change.
 */
export class FilesystemDraftStore implements DraftStore {
  constructor(private readonly root: string) {}

  private dirFor(draftId: string): string {
    if (!DRAFT_ID_PATTERN.test(draftId)) throw new Error(`invalid draft id: ${draftId}`);
    return join(this.root, draftId);
  }

  filesDir(draftId: string): string {
    return join(this.dirFor(draftId), 'files');
  }

  async create(meta: Omit<DraftMeta, 'createdAt'>, now: Date = new Date()): Promise<{ draftId: string; meta: DraftMeta }> {
    const draftId = randomUUID();
    const full: DraftMeta = { ...meta, createdAt: now.toISOString() };
    await mkdir(this.filesDir(draftId), { recursive: true });
    await writeFile(join(this.dirFor(draftId), 'meta.json'), JSON.stringify(full), 'utf8');
    return { draftId, meta: full };
  }

  async read(draftId: string): Promise<DraftMeta | null> {
    try {
      const text = await readFile(join(this.dirFor(draftId), 'meta.json'), 'utf8');
      return JSON.parse(text) as DraftMeta;
    } catch {
      // A missing, unreadable or unparseable meta file all mean the same
      // thing to every caller: there is no draft here. A half-written meta
      // (a process death between `mkdir` and `writeFile`) is exactly as
      // unusable as an absent one, and answering 404 for it lets the sweeper
      // reclaim it rather than leaving a directory nothing can open or fix.
      return null;
    }
  }

  async stats(draftId: string): Promise<DraftStats> {
    const dir = this.filesDir(draftId);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return { fileCount: 0, totalBytes: 0 };
    }
    let totalBytes = 0;
    for (const name of names) {
      try {
        totalBytes += (await stat(join(dir, name))).size;
      } catch {
        // Raced with a concurrent delete; it contributes nothing.
      }
    }
    return { fileCount: names.length, totalBytes };
  }

  /**
   * Atomic, for `FilesystemPackageStore.put`'s reason: a process death
   * mid-write must not leave a truncated file that `stats` counts and
   * `buildPackage` hashes.
   *
   * The temp file lives one level UP, beside `meta.json`, and deliberately
   * not inside `files/`: `buildPackage` tars everything in the directory it
   * is given, so a `.tmp-…` left behind by a killed worker would be packed
   * into the problem's package — changing its content-addressed hash, and
   * shipping a stray blob to every judge that materialises it. Outside
   * `files/` it is invisible to the build, to `stats`, and to everything but
   * the `rm -r` that eventually reclaims the draft. Same directory tree, so
   * the rename still cannot cross a filesystem boundary; a random suffix, so
   * two concurrent writes of one name never share a temp file.
   */
  async putFile(draftId: string, name: string, bytes: Buffer): Promise<void> {
    if (!FILE_NAME_PATTERN.test(name) || name === '.' || name === '..') {
      throw new Error(`invalid draft file name: ${name}`);
    }
    const dir = this.filesDir(draftId);
    await mkdir(dir, { recursive: true });
    const tempPath = join(this.dirFor(draftId), `.tmp-${randomUUID()}`);
    try {
      await writeFile(tempPath, bytes);
      await rename(tempPath, join(dir, name));
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }
  }

  /**
   * Reads one file back out.
   *
   * The name is re-validated here as well as at the contract boundary, for
   * `putFile`'s reason — it becomes a path component, and this class must be
   * safe to call from anywhere, not only from behind one pipe. An absent
   * file and an unreadable one are both `null`: the caller's answer for
   * either is the same 404, and nothing else can be said about a draft file
   * that will not open.
   */
  async getFile(draftId: string, name: string): Promise<Buffer | null> {
    if (!FILE_NAME_PATTERN.test(name) || name === '.' || name === '..') {
      throw new Error(`invalid draft file name: ${name}`);
    }
    try {
      return await readFile(join(this.filesDir(draftId), name));
    } catch {
      return null;
    }
  }


  /**
   * The lock directory for one draft.
   *
   * Beside `meta.json` and deliberately NOT inside `files/`, for the reason
   * the temp file is: `buildPackage` tars everything in the directory it is
   * given, `stats` counts everything in it, and a lock appearing in either
   * would change the package's content-addressed hash.
   */
  private lockDir(draftId: string): string {
    return join(this.dirFor(draftId), '.lock');
  }

  /**
   * Whether this draft's lock is held by something that could still be
   * alive — present, and younger than {@link DRAFT_LOCK_STALE_MS}.
   *
   * Absent, unreadable, or stale all answer `false`: the sweeper's job is to
   * reclaim disk nothing can reach, and a lock it cannot read is exactly the
   * abandoned state `withLock` itself takes over.
   */
  private async lockedSince(draftId: string, now: Date): Promise<boolean> {
    try {
      return now.getTime() - (await stat(this.lockDir(draftId))).mtimeMs <= DRAFT_LOCK_STALE_MS;
    } catch {
      return false;
    }
  }

  /**
   * `mkdir` of a single directory is atomic and fails `EEXIST` if it is
   * already there — one syscall that both tests and takes the lock, with no
   * window between the two. (A lock FILE opened `wx` would do as well; a
   * directory is used because the draft's own `rm -r` removes it with no
   * special case, and because it can never be mistaken for a draft file.)
   *
   * A lock older than {@link DRAFT_LOCK_STALE_MS} is taken over rather than
   * waited on — see that constant for why. `mtime` rather than a timestamp
   * written inside the directory: `mkdir` sets it, so there is no second
   * write that could be missing when a waiter looks.
   */
  async withLock<T>(draftId: string, fn: () => Promise<T>): Promise<T> {
    const path = this.lockDir(draftId);
    const deadline = Date.now() + DRAFT_LOCK_WAIT_MS;
    for (;;) {
      try {
        await mkdir(path);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        let heldForMs: number;
        try {
          heldForMs = Date.now() - (await stat(path)).mtimeMs;
        } catch {
          // Released between the failed `mkdir` and this `stat`. Retry at
          // once rather than sleeping: the slot is free right now.
          continue;
        }
        if (heldForMs > DRAFT_LOCK_STALE_MS) {
          await rm(path, { recursive: true, force: true });
          continue;
        }
        if (Date.now() > deadline) throw new Error(`draft ${draftId} is busy`);
        await delay(DRAFT_LOCK_POLL_MS);
      }
    }
    try {
      return await fn();
    } finally {
      // `force`, so a takeover that already removed this lock does not turn
      // the release into an error the caller sees instead of its own result.
      await rm(path, { recursive: true, force: true });
    }
  }

  async delete(draftId: string): Promise<void> {
    await rm(this.dirFor(draftId), { recursive: true, force: true });
  }

  async sweep(now: Date, ttlMs: number): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const entry of entries) {
      if (!DRAFT_ID_PATTERN.test(entry)) continue;
      // An unreadable meta is swept too: `read` cannot tell a half-written
      // one from an absent one, and either way nothing can ever open the
      // draft again.
      if (!isDraftExpired(await this.read(entry), now, ttlMs)) continue;
      // ...unless something holds it right now (D93). `delete` is `rm -r` of
      // the whole directory, lock and all, so a draft that crosses its TTL
      // while a build is reading it is yanked out from under `buildPackage`
      // — and the setter gets an `ENOENT` quoted verbatim into a 422, for a
      // build that had already passed the expiry check when it started.
      //
      // SKIPPED, not waited on: this runs hourly over every draft on the
      // volume, and blocking each one for the lock's timeout would let a
      // single held draft stall the whole sweep. The next tick reclaims it,
      // an hour is nothing against a 24-hour TTL, and a lock held past
      // `DRAFT_LOCK_STALE_MS` is not held by anything alive.
      if (await this.lockedSince(entry, now)) continue;
      await this.delete(entry);
      removed += 1;
    }
    return removed;
  }
}
