/**
 * The background reader of image text in the viewer (and the CLI's awaited
 * one-shot): owns the recognizer choice and makes sure only one library-wide
 * pass runs at a time.
 *
 * It is deliberately NOT a {@link import('../web/job-runner').JobRunner}: a
 * job slot is what makes a second sync wait, and OCR must never hold a sync
 * up. A sync reads its NEW bookmarks' images itself, time-boxed, before
 * filing them ({@link ImageTextWorker.readFor}); everything else - what a
 * deadline left over, a refresh's images, a retry - is this worker's
 * background pass, kicked after the run and polled by the viewer.
 */
import type { Database } from '../db/database';
import { HttpImageFetcher, type ImageFetcher } from './fetch-image';
import { readImageText, type ImageTextSummary } from './ocr';
import { detectRecognizer, type TextRecognizer } from './recognizer';

export interface ImageTextWorkerDeps {
  db: Database;
  fetcher?: ImageFetcher;
  /** Finds this machine's recognizer. Defaults to {@link detectRecognizer}; tests inject one. */
  detect?: () => Promise<TextRecognizer | null>;
  concurrency?: number;
  logger?: (message: string) => void;
}

export interface ImageTextWorkerStatus {
  state: 'idle' | 'running' | 'done';
  /** The engine in use; null when none exists here, undefined before the first probe. */
  recognizer?: { id: string; label: string } | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** This pass's progress: images settled of images queued. */
  settled: number;
  total: number;
  /** The last finished pass's outcome. */
  last: ImageTextSummary | null;
}

export class ImageTextWorker {
  private readonly fetcher: ImageFetcher;
  private readonly detect: () => Promise<TextRecognizer | null>;
  private found: TextRecognizer | null | undefined;
  private running: Promise<void> | null = null;
  private again = false;
  private state: ImageTextWorkerStatus = {
    state: 'idle',
    startedAt: null,
    finishedAt: null,
    settled: 0,
    total: 0,
    last: null,
  };

  constructor(private readonly deps: ImageTextWorkerDeps) {
    this.fetcher = deps.fetcher ?? new HttpImageFetcher();
    this.detect = deps.detect ?? (() => detectRecognizer());
  }

  /**
   * The recognizer, probed once and kept when one is found. A miss is probed
   * again next time, so installing Tesseract needs no restart.
   */
  async recognizer(): Promise<TextRecognizer | null> {
    if (this.found) return this.found;
    try {
      this.found = await this.detect();
    } catch {
      this.found = null;
    }
    return this.found;
  }

  status(): ImageTextWorkerStatus {
    const r = this.found;
    return { ...this.state, recognizer: r === undefined ? undefined : r ? { id: r.id, label: r.label } : null };
  }

  isRunning(): boolean {
    return this.running !== null;
  }

  /**
   * Start a library-wide pass in the background, or - when one is already
   * running - make sure another follows it, so images stored mid-pass are
   * not left waiting for the next kick. Never throws, never awaited.
   */
  kick(): void {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = this.loop().finally(() => {
      this.running = null;
    });
  }

  /** Resolves once no pass is running (tests, the CLI). */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  /**
   * Read only `postIds`' images, awaited and bounded by `budgetMs` - what a
   * sync does for its new bookmarks before filing them, so their screenshots
   * inform categorization. Whatever the budget leaves stays `pending` for the
   * background pass. Never throws.
   */
  async readFor(postIds: string[], budgetMs: number): Promise<ImageTextSummary | null> {
    if (postIds.length === 0) return null;
    try {
      return await readImageText(
        {
          db: this.deps.db,
          recognizer: await this.recognizer(),
          fetcher: this.fetcher,
          concurrency: this.deps.concurrency,
          logger: this.deps.logger,
        },
        { postIds, deadline: Date.now() + budgetMs },
      );
    } catch (err) {
      this.deps.logger?.(`Could not read the text in images: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private async loop(): Promise<void> {
    do {
      this.again = false;
      this.state = {
        ...this.state,
        state: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        settled: 0,
        total: 0,
      };
      let last: ImageTextSummary | null = null;
      try {
        last = await readImageText(
          {
            db: this.deps.db,
            recognizer: await this.recognizer(),
            fetcher: this.fetcher,
            concurrency: this.deps.concurrency,
            logger: this.deps.logger,
          },
          {
            onProgress: (settled, total) => {
              this.state = { ...this.state, settled, total };
            },
          },
        );
      } catch (err) {
        this.deps.logger?.(`Could not read the text in images: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.state = {
        ...this.state,
        state: 'done',
        finishedAt: new Date().toISOString(),
        settled: last ? last.total - last.remaining : this.state.settled,
        total: last ? last.total : this.state.total,
        last,
      };
    } while (this.again);
  }
}
