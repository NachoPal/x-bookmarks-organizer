import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../db/database';
import type { PostMedia, RawBookmark } from '../types';
import type { ImageFetcher } from './fetch-image';
import { cleanOcrText, OCR_MAX_ATTEMPTS, readImageText } from './ocr';
import {
  detectRecognizer,
  parseVisionOutput,
  TesseractRecognizer,
  VisionRecognizer,
  type ProcessRunner,
  type TextRecognizer,
} from './recognizer';
import { formatImageText } from './image-text';
import { ImageTextWorker } from './worker';

const WHEN = '2026-10-01T00:00:00.000Z';
const FIXTURE = path.join(__dirname, 'fixtures', 'synthetic-text.png');

const photo = (mediaKey: string): PostMedia => ({
  mediaKey,
  type: 'photo',
  url: `https://pbs.twimg.com/media/${mediaKey}.png`,
  previewImageUrl: null,
  altText: null,
  width: null,
  height: null,
});

const bm = (postId: string, media: PostMedia[]): RawBookmark => ({
  postId,
  authorUsername: 'a',
  authorName: 'A',
  text: 't',
  url: `https://x.com/a/status/${postId}`,
  postCreatedAt: '',
  media,
});

/** Serves bytes for any URL whose key is in `ok`; fails the rest. Records what was asked for. */
function stubFetcher(failing: string[] = []): ImageFetcher & { urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    async fetch(url) {
      urls.push(url);
      if (failing.some((key) => url.includes(key))) return { ok: false, error: 'HTTP 404' };
      return { ok: true, bytes: Buffer.from(`image:${url}`), contentType: 'image/png' };
    },
  };
}

/** Reads the file it is handed (proving the bytes reached disk) and echoes a text per image. */
function stubRecognizer(answer: (content: string) => string | Error = (c) => `TEXT FOR ${c}`): TextRecognizer & { calls: number } {
  const recognizer = {
    id: 'stub',
    label: 'Stub',
    calls: 0,
    async recognize(paths: string[]) {
      recognizer.calls++;
      return paths.map((p) => {
        const out = answer(fs.readFileSync(p, 'utf8'));
        return out instanceof Error ? { ok: false as const, error: out.message } : { ok: true as const, text: out };
      });
    },
  };
  return recognizer;
}

describe('readImageText', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.storeCategorizedBatch([bm('1', [photo('a'), photo('b')]), bm('2', [photo('c')])], () => [], WHEN);
  });
  afterEach(() => db.close());

  const statuses = () =>
    [...db.getMediaForPosts(['1', '2']).values()].flat().map((m) => [m.mediaKey, m.ocrStatus, m.ocrText]);

  it('downloads each pending photo at the large size and stores what the recognizer read', async () => {
    const fetcher = stubFetcher();
    const summary = await readImageText({ db, recognizer: stubRecognizer(), fetcher });
    expect(summary).toMatchObject({ total: 3, read: 3, withText: 3, failed: 0, remaining: 0 });
    expect(fetcher.urls.every((u) => u.endsWith('.png?name=large'))).toBe(true);
    expect(db.getBookmarkImages([db.getBookmarkByPostId('1')!]).get('1')![0]!.ocrText).toBe(
      'TEXT FOR image:https://pbs.twimg.com/media/a.png?name=large',
    );
  });

  it('is idempotent: a second pass finds nothing to do', async () => {
    const recognizer = stubRecognizer();
    await readImageText({ db, recognizer, fetcher: stubFetcher() });
    const calls = recognizer.calls;
    const again = await readImageText({ db, recognizer, fetcher: stubFetcher() });
    expect(again.total).toBe(0);
    expect(recognizer.calls).toBe(calls);
  });

  it('records a failed download or recognition on that image only, and retries it a bounded number of times', async () => {
    const recognizer = stubRecognizer((c) => (c.includes('/b.png') ? new Error('unreadable') : 'ok'));
    const first = await readImageText({ db, recognizer, fetcher: stubFetcher(['/c.png']) });
    expect(first).toMatchObject({ read: 1, failed: 2 });
    expect(statuses()).toEqual([
      ['a', 'done', 'ok'],
      ['b', 'failed', null],
      ['c', 'failed', null],
    ]);
    for (let i = 1; i < OCR_MAX_ATTEMPTS; i++) await readImageText({ db, recognizer, fetcher: stubFetcher(['/c.png']) });
    expect((await readImageText({ db, recognizer, fetcher: stubFetcher() })).total).toBe(0);
  });

  it('marks images unavailable without a recognizer, and reads them once one exists', async () => {
    const none = await readImageText({ db, recognizer: null, fetcher: stubFetcher() });
    expect(none.unavailable).toBe(3);
    expect(statuses().map((s) => s[1])).toEqual(['unavailable', 'unavailable', 'unavailable']);
    const later = await readImageText({ db, recognizer: stubRecognizer(() => ''), fetcher: stubFetcher() });
    expect(later).toMatchObject({ read: 3, withText: 0 });
    expect(statuses().map((s) => s[1])).toEqual(['done', 'done', 'done']);
  });

  it('starts no batch past the deadline, leaving the rest pending for later', async () => {
    const summary = await readImageText(
      { db, recognizer: stubRecognizer(), fetcher: stubFetcher() },
      { deadline: Date.now() - 1 },
    );
    expect(summary).toMatchObject({ total: 3, read: 0, remaining: 3 });
  });

  it('reads only the named posts when asked', async () => {
    const summary = await readImageText({ db, recognizer: stubRecognizer(), fetcher: stubFetcher() }, { postIds: ['2'] });
    expect(summary.total).toBe(1);
  });
});

describe('ImageTextWorker', () => {
  it('runs one background pass at a time and reports progress', async () => {
    const db = new Database(':memory:');
    db.storeCategorizedBatch([bm('1', [photo('a')])], () => [], WHEN);
    const worker = new ImageTextWorker({ db, fetcher: stubFetcher(), detect: async () => stubRecognizer() });
    worker.kick();
    worker.kick(); // folds into a follow-up pass, never a second concurrent one
    expect(worker.isRunning()).toBe(true);
    await worker.idle();
    expect(worker.status()).toMatchObject({ state: 'done', recognizer: { id: 'stub' }, last: { read: 0 } });
    expect(db.getImageStats(OCR_MAX_ATTEMPTS)).toMatchObject({ done: 1, pending: 0 });
    db.close();
  });
});

describe('cleanOcrText and formatImageText', () => {
  it('tidies recognizer output', () => {
    expect(cleanOcrText('  Line one  \r\n\n\n\n  Line\t two ')).toBe('Line one\n\nLine two');
  });

  it('labels each image by where it is and bounds the whole', () => {
    const base = { postId: 'p', position: 0, ocrStatus: 'done' as const, ocrError: null, ocrAttempts: 1, ocrAt: null };
    const text = formatImageText(
      [
        { ...photo('a'), ...base, source: 'post', altText: 'A chart', ocrText: 'Revenue\ngrew' },
        { ...photo('b'), ...base, source: 'post', ocrText: '' },
        { ...photo('c'), ...base, source: 'quoted-post', ocrText: 'Memo' },
      ],
      500,
    );
    expect(text).toBe('[image 1 in the post] alt: A chart text: Revenue grew | [image 1 in the quoted post] text: Memo');
    expect(formatImageText([{ ...photo('a'), ...base, source: 'post', ocrText: 'x'.repeat(50) }], 20)).toHaveLength(20);
    expect(formatImageText([], 100)).toBeNull();
  });
});

describe('recognizers (with a fake process runner)', () => {
  it('parses the Vision helper output, one answer per image', () => {
    expect(parseVisionOutput('OK Hello\nworld\u001e!ERR bad image\n', 3)).toEqual([
      { ok: true, text: 'Hello\nworld' },
      { ok: false, error: 'bad image' },
      { ok: false, error: 'The text recognizer returned no answer for this image.' },
    ]);
  });

  it('runs Vision in one osascript process per batch with the paths as arguments', async () => {
    const calls: string[][] = [];
    const run: ProcessRunner = async (file, args) => {
      calls.push([file, ...args.slice(2)]);
      return { stdout: 'OK one\u001eOK two\n', stderr: '' };
    };
    const results = await new VisionRecognizer(run).recognize(['/tmp/a.png', '/tmp/b.png']);
    expect(calls).toEqual([['osascript', '/tmp/a.png', '/tmp/b.png']]);
    expect(results.map((r) => r.ok && r.text)).toEqual(['one', 'two']);
  });

  it('turns a crashed process into a per-image failure, never a throw', async () => {
    const run: ProcessRunner = async () => {
      throw Object.assign(new Error('exit 1'), { stderr: 'execution error' });
    };
    expect(await new VisionRecognizer(run).recognize(['/a'])).toEqual([
      { ok: false, error: 'macOS text recognition failed: execution error' },
    ]);
    expect(await new TesseractRecognizer(run).recognize(['/a'])).toEqual([{ ok: false, error: 'Tesseract failed: execution error' }]);
  });

  it('prefers Vision on a Mac, falls back to Tesseract, and reports none', async () => {
    const has = (programs: string[]): ProcessRunner => async (file) => {
      if (!programs.includes(file)) throw new Error('ENOENT');
      return { stdout: file === 'osascript' ? 'true\n' : 'tesseract 5', stderr: '' };
    };
    expect((await detectRecognizer({ run: has(['osascript', 'tesseract']), platform: 'darwin' }))?.id).toBe('vision');
    expect((await detectRecognizer({ run: has(['osascript', 'tesseract']), platform: 'linux' }))?.id).toBe('tesseract');
    expect(await detectRecognizer({ run: has([]), platform: 'darwin' })).toBeNull();
  });
});

describe('real OCR on a synthetic screenshot', async () => {
  const recognizer = await detectRecognizer();
  it.skipIf(!recognizer)(`reads the words in the image (${recognizer?.label ?? 'no recognizer here'})`, async () => {
    const [result] = await recognizer!.recognize([FIXTURE]);
    expect(result!.ok).toBe(true);
    const text = result!.ok ? result!.text.toLowerCase() : '';
    expect(text).toContain('zephyrine');
    expect(text).toContain('retention');
  });
});
