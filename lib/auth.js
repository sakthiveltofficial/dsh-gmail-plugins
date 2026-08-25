/**
 * OAuth2 credential resolution and access-token refresh for Google APIs.
 *
 * Credential precedence, per value:
 *   1. literal config value (clientId / clientSecret / refreshToken)
 *   2. the harness `credentials` service reference named by the config
 *      (clientIdRef / clientSecretRef / refreshTokenRef) — resolves the
 *      process environment, the provider-managed store, and `.env` files
 *   3. for the refresh token only: the stored `gmail:oauth` grant record,
 *      written by the interactive `gmail_authorize` sign-in flow
 *   4. the same environment variable read directly from `process.env`
 *
 * Access tokens are refreshed from the refresh token on demand and cached in
 * memory for their remaining lifetime; a token is never written back to the
 * refresh token source (the refresh token itself is treated as immutable
 * configuration).
 * @module @google-workspace/dsh-gmail/auth
 */

import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { authFailure, GmailError } from './util.js';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
/** Stored-grant credential key, `<scope>/<id>` with scope = plugin name 'gmail'. */
const GRANT_KEY = 'gmail/oauth';

/**
 * Resolve one configured secret: literal config first, then the harness
 * credentials service (which layers env / provider store / .env), then the
 * raw process environment as a last resort.
 */
async function resolveSecret(ctx, config, literal, refName) {
  if (typeof literal === 'string' && literal.trim().length > 0) return literal;
  const name = refName || '';
  if (name.trim().length === 0) return undefined;
  const credentials = ctx.get('credentials');
  if (credentials !== undefined) {
    try {
      const resolved = await credentials.resolve(credentialRef(name));
      if (resolved !== undefined) return resolved.value;
    } catch (error) {
      // Fall through to process.env; a broken provider must not hide a working env.
      console.error(`gmail: credentials.resolve(${name}) failed:`, error instanceof Error ? error.message : String(error));
    }
  }
  return process.env[name];
}

/** The refresh token captured by the interactive sign-in flow, if any. */
async function grantRefreshToken(ctx) {
  const credentials = ctx.get('credentials');
  if (credentials === undefined) return undefined;
  try {
    const record = await credentials.readRecord(GRANT_KEY);
    if (record !== undefined && record.kind === 'grant' && typeof record.payload?.refreshToken === 'string' && record.payload.refreshToken.length > 0) {
      return record.payload.refreshToken;
    }
  } catch (error) {
    console.error('gmail: reading stored grant failed:', error instanceof Error ? error.message : String(error));
  }
  return undefined;
}

/** Snapshot of the three OAuth2 values after resolution. */
export async function resolveOAuthCredentials(ctx, config) {
  const clientId = await resolveSecret(ctx, config, config.clientId, config.clientIdRef);
  const clientSecret = await resolveSecret(ctx, config, config.clientSecret, config.clientSecretRef);
  let refreshToken = await resolveSecret(ctx, config, config.refreshToken, config.refreshTokenRef);
  if (refreshToken === undefined) refreshToken = await grantRefreshToken(ctx);
  return { clientId, clientSecret, refreshToken };
}

/** Whether every credential needed to mint an access token is present. */
export function isConfigured(credentials) {
  return Boolean(
    credentials.clientId && credentials.clientSecret && credentials.refreshToken,
  );
}

/**
 * In-memory OAuth2 token manager bound to one plugin instance.
 * Threads concurrent refreshes so a burst of tool calls triggers one exchange.
 */
export class OAuthTokenManager {
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
    this.accessToken = undefined;
    this.expiresAt = 0; // epoch ms
    this.refreshPromise = undefined;
  }

  /** Exchange the refresh token for a fresh access token via Google's token endpoint. */
  async refreshAccessToken() {
    if (this.refreshPromise !== undefined) return this.refreshPromise;
    this.refreshPromise = (async () => {
      const credentials = await resolveOAuthCredentials(this.ctx, this.config);
      if (!isConfigured(credentials)) {
        throw authFailure('no client credentials or refresh token configured');
      }
      const body = new URLSearchParams({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        refresh_token: credentials.refreshToken,
        grant_type: 'refresh_token',
      });
      let response;
      try {
        response = await fetch(TOKEN_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
          signal: AbortSignal.timeout(this.config.timeoutMs ?? 30000),
        });
      } catch (error) {
        throw new GmailError(
          `token refresh network failure: ${error instanceof Error ? error.message : String(error)}`,
          'GMAIL_TOKEN_REFRESH_NETWORK',
        );
      }
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw authFailure(
          `token endpoint returned ${response.status} (${payload.error ?? 'unknown'}: ${payload.error_description ?? ''})`,
        );
      }
      if (typeof payload.access_token !== 'string' || payload.access_token.length === 0) {
        throw authFailure('token endpoint returned no access_token');
      }
      const expiresIn = Number.isFinite(payload.expires_in) ? Number(payload.expires_in) : 3600;
      this.accessToken = payload.access_token;
      // Refresh 60s before the hard expiry so long-running calls do not race it.
      this.expiresAt = Date.now() + Math.max(0, expiresIn - 60) * 1000;
      return this.accessToken;
    })();
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = undefined;
    }
  }

  /** Current valid access token, refreshing when absent or about to expire. */
  async getAccessToken() {
    if (this.accessToken !== undefined && Date.now() < this.expiresAt) {
      return this.accessToken;
    }
    return this.refreshAccessToken();
  }

  /** Forget the cached token so the next call performs a fresh exchange. */
  invalidate() {
    this.accessToken = undefined;
    this.expiresAt = 0;
  }
}

/** Build the Google OAuth consent URL for the configured client + scopes. */
export function consentUrl(clientId, scopes, redirectUri = 'urn:ietf:wg:oauth:2.0:oob') {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}
