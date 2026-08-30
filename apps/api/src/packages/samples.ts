/**
 * A problem's samples, read out of its published revision's package (D94).
 *
 * Before this, `GET /problems/{code}` modelled no samples at all: the input
 * and the output lived inside the statement's Markdown, as a table, and every
 * machine client — `apps/mcp` most visibly (F20) — scraped them back out of
 * the prose to get them as data. A scraper that knows one table shape returns
 * nothing, silently, for a statement written any other way, and a wrong
 * sample is worse than no sample. The files the judge actually grades against
 * are the authoritative copy, and this is the path to them.
 *
 * Nothing here decides who may see a problem — `ProblemAccessService` has
 * already answered that by the time it calls in. What this file guarantees is
 * narrower and just as important: **only sample files are ever read**. Every
 * other file in a package is jury data.
 */
import { StringDecoder } from 'node:string_decoder';
import { manifestSamples, parseManifest, readArchiveEntries } from '@duckoj/package-format';
import type { ProblemSampleDto } from '@duckoj/contracts';

/**
 * How much of one sample file is inlined into the detail response.
 *
 * 8 KiB is far above any sample a human reads (the largest in this repo is
 * three lines) and far below anything that hurts a page load or a Redis
 * entry. A package is free to mark a megabyte of generated data as a
 * zero-point case; the response is not free to carry it.
 */
export const SAMPLE_FILE_MAX_BYTES = 8192;

/**
 * How many samples are carried at all.
 *
 * The count is derived from the manifest (`points: 0` in a group worth 0), so
 * it is not bounded by anything a setter had to think about: an ICPC-style
 * package that scores nothing anywhere would make every test a sample. Twelve
 * is past any statement's example table and bounds the response at
 * 12 × 2 × 8 KiB.
 */
export const MAX_SAMPLES = 12;

/**
 * The first `limit` bytes of `buffer` as UTF-8, without the U+FFFD a bare
 * `subarray().toString()` leaves when the cut lands mid-character.
 * `StringDecoder` holds an incomplete sequence back instead of guessing.
 */
function decodeCapped(buffer: Buffer, limit: number): { text: string; truncated: boolean } {
  if (buffer.length <= limit) return { text: buffer.toString('utf8'), truncated: false };
  return { text: new StringDecoder('utf8').write(buffer.subarray(0, limit)), truncated: true };
}

/**
 * Reads the samples out of a package archive.
 *
 * The file list comes from `manifestSamples`, which derives it from `tests`
 * and JOINS the manifest's `samples[].explanation` annotations onto it —
 * never the reverse. A stored package predates this schema's validation and
 * its `samples` array is, in the end, a client-supplied field; a reader that
 * opened whatever `samples[]` named would let a manifest nominate any file in
 * the package — a jury answer, a checker's source — as public.
 *
 * A sample whose input or answer is missing from the archive is DROPPED, not
 * reported as an empty example: `findMissingPackageFiles` makes that
 * unreachable for anything uploaded through `POST /packages`, and half a
 * sample would be read by a solver as a sample whose answer is the empty
 * string.
 */
export async function readPackageSamples(archive: Buffer): Promise<ProblemSampleDto[]> {
  const manifestBytes = (await readArchiveEntries(archive, ['manifest.json'])).get('manifest.json');
  if (!manifestBytes) return [];
  const manifest = parseManifest(JSON.parse(manifestBytes.toString('utf8')));

  const wanted = manifestSamples(manifest).slice(0, MAX_SAMPLES);
  if (wanted.length === 0) return [];

  const files = await readArchiveEntries(
    archive,
    wanted.flatMap((sample) => [sample.input, sample.answer]),
  );

  const samples: ProblemSampleDto[] = [];
  for (const sample of wanted) {
    const input = files.get(sample.input);
    const output = files.get(sample.answer);
    if (!input || !output) continue;
    const decodedInput = decodeCapped(input, SAMPLE_FILE_MAX_BYTES);
    const decodedOutput = decodeCapped(output, SAMPLE_FILE_MAX_BYTES);
    samples.push({
      input: decodedInput.text,
      output: decodedOutput.text,
      explanation: sample.explanation,
      truncated: decodedInput.truncated || decodedOutput.truncated,
    });
  }
  return samples;
}

/**
 * One hour. The blob at a hash is immutable — package identity IS its
 * content — so this is a TTL for reclaiming Redis, not for correctness.
 */
export const SAMPLES_CACHE_TTL_MS = 3_600_000;

/**
 * Keyed on the PACKAGE HASH, not on the problem or the revision id.
 *
 * The brief asked for a key per problem+revision invalidated on publish; this
 * is the same thing with the invalidation call deleted, which is
 * `bookletCacheKey`'s precedent (D48) and its reasoning: a revision has
 * exactly one immutable package, so publishing a new revision does not
 * invalidate this entry, it stops addressing it. There is therefore no path
 * on which a publish can forget to invalidate, and two problems built from
 * the same package (a clone, D88) share one entry rather than folding the
 * same archive twice.
 */
export function samplesCacheKey(packageHash: string): string {
  return `duckoj:samples:v1:${packageHash}`;
}
