/**
 * Shared helpers for the Gmail plugin: structured errors, base64url codecs,
 * common JSON renderers, and small argument utilities used by every tool.
 * @module @google-workspace/dsh-gmail/util
 */

/**
 * Structured error thrown by the Gmail/People client and tool layer.
 * Carries an open-string machine code plus the HTTP status when one exists.
 */
export class GmailError extends Error {
  constructor(message, code = 'GMAIL_ERROR', status = undefined, body = undefined) {
    super(message);
    this.name = 'GmailError';
    this.code = code;
    this.status = status;
    this.body = body;
  }
}

/** 401 from any Google API — the access token is missing, stale, or invalid. */
export function authFailure(detail) {
  return new GmailError(
    `Gmail authentication failed: ${detail}. Re-run the OAuth flow so a fresh refresh token is stored (GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN), then retry.`,
    'GMAIL_AUTH_FAILED',
    401,
  );
}

/** A 429/403 rate-limit reply with backoff guidance. */
export function rateLimitFailure(retryAfterMs) {
  const wait = retryAfterMs == null ? 'exponential backoff (1s, 2s, 4s)' : `${Math.ceil(retryAfterMs / 1000)}s`;
  return new GmailError(
    `Gmail quota exhausted or rate limited: wait ${wait} before retrying, and reduce concurrency.`,
    'GMAIL_RATE_LIMITED',
    429,
  );
}

/** Encode UTF-8 text as standard base64url (no padding), as Gmail expects for `raw`. */
export function toBase64Url(text) {
  return Buffer.from(text, 'utf8').toString('base64url');
}

/** Decode a base64url string (with or without padding) into UTF-8 text. */
export function fromBase64Url(b64) {
  return Buffer.from(b64, 'base64url').toString('utf8');
}

/** Encode bytes (Buffer/Uint8Array) as base64url. */
export function bytesToBase64Url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

/** Decode a base64url string into a Buffer. */
export function base64UrlToBytes(b64) {
  return Buffer.from(b64, 'base64url');
}

/** Convert standard base64 (RFC 4648, with `+`/`/`) to base64url. */
export function base64ToBase64Url(b64) {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/** Render any JSON value as a single model-facing text block. */
export function jsonText(value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
}

/** Canonical `output` declaration for JSON-object tool results. */
export function jsonObjectOutput(render = jsonText) {
  return {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => render(value),
  };
}

/** Canonical `output` declaration for results that are already strings. */
export function textOutput() {
  return {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
  };
}

/** Generic pending-call card. `kind` is one of 'read' | 'write' | 'other'. */
export function presentCall(title, kind, rawInput) {
  return {
    card: 'generic',
    title,
    kind,
    ...(rawInput === undefined ? {} : { rawInput }),
  };
}

/** Fill `userId` with the configured default when omitted (almost always 'me'). */
export function userIdOf(args, fallback) {
  const id = args.user_id ?? args.userId ?? args.user;
  return id === undefined || id === '' ? fallback : id;
}

/** First defined of several aliased keys, else `undefined`. */
export function pick(args, keys) {
  for (const key of keys) {
    const value = args[key];
    if (value !== undefined) return value;
  }
  return undefined;
}

/** Coerce a value that may arrive as a JSON-encoded string into its array form. */
export function asArray(value) {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [value];
    }
  }
  return [value];
}

/** Coerce a value that may arrive as a JSON-encoded string into its object form. */
export function asObject(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** True when a string has non-whitespace content. */
export function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
