/**
 * Minimal Gmail + People REST client over the Node `fetch` global.
 *
 * Every request is authenticated with a Bearer access token minted by the
 * {@link OAuthTokenManager}; 401 responses invalidate the cached token once and
 * retry with a fresh exchange. 429/5xx responses are retried with bounded
 * exponential backoff. Non-2xx outcomes that survive retries become
 * {@link GmailError} with the HTTP status and Google error body preserved.
 * @module @google-workspace/dsh-gmail/client
 */

import { GmailError, authFailure, rateLimitFailure } from './util.js';

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1';
const PEOPLE_BASE = 'https://people.googleapis.com/v1';

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function queryString(params) {
  const cleaned = [];
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      // Google APIs document repeated fields (labelIds, historyTypes, sources)
      // as repeated query parameters: ?labelIds=a&labelIds=b
      for (const item of value) cleaned.push([key, String(item)]);
    } else {
      cleaned.push([key, String(value)]);
    }
  }
  if (cleaned.length === 0) return '';
  return '?' + cleaned.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

/** Client bound to one plugin instance; owns the token manager and backoff state. */
export class GmailClient {
  constructor(tokenManager, config) {
    this.tokens = tokenManager;
    this.config = config;
  }

  /** One authenticated request with 401-refresh-retry and bounded backoff. */
  async request(method, url, { query, body, signal, authRetried = false } = {}) {
    const token = await this.tokens.getAccessToken();
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    };
    let attempt = 0;
    let response;
    for (;;) {
      attempt += 1;
      response = await fetch(url + queryString(query), {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal,
      });
      if (!RETRY_STATUSES.has(response.status) || attempt >= MAX_ATTEMPTS) break;
      const retryAfter = Number(response.headers.get('retry-after') ?? 0) * 1000;
      const delay = Math.min(8000, retryAfter || 250 * 2 ** (attempt - 1));
      await sleep(delay);
    }
    if (response.status === 401 && !authRetried) {
      this.tokens.invalidate();
      return this.request(method, url, { query, body, signal, authRetried: true });
    }
    if (response.status === 429 || response.status === 403) {
      const retryAfter = Number(response.headers.get('retry-after') ?? 0) * 1000;
      throw rateLimitFailure(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      throw new GmailError(
        `Gmail API ${method} ${url} failed with ${response.status}: ${parsed?.error?.message ?? text.slice(0, 300)}`,
        'GMAIL_API_ERROR',
        response.status,
        parsed ?? text,
      );
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      return response.json();
    }
    return { body: await response.text() };
  }

  /** Gmail API call. `userId` defaults to 'me' at the tool layer. */
  gmail(method, path, { query, body, signal } = {}) {
    return this.request(method, `${GMAIL_BASE}${path}`, { query, body, signal });
  }

  /** People API call (contacts / other contacts / search). */
  people(method, path, { query, body, signal } = {}) {
    return this.request(method, `${PEOPLE_BASE}${path}`, { query, body, signal });
  }
}

export { GMAIL_BASE, PEOPLE_BASE };
