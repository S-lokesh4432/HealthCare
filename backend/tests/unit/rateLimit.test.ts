import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { authLimiter } from '../../src/middleware/rateLimit';
import app from '../../src/app';

// authLimiter is tested against a throwaway app, not the shared `app`
// singleton - the real app's limiter accumulates state across every other
// test file in this run, so asserting an exact trip point against it would
// be order-dependent and flaky.
function isolatedApp() {
  const test = express();
  test.use(authLimiter);
  test.get('/probe', (_req, res) => res.json({ ok: true }));
  return test;
}

describe('rate limiting', () => {
  it('allows requests under the limit and blocks the one that exceeds it', async () => {
    const probe = isolatedApp();

    for (let i = 0; i < 10; i += 1) {
      const response = await request(probe).get('/probe');
      expect(response.status).toBe(200);
    }

    const blocked = await request(probe).get('/probe');
    expect(blocked.status).toBe(429);
  });
});

describe('security headers', () => {
  it('sets helmet defaults on responses', async () => {
    const response = await request(app).get('/health');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-dns-prefetch-control']).toBeDefined();
  });
});
