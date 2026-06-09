/**
 * OAuth HTML injection and dev-link gating tests.
 *
 * (a) GET /oauth/authorize with a client_id containing an XSS payload must
 *     return HTML where the raw payload never appears — only escaped form.
 * (b) POST /oauth/authorize must NOT include the magic link / verify URL in
 *     the HTML response when OAUTH_DEV_LINKS is unset (the default).
 */

import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { type SeedResult, seedStore } from './helpers';

let _seed: SeedResult; // needed to bootstrap the DO (schema init)

beforeAll(async () => {
  _seed = await seedStore();
});

// ── helpers ──────────────────────────────────────────────────────────────────

async function generateCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Build a valid GET /oauth/authorize URL with the given client_id. */
function buildAuthorizeUrl(clientId: string, redirectUri: string, codeChallenge: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid profile',
    state: 'test-state',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `http://example.com/oauth/authorize?${params.toString()}`;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('OAuth HTML security', () => {
  it('(a) escapes XSS payload in client_id — raw <script> tag must not appear in response HTML', async () => {
    const verifier = 'test-verifier-for-xss-check-abc123';
    const codeChallenge = await generateCodeChallenge(verifier);

    // Use a benign redirect_uri so the request is accepted (client auto-registers).
    const redirectUri = 'https://legit-app.example.com/callback';
    // Attacker-controlled client_id containing an XSS payload.
    const maliciousClientId = '<script>alert(1)</script>';

    const url = buildAuthorizeUrl(maliciousClientId, redirectUri, codeChallenge);
    const res = await SELF.fetch(url);

    // The route should succeed (200) — the client auto-registers on first use.
    expect(res.status).toBe(200);
    const html = await res.text();

    // The raw payload must NOT appear anywhere in the HTML.
    expect(html).not.toContain('<script>alert(1)</script>');

    // The escaped form (or at minimum the < character escaped) must be present,
    // proving the value was rendered but safely.
    expect(html).toContain('&lt;script&gt;');
  });

  it('(b) magic link / verify URL is absent from POST /oauth/authorize HTML when OAUTH_DEV_LINKS is unset', async () => {
    // Step 1: start an authorization session via GET so we get a valid auth_id.
    const verifier = 'test-verifier-for-dev-link-check-xyz789';
    const codeChallenge = await generateCodeChallenge(verifier);
    const redirectUri = 'https://legit-app2.example.com/callback';
    const clientId = 'my-test-platform-client';

    const getUrl = buildAuthorizeUrl(clientId, redirectUri, codeChallenge);
    const getRes = await SELF.fetch(getUrl);
    expect(getRes.status).toBe(200);
    const loginHtml = await getRes.text();

    // Extract the auth_id from the hidden input in the login page.
    const match = loginHtml.match(/name="auth_id"\s+value="([^"]+)"/);
    expect(match).not.toBeNull();
    const authId = match![1];

    // Step 2: POST the email — OAUTH_DEV_LINKS is not set in test env.
    const formBody = new URLSearchParams({ auth_id: authId, email: 'user@example.com' });
    const postRes = await SELF.fetch('http://example.com/oauth/authorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody.toString(),
    });

    expect(postRes.status).toBe(200);
    const sentHtml = await postRes.text();

    // The verify path must not appear in the response body.
    expect(sentHtml).not.toContain('/oauth/verify');
    // The dev-link block must not appear either.
    expect(sentHtml).not.toContain('DEV MODE');
  });
});
