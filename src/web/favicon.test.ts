import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildServer } from './server';
import { Database } from '../db/database';

const PUBLIC_DIR = path.join(__dirname, 'public');

describe('favicon', () => {
  it('serves the SVG, PNG fallbacks and /favicon.ico', async () => {
    const app = buildServer(new Database(':memory:'));
    await app.ready();
    const svg = await app.inject({ method: 'GET', url: '/favicon.svg' });
    expect(svg.statusCode).toBe(200);
    expect(svg.headers['content-type']).toContain('image/svg+xml');
    for (const url of ['/favicon-32.png', '/apple-touch-icon.png']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('image/png');
    }
    const ico = await app.inject({ method: 'GET', url: '/favicon.ico' });
    expect(ico.statusCode).toBe(200);
    await app.close();
  });

  it('is linked from the page head with a theme-color', () => {
    const html = readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    expect(html).toContain('rel="icon" href="favicon.svg"');
    expect(html).toContain('rel="icon" href="favicon-32.png"');
    expect(html).toContain('rel="apple-touch-icon" href="apple-touch-icon.png"');
    expect(html).toContain('name="theme-color"');
  });
});
