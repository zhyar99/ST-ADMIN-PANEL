import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { app } from '../app';
import { pool } from '../db/client';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

describe('service endpoints', () => {
  it('GET /health returns 200 with status ok', async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });

  it('GET /ready reports readiness without leaking internals', async () => {
    const response = await fetch(`${baseUrl}/ready`);
    // 200 when Postgres and storage are both reachable, 503 otherwise — either
    // is a pass here, the point is that the probe answers.
    expect([200, 503]).toContain(response.status);

    const body = (await response.json()) as { status: string; details?: string[] };

    if (response.status === 200) {
      expect(body).toEqual({ status: 'ready' });
      return;
    }

    expect(body.status).toBe('not_ready');
    expect(Array.isArray(body.details)).toBe(true);

    // The failure body names dependencies, never paths or connection strings.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('postgres');
    expect(serialized).not.toMatch(/\/(Users|home|var)\//);
    for (const detail of body.details ?? []) {
      expect(detail).toMatch(/^(database|storage(\/[a-z-]+)?)$/);
    }
  });

  it('sets the security headers on both the SPA and the API', async () => {
    for (const pathname of ['/admin', '/api/v1/does-not-exist']) {
      const response = await fetch(`${baseUrl}${pathname}`, {
        headers: { 'x-test-bypass-rate-limit': '1' },
      });

      const csp = response.headers.get('content-security-policy');
      expect(csp, `missing CSP on ${pathname}`).toBeTruthy();
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      // No inline scripts: the SPA bundle is a single external module.
      expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);

      expect(response.headers.get('x-frame-options')).toBe('DENY');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
      expect(response.headers.get('x-powered-by')).toBeNull();
    }
  });

  it('GET an unknown /api/v1 route returns a JSON 404', async () => {
    const response = await fetch(`${baseUrl}/api/v1/does-not-exist`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });
});
