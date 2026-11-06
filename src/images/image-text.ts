/**
 * How a bookmark's image text is put in front of a model: the alt text its
 * author wrote and what OCR read, labelled by where the image is, so a prompt
 * can never mistake a screenshot's words for the post's own.
 */
import type { BookmarkImage } from '../types';

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Whether any of the images carries words - alt text or recognized text. */
export function hasImageText(images: BookmarkImage[] | undefined): boolean {
  return !!images?.some((img) => !!img.altText?.trim() || !!img.ocrText?.trim());
}

/**
 * One bounded, single-line rendering of the images' text, e.g.
 * `[image 1 in the post] alt: A chart. text: Revenue grew 42% | [image 1 in the quoted post] text: ...`.
 * Null when no image has any words. Cut at `maxChars` with an ellipsis.
 */
export function formatImageText(images: BookmarkImage[] | undefined, maxChars: number): string | null {
  if (!images || images.length === 0) return null;
  const counters = { post: 0, 'quoted-post': 0 };
  const parts: string[] = [];
  for (const img of images) {
    counters[img.source]++;
    const alt = img.altText ? oneLine(img.altText) : '';
    const text = img.ocrText ? oneLine(img.ocrText) : '';
    if (!alt && !text) continue;
    const where = img.source === 'post' ? 'in the post' : 'in the quoted post';
    const label = img.type === 'photo' ? 'image' : img.type === 'video' ? 'video' : 'GIF';
    const pieces = [alt ? `alt: ${alt}` : '', text ? `text: ${text}` : ''].filter(Boolean).join(' ');
    parts.push(`[${label} ${counters[img.source]} ${where}] ${pieces}`);
  }
  if (parts.length === 0) return null;
  const joined = parts.join(' | ');
  return joined.length > maxChars ? `${joined.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…` : joined;
}
