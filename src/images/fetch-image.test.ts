import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHostPolicy, PRIVATE_ADDRESS_REASON } from '../articles/host-policy';
import { HttpImageFetcher, ocrImageUrl } from './fetch-image';

/** A local stand-in for X's media CDN: never a real host. */
let server: http.Server;
let base: string;
let host: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/media/ok.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    } else if (req.url === '/media/big.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(Buffer.alloc(2048));
    } else if (req.url === '/media/page') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html></html>');
    } else if (req.url === '/media/hop') {
      res.writeHead(302, { Location: '/media/ok.png' });
      res.end();
    } else if (req.url === '/media/away') {
      res.writeHead(302, { Location: 'https://example.com/evil.png' });
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  base = `http://${host}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

/** Loopback is let through the policy only because it stands in for the CDN here. */
const local = (maxBytes?: number) =>
  new HttpImageFetcher({ allowedHosts: [host], hostPolicy: createHostPolicy({ allowPrivateAddresses: true }), maxBytes });

describe('HttpImageFetcher', () => {
  it('downloads an image from an allowed media host, following a same-host redirect', async () => {
    const direct = await local().fetch(`${base}/media/ok.png`);
    expect(direct).toMatchObject({ ok: true, contentType: 'image/png' });
    expect(await local().fetch(`${base}/media/hop`)).toMatchObject({ ok: true });
  });

  it('refuses any host that is not one of X media servers - including on a redirect', async () => {
    expect(await new HttpImageFetcher().fetch('https://example.com/a.png')).toEqual({
      ok: false,
      error: "Images are only downloaded from X's media servers, not example.com.",
    });
    expect(await local().fetch(`${base}/media/away`)).toMatchObject({ ok: false, error: expect.stringContaining('example.com') });
  });

  it('applies the host policy even to an allowed host', async () => {
    const fetcher = new HttpImageFetcher({ allowedHosts: [host], hostPolicy: createHostPolicy({ allowPrivateAddresses: false }) });
    expect(await fetcher.fetch(`${base}/media/ok.png`)).toEqual({ ok: false, error: PRIVATE_ADDRESS_REASON });
  });

  it('refuses a non-image, a missing image, and one over the size cap', async () => {
    expect(await local().fetch(`${base}/media/page`)).toEqual({ ok: false, error: 'The address did not return an image.' });
    expect(await local().fetch(`${base}/media/none.png`)).toMatchObject({ ok: false, error: expect.stringContaining('404') });
    expect(await local(1024).fetch(`${base}/media/big.png`)).toEqual({ ok: false, error: 'The image is too large to read.' });
  });
});

describe('ocrImageUrl', () => {
  it("asks X's CDN for the large rendition, and leaves anything else alone", () => {
    expect(ocrImageUrl('https://pbs.twimg.com/media/Gx1.jpg')).toBe('https://pbs.twimg.com/media/Gx1.jpg?name=large');
    expect(ocrImageUrl('https://pbs.twimg.com/media/Gx1?format=jpg&name=small')).toBe(
      'https://pbs.twimg.com/media/Gx1?format=jpg&name=small',
    );
    expect(ocrImageUrl('https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/x.jpg')).toBe(
      'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/x.jpg',
    );
  });
});
