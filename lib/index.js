/**
 * @google-workspace/dsh-gmail — Gmail plugin for the DeepSeek Harness.
 *
 * A self-contained Cordis plugin: 61 model-facing tools over the Gmail and
 * People REST APIs, plus two polling triggers (`gmail/message-received`,
 * `gmail/message-sent`) that emit Cordis events while the plugin is mounted.
 *
 * Authentication is OAuth2: client credentials and a refresh token are read
 * from literal config, the harness `credentials` service, or the process
 * environment (see {@link auth}), and access tokens are refreshed on demand.
 *
 * The plugin publishes no services — it only consumes the host `tools`
 * registry (plus optional `timer` for triggers) — so it mounts cleanly as a
 * plain row in a host composition or an agent preset, with no isolate realm.
 * @module @google-workspace/dsh-gmail
 */

import z from '@deepseek-ai/schemastery';
import { OAuthTokenManager } from './auth.js';
import { GmailClient } from './client.js';
import { registerAll } from './tools/index.js';
import { startTriggers } from './triggers.js';

export const name = 'gmail';

/** Hard dependency: the host tool registry. `timer`/`credentials` stay optional. */
export const inject = ['tools'];

/** Schemastery config: OAuth2 credentials + trigger + HTTP settings. */
export const Config = z.object({
  // OAuth2 client credentials. Literal values win; otherwise the *Ref names are
  // resolved through the harness credentials service (env / provider store /
  // .env), falling back to the raw process environment.
  clientId: z.string().default(''),
  clientSecret: z.string().default(''),
  refreshToken: z.string().default(''),
  clientIdRef: z.string().default('GMAIL_CLIENT_ID'),
  clientSecretRef: z.string().default('GMAIL_CLIENT_SECRET'),
  refreshTokenRef: z.string().default('GMAIL_REFRESH_TOKEN'),
  /** OAuth scopes requested at consent time (informational; the granted token decides). */
  scopes: z.array(z.string()).default([
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/gmail.settings.basic',
    'https://www.googleapis.com/auth/gmail.compose',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/contacts.readonly',
  ]),
  /** Default `user_id` for tools that accept one; almost always 'me'. */
  defaultUserId: z.string().default('me'),
  /** Per-request HTTP timeout for Gmail API calls. */
  timeoutMs: z.number().default(30000),
  // ── triggers ──────────────────────────────────────────────────────────────
  /** Poll interval for the enabled triggers, in minutes. */
  triggerIntervalMinutes: z.number().default(5),
  /** Poll for newly received messages and emit `gmail/message-received`. */
  enableReceivedTrigger: z.boolean().default(false),
  /** Poll for messages sent by the user and emit `gmail/message-sent`. */
  enableSentTrigger: z.boolean().default(false),
  /** Search query backing the received trigger. */
  receivedQuery: z.string().default('in:inbox newer_than:1d'),
  /** Search query backing the sent trigger. */
  sentQuery: z.string().default('in:sent newer_than:1d'),
});

const PROMPT_SECTION = `You have access to the Gmail tools (gmail_*). Key conventions:

- Message IDs are hexadecimal Gmail API IDs (e.g. '19b11732c1b578fd') — never UUIDs, thread IDs, subjects, or dates. Obtain them from gmail_fetch_emails / gmail_list_threads.
- Label parameters take label IDs, never display names: system labels use their uppercase name (INBOX, UNREAD, STARRED, SPAM, TRASH, CATEGORY_UPDATES, ...); custom labels use their internal ID (Label_123, from gmail_list_labels).
- gmail_send_email sends immediately and irreversibly — confirm recipients, subject, and body before sending. Reply inside a thread with gmail_reply_to_thread (never pass a custom subject there; it starts a new thread).
- Draft IDs (r-prefixed, e.g. 'r99885592323229922') differ from message IDs; gmail_send_draft sends a draft exactly as-is and cannot add recipients.
- Attachments accept a local file path, a public URL, or { name, mimetype, base64 }; total message size must stay under ~25 MB after base64 encoding.
- Prefer gmail_move_to_trash over permanent deletes unless the user explicitly asked for irreversible removal.
- Google enforces per-minute/daily quotas: apply exponential backoff (1s, 2s, 4s) when you see 429/403 errors.`;

/** Apply the Gmail plugin: register tools and start triggers. */
export function apply(ctx, config) {
  const tokens = new OAuthTokenManager(ctx, config);
  const client = new GmailClient(tokens, config);
  const deps = { client, config, tokens };

  const count = registerAll(ctx, deps);
  console.log(`gmail: registered ${count} tools`);

  const systemPrompt = ctx.get('systemPrompt');
  if (systemPrompt !== undefined) {
    systemPrompt.section({ name: 'tool:gmail', order: 115, text: PROMPT_SECTION });
  }

  if (config.enableReceivedTrigger || config.enableSentTrigger) {
    ctx.effect(() => startTriggers(ctx, config, client, () => config.defaultUserId));
    console.log('gmail: triggers enabled (received=' + config.enableReceivedTrigger + ', sent=' + config.enableSentTrigger + ', interval=' + config.triggerIntervalMinutes + 'm)');
  }
}
