/**
 * Download a post's image so the local recognizer can read it.
 *
 * The URL comes from the X API, not from post text, but it is still fetched
 * the way every outbound request in this app is: through the host policy
 * (`src/articles/host-policy.ts`) - checked before each hop and enforced again
 * when the socket connects - with redirects walked by hand so every hop is
 * judged, a timeout, and a byte cap counted on what actually arrives. On top
 * of that, only X's own media hosts are fetched at all ({@link X_MEDIA_HOSTS}):
 * an image is never downloaded from anywhere a post could point it.
 */
import { Agent, fetch as undiciFetch } from 'undici';
import {
  USER_AGENT,
  isPrivateAddressRefusal,
  redirectTarget,
  type ArticleFetch,
  type ArticleFetchResponse,
} from '../articles/fetch-article';
import { PRIVATE_ADDRESS_REASON, createHostPolicy, type HostPolicy } from '../articles/host-policy';

/** The hosts X serves post images from. */
export const X_MEDIA_HOSTS: readonly string[] = ['pbs.twimg.com'];

/** A screenshot at X's `large` size is a few hundred kilobytes; this bounds a misbehaving response. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 3;

export type ImageFetchResult = { ok: true; bytes: Buffer; contentType: string } | { ok: false; error: string };

export interface ImageFetcher {
  fetch(url: string): Promise<ImageFetchResult>;
}

export interface HttpImageFetcherOptions {
  /** Defaults to {@link X_MEDIA_HOSTS}; widened only by tests pointing at a local stub server. */
  allowedHosts?: readonly string[];
  hostPolicy?: HostPolicy;
  fetch?: ArticleFetch;
  maxBytes?: number;
  timeoutMs?: number;
}

/**
 * The URL to download for OCR. X's media CDN serves several renditions; the
 * default one is downscaled, which loses small print in a screenshot of a
 * document, so a `pbs.twimg.com/media/...` URL asks for `name=large` (at most
 * 2048px on the long side). Anything else is used as given.
 */
export function ocrImageUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'pbs.twimg.com' && parsed.pathname.startsWith('/media/') && !parsed.searchParams.has('name')) {
      parsed.searchParams.set('name', 'large');
    }
    return parsed.href;
  } catch {
    return url;
  }
}

async function readCappedBytes(res: ArticleFetchResponse, limit: number): Promise<Buffer | null> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

export class HttpImageFetcher implements ImageFetcher {
  private readonly allowedHosts: Set<string>;
  private readonly hostPolicy: HostPolicy;
  private readonly fetchImpl: ArticleFetch;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;

  constructor(options: HttpImageFetcherOptions = {}) {
    this.allowedHosts = new Set((options.allowedHosts ?? X_MEDIA_HOSTS).map((h) => h.toLowerCase()));
    this.hostPolicy = options.hostPolicy ?? createHostPolicy();
    this.fetchImpl = options.fetch ?? (undiciFetch as unknown as ArticleFetch);
    this.maxBytes = options.maxBytes ?? MAX_IMAGE_BYTES;
    this.timeoutMs = options.timeoutMs ?? IMAGE_TIMEOUT_MS;
  }

  async fetch(url: string): Promise<ImageFetchResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const dispatcher = new Agent({ connect: { lookup: this.hostPolicy.lookup } });
    let current = url;
    try {
      for (let hops = 0; ; hops++) {
        const host = hostOf(current);
        if (!host || !this.allowedHosts.has(host)) {
          return { ok: false, error: `Images are only downloaded from X's media servers, not ${host ?? 'this address'}.` };
        }
        const refusal = this.hostPolicy.check(current);
        if (refusal) return { ok: false, error: refusal };

        const res = await this.fetchImpl(current, {
          signal: controller.signal,
          redirect: 'manual',
          headers: { 'User-Agent': USER_AGENT, Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*' },
          dispatcher,
        });
        const next = redirectTarget(res, current);
        if (next) {
          await res.body?.cancel().catch(() => {});
          if (hops >= MAX_REDIRECTS) return { ok: false, error: 'The image redirects too many times.' };
          current = next;
          continue;
        }
        if (!res.ok) {
          await res.body?.cancel().catch(() => {});
          return { ok: false, error: `The image could not be downloaded (HTTP ${res.status}).` };
        }
        const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
        if (contentType && !contentType.startsWith('image/')) {
          await res.body?.cancel().catch(() => {});
          return { ok: false, error: 'The address did not return an image.' };
        }
        const bytes = await readCappedBytes(res, this.maxBytes);
        if (!bytes) return { ok: false, error: 'The image is too large to read.' };
        if (bytes.length === 0) return { ok: false, error: 'The image was empty.' };
        return { ok: true, bytes, contentType: contentType || 'image/jpeg' };
      }
    } catch (err) {
      if (isPrivateAddressRefusal(err)) return { ok: false, error: PRIVATE_ADDRESS_REASON };
      const timedOut = err instanceof Error && err.name === 'AbortError';
      return {
        ok: false,
        error: timedOut ? 'The image took too long to download.' : 'The image could not be downloaded.',
      };
    } finally {
      clearTimeout(timer);
      await dispatcher.destroy().catch(() => {});
    }
  }
}
