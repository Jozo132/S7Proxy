// @ts-check

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHttpApp } from '../../src/http/app.js';

/** @type {import('../../src/http/app.js').HttpApp} */
let app;
/** @type {string} */
let tmpDir;
/** @type {string} */
let baseUrl;

describe('HttpApp', () => {
  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 's7proxy-http-app-'));
    writeFileSync(join(tmpDir, 'index.html'), '<html><body>admin</body></html>', 'utf8');

    app = createHttpApp();
    app.serveStatic('/admin/', tmpDir);
    app.get('/admin', (_req, reply) => reply.redirect('/admin/'));

    baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  });

  afterEach(async () => {
    await app.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('redirects /admin once and serves /admin/ without looping', async () => {
    const redirectRes = await fetch(`${baseUrl}/admin`, { redirect: 'manual' });
    expect(redirectRes.status).toBe(302);
    expect(redirectRes.headers.get('location')).toBe('/admin/');

    const pageRes = await fetch(`${baseUrl}/admin/`);
    expect(pageRes.status).toBe(200);
    expect(await pageRes.text()).toContain('admin');
  });
});