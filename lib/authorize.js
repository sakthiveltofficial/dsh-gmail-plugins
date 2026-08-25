/**
 * Interactive Google OAuth flow for the Gmail plugin.
 *
 * Instead of asking the user to mint a refresh token by hand, `gmail_authorize`
 * runs the real sign-in: it opens a consent URL in the default browser, serves
 * the OAuth callback on a loopback HTTP server (`http://127.0.0.1:<port>/oauth2callback`),
 * exchanges the authorization code at Google's token endpoint, and stores the
 * refresh token through the harness `credentials` service. The flow is
 * non-blocking: the tool returns the URL immediately and the loopback server
 * completes the exchange in the background (owned by the plugin fiber), so a
 * tool timeout can never lose the captured token.
 *
 * Google permits loopback redirect URIs with any port, so the callback port is
 * ephemeral and needs no registration in the OAuth client.
 * @module @google-workspace/dsh-gmail/authorize
 */

import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { GmailError } from './util.js'

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const CALLBACK_PATH = '/oauth2callback'
/** Stored-grant credential key, `<scope>/<id>` with scope = plugin name 'gmail'. */
const STORE_KEY = 'gmail/oauth'

/** One in-flight (or finished) sign-in flow, owned by the plugin instance. */
export class OAuthFlow {
  constructor({ flowId, url, state, redirectUri, clientId, expiresAt }) {
    this.flowId = flowId
    this.url = url
    this.state = state
    this.redirectUri = redirectUri
    this.clientId = clientId
    this.expiresAt = expiresAt
    this.status = 'pending' // pending | authorized | failed | expired
    this.error = undefined
    this.settledAt = undefined
  }
}

/**
 * Best-effort open of the default browser; never throws.
 * @returns true when a launcher was spawned.
 */
export function openBrowser(url) {
  try {
    const platform = process.platform
    if (platform === 'darwin') {
      const child = spawn('open', [url], { stdio: 'ignore', detached: true })
      child.unref()
      return true
    }
    if (platform === 'win32') {
      const child = spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true })
      child.unref()
      return true
    }
    const child = spawn('xdg-open', [url], { stdio: 'ignore', detached: true })
    child.unref()
    return true
  } catch (error) {
    console.error('gmail: could not open the browser automatically:', error instanceof Error ? error.message : String(error))
    return false
  }
}

/** Build the Google consent URL for the given client, scopes, and redirect URI. */
export function buildConsentUrl(clientId, scopes, redirectUri, state) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
  })
  return `${AUTH_ENDPOINT}?${params.toString()}`
}

/**
 * The fixed OAuth redirect URI users must register in their Google Cloud
 * OAuth client (Authorized redirect URIs). The port is configurable via the
 * plugin's `redirectPort` setting; keep the two in lockstep.
 */
export const DEFAULT_REDIRECT_URI = 'http://127.0.0.1:8765/oauth2callback'

/**
 * Start one sign-in flow: launch the loopback server on the configured port,
 * build the consent URL, open the browser, and return the flow. The server
 * keeps running in the background; call {@link awaitCallback} to complete the
 * exchange.
 * @returns the created flow.
 */
export function startFlow({ clientId, clientSecret, scopes, timeoutMs, redirectPort = 8765 }) {
  const state = randomBytes(16).toString('hex')
  const flowId = randomBytes(6).toString('hex')
  const redirectUri = `http://127.0.0.1:${redirectPort}${CALLBACK_PATH}`
  let server
  let resolveCallback
  let rejectCallback
  const callback = new Promise((resolve, reject) => {
    resolveCallback = resolve
    rejectCallback = reject
  })

  server = createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1')
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404)
        res.end('Not found')
        return
      }
      const receivedState = url.searchParams.get('state')
      const error = url.searchParams.get('error')
      const code = url.searchParams.get('code')
      if (receivedState !== state) {
        rejectCallback(new GmailError('OAuth state mismatch — possible CSRF; please retry gmail_authorize', 'GMAIL_OAUTH_STATE_MISMATCH'))
        res.writeHead(400)
        res.end('State mismatch')
        return
      }
      if (error) {
        rejectCallback(new GmailError(`Google sign-in was not completed: ${error}`, 'GMAIL_OAUTH_DECLINED'))
        res.writeHead(400)
        res.end(`Google sign-in was not completed (${error})`)
        return
      }
      if (!code) {
        rejectCallback(new GmailError('OAuth callback carried no authorization code', 'GMAIL_OAUTH_NO_CODE'))
        res.writeHead(400)
        res.end('No authorization code')
        return
      }
      resolveCallback({ code, clientSecret, redirectUri, flowId })
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(
        '<html><body style="font-family:sans-serif;text-align:center;margin-top:15vh">' +
        '<h2>✅ Signed in to Gmail</h2>' +
        '<p>You can close this window and return to the harness.</p>' +
        '</body></html>',
      )
      // The response above flushes; close shortly after so the page renders first.
      setTimeout(() => server.close(), 500)
    } catch (callbackError) {
      // A malformed callback must reject the flow, never crash the server.
      try {
        rejectCallback(callbackError instanceof Error ? callbackError : new GmailError(String(callbackError), 'GMAIL_OAUTH_CALLBACK_FAILED'))
      } catch { /* promise already settled */ }
      res.writeHead(400)
      res.end('OAuth callback failed')
    }
  })

  return new Promise((resolve, reject) => {
    server.on('error', (error) => {
      if (error && error.code === 'EADDRINUSE') {
        reject(new GmailError(
          `cannot start the OAuth callback server: port ${redirectPort} is already in use. Free the port or change the plugin's redirectPort setting (keep it in lockstep with the redirect URI registered in Google Cloud: ${redirectUri}).`,
          'GMAIL_OAUTH_PORT_BUSY',
        ))
        return
      }
      reject(error)
    })
    server.listen(redirectPort, '127.0.0.1', () => {
      const url = buildConsentUrl(clientId, scopes, redirectUri, state)
      const flow = new OAuthFlow({
        flowId,
        url,
        state,
        redirectUri,
        clientId,
        expiresAt: Date.now() + timeoutMs,
      })
      // Keep the server alive past this promise; the plugin fiber owns disposal.
      flow.server = server
      flow.callback = callback
      flow.dispose = () => {
        try { server.close() } catch { /* already closed */ }
      }
      resolve(flow)
    })
  })
}

/** Exchange the authorization code for access + refresh tokens. */
export async function exchangeCode(clientId, clientSecret, code, redirectUri, timeoutMs) {
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  })
  let response
  try {
    response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(timeoutMs ?? 30000),
    })
  } catch (error) {
    throw new GmailError(`token exchange network failure: ${error instanceof Error ? error.message : String(error)}`, 'GMAIL_TOKEN_EXCHANGE_NETWORK')
  }
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new GmailError(
      `token exchange failed with ${response.status} (${payload.error ?? 'unknown'}: ${payload.error_description ?? ''})`,
      'GMAIL_TOKEN_EXCHANGE_FAILED',
      response.status,
    )
  }
  if (typeof payload.access_token !== 'string') {
    throw new GmailError('token exchange returned no access_token', 'GMAIL_TOKEN_EXCHANGE_FAILED')
  }
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresIn: Number.isFinite(payload.expires_in) ? Number(payload.expires_in) : 3600,
    scope: payload.scope,
  }
}

/**
 * Persist the completed grant: a `grant` credential record under the plugin's
 * own key (opaque JSON the seam stores verbatim) plus the refresh token on the
 * `GMAIL_REFRESH_TOKEN` reference so plain env resolution sees it too.
 */
export async function storeGrant(ctx, tokens, clientId, scopes) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) {
    throw new GmailError('no credential store is mounted; cannot persist the refresh token', 'GMAIL_NO_CREDENTIAL_STORE')
  }
  const payload = {
    refreshToken: tokens.refreshToken,
    accessToken: tokens.accessToken,
    expiresAt: Date.now() + tokens.expiresIn * 1000,
    clientId,
    scope: tokens.scope ?? scopes.join(' '),
    storedAt: new Date().toISOString(),
  }
  await credentials.modifyRecord(STORE_KEY, async (current) => ({
    kind: 'grant',
    payload,
  }))
  if (tokens.refreshToken) {
    try {
      await credentials.set(credentialRef('GMAIL_REFRESH_TOKEN'), tokens.refreshToken)
    } catch (error) {
      console.warn('gmail: could not write GMAIL_REFRESH_TOKEN reference:', error instanceof Error ? error.message : String(error))
    }
  }
  return payload
}

/** Wait for the flow's callback, exchange the code, and store the grant. */
export async function awaitCallbackAndStore(ctx, flow, config) {
  try {
    const settled = await Promise.race([
      flow.callback,
      new Promise((_, reject) => setTimeout(() => reject(new GmailError('sign-in timed out — please run gmail_authorize again', 'GMAIL_OAUTH_TIMEOUT')), Math.max(0, flow.expiresAt - Date.now()))),
    ])
    const tokens = await exchangeCode(config.clientId, config.clientSecret, settled.code, settled.redirectUri, config.timeoutMs)
    const payload = await storeGrant(ctx, tokens, flow.clientId, config.scopes)
    flow.status = 'authorized'
    flow.settledAt = new Date().toISOString()
    return { payload, tokens }
  } catch (error) {
    flow.status = error instanceof GmailError && error.code === 'GMAIL_OAUTH_TIMEOUT' ? 'expired' : 'failed'
    flow.error = error instanceof Error ? error.message : String(error)
    flow.settledAt = new Date().toISOString()
    throw error
  } finally {
    if (typeof flow.dispose === 'function') flow.dispose()
  }
}
