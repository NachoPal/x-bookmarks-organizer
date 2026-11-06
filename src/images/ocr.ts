/**
 * Read the text in posts' images: download each pending photo, hand a batch
 * to the local recognizer, store what it read on the `post_media` row.
 *
 * Idempotent and resumable by construction - the queue is the rows still
 * `pending` (or `failed` under {@link OCR_MAX_ATTEMPTS}), and every image's
 * result is written as soon as it is known - so an interrupted pass simply
 * continues next time, and a second pass over a finished library does
 * nothing. It never throws for an image: a download or recognition failure is
 * that image's `failed` status, never the caller's problem.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Database } from '../db/database';
import type { StoredPostMedia } from '../types';
import { ocrImageUrl, type ImageFetcher } from './fetch-image';
import { NO_RECOGNIZER_MESSAGE, type TextRecognizer } from './recognizer';

/** A failed image is retried on later passes up to this many attempts in all. */
export const OCR_MAX_ATTEMPTS = 3;
/** Images per recognizer call (one `osascript` process reads a whole batch). */
const BATCH_SIZE = 4;
/** Batches in flight at once: enough to overlap downloads with recognition, not enough to load the machine. */
const DEFAULT_CONCURRENCY = 2;
/** What is stored per image. A dense screenshot of a document is a few thousand characters. */
export const MAX_OCR_TEXT_CHARS = 10_000;

export type OcrStore = Pick<Database, 'getOcrQueue' | 'setMediaOcrResult'>;

export interface ImageTextDeps {
  db: OcrStore;
  /** Null when this machine has none - images are then marked `unavailable`. */
  recognizer: TextRecognizer | null;
  fetcher: ImageFetcher;
  concurrency?: number;
  logger?: (message: string) => void;
}

export interface ReadImageTextOptions {
  /** Only these posts' images (a sync reads its new bookmarks' before filing them). */
  postIds?: string[];
  /** Epoch ms after which no new batch is started; what is left stays `pending`. */
  deadline?: number;
  /** Called after each image with how many of this pass's images are settled. */
  onProgress?: (settled: number, total: number) => void;
}

export interface ImageTextSummary {
  /** Images in this pass's queue. */
  total: number;
  /** Read successfully (text may be empty). */
  read: number;
  /** Read and had text in them. */
  withText: number;
  failed: number;
  /** Marked `unavailable` - no recognizer on this machine. */
  unavailable: number;
  /** Left for later because the deadline passed. */
  remaining: number;
}

/** Tidy what a recognizer returned: trimmed lines, no runs of blank lines, bounded. */
export function cleanOcrText(raw: string): string {
  const text = raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > MAX_OCR_TEXT_CHARS ? text.slice(0, MAX_OCR_TEXT_CHARS) : text;
}

function extensionFor(contentType: string): string {
  if (contentType.includes('png')) return '.png';
  if (contentType.includes('webp')) return '.webp';
  if (contentType.includes('gif')) return '.gif';
  if (contentType.includes('avif')) return '.avif';
  return '.jpg';
}

export async function readImageText(deps: ImageTextDeps, options: ReadImageTextOptions = {}): Promise<ImageTextSummary> {
  const { db, recognizer, fetcher } = deps;
  const queue = db.getOcrQueue({
    limit: 100_000,
    postIds: options.postIds,
    includeUnavailable: recognizer !== null,
    maxAttempts: OCR_MAX_ATTEMPTS,
  });
  const summary: ImageTextSummary = {
    total: queue.length,
    read: 0,
    withText: 0,
    failed: 0,
    unavailable: 0,
    remaining: 0,
  };
  if (queue.length === 0) return summary;

  if (!recognizer) {
    for (const media of queue) {
      if (media.ocrStatus !== 'pending') continue;
      db.setMediaOcrResult(media.postId, media.mediaKey, { status: 'unavailable', error: NO_RECOGNIZER_MESSAGE });
      summary.unavailable++;
    }
    summary.remaining = queue.length - summary.unavailable;
    options.onProgress?.(summary.unavailable, queue.length);
    return summary;
  }

  const batches: StoredPostMedia[][] = [];
  for (let i = 0; i < queue.length; i += BATCH_SIZE) batches.push(queue.slice(i, i + BATCH_SIZE));

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xbo-ocr-'));
  let settled = 0;
  const settle = (n: number) => {
    settled += n;
    options.onProgress?.(settled, queue.length);
  };

  const runBatch = async (batch: StoredPostMedia[], index: number): Promise<void> => {
    const files: { media: StoredPostMedia; file: string }[] = [];
    for (const [i, media] of batch.entries()) {
      const download = await fetcher.fetch(ocrImageUrl(media.url!));
      if (!download.ok) {
        db.setMediaOcrResult(media.postId, media.mediaKey, { status: 'failed', error: download.error });
        summary.failed++;
        settle(1);
        continue;
      }
      const file = path.join(dir, `${index}-${i}${extensionFor(download.contentType)}`);
      await fs.writeFile(file, download.bytes, { mode: 0o600 });
      files.push({ media, file });
    }
    if (files.length === 0) return;
    try {
      const results = await recognizer.recognize(files.map((f) => f.file));
      files.forEach(({ media }, i) => {
        const result = results[i] ?? { ok: false as const, error: 'The text recognizer returned no answer.' };
        if (result.ok) {
          const text = cleanOcrText(result.text);
          db.setMediaOcrResult(media.postId, media.mediaKey, { status: 'done', text });
          summary.read++;
          if (text) summary.withText++;
        } else {
          db.setMediaOcrResult(media.postId, media.mediaKey, { status: 'failed', error: result.error.slice(0, 300) });
          summary.failed++;
        }
      });
      settle(files.length);
    } finally {
      await Promise.all(files.map((f) => fs.rm(f.file, { force: true })));
    }
  };

  let next = 0;
  const worker = async () => {
    for (;;) {
      if (options.deadline !== undefined && Date.now() >= options.deadline) return;
      const index = next++;
      const batch = batches[index];
      if (!batch) return;
      await runBatch(batch, index);
    }
  };
  try {
    const concurrency = Math.max(1, deps.concurrency ?? DEFAULT_CONCURRENCY);
    await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
  summary.remaining = queue.length - summary.read - summary.failed;
  if (summary.read + summary.failed > 0) {
    deps.logger?.(
      `Read the text in ${summary.read} image(s)${summary.withText ? ` (${summary.withText} with text)` : ''}` +
        `${summary.failed ? `; ${summary.failed} could not be read` : ''}${
          summary.remaining ? `; ${summary.remaining} left for later` : ''
        }.`,
    );
  }
  return summary;
}
