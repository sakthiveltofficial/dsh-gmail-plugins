/**
 * Interactive Google sign-in tools.
 *
 * `gmail_authorize` starts the OAuth flow: it opens the Google consent page in
 * the default browser and serves the loopback callback, so the refresh token is
 * captured and stored automatically — no manual token generation needed.
 * `gmail_auth_status` reports whether a credential is stored and what the
 * in-flight flows are doing.
 * @module @google-workspace/dsh-gmail/tools/authorize
 */

import { resolveOAuthCredentials } from '../auth.js';
import { awaitCallbackAndStore, openBrowser, startFlow } from '../authorize.js';
import { authFailure } from '../util.js';

export function tools(ctx, deps) {
  const { config, flows } = deps;
  const list = [
    {
      name: 'gmail_authorize',
      title: 'Sign in with Google',
      kind: 'write',
      description:
        "Starts the interactive Google OAuth sign-in for this Gmail account. The plugin opens the Google consent page in your browser (or returns the URL if it cannot); sign in with Google there, and the refresh token is captured and stored automatically via the harness credential service. Requires GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET to be configured first. Returns immediately with the flow URL; use gmail_auth_status to check completion. You only need to run this once per account.",
      parameters: {
        scopes: { type: 'array', items: { type: 'string' }, description: 'Optional OAuth scopes to request; defaults to the configured scopes (gmail.modify, gmail.settings.basic, gmail.compose, gmail.send, contacts.readonly).' },
      },
      async execute(args, exec) {
        const creds = await resolveOAuthCredentials(ctx, config);
        if (!creds.clientId || !creds.clientSecret) {
          throw authFailure('no client credentials configured — set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET first');
        }
        const scopes = Array.isArray(args.scopes) && args.scopes.length > 0 ? args.scopes : config.scopes;
        const flow = await startFlow({
          clientId: creds.clientId,
          clientSecret: creds.clientSecret,
          scopes,
          timeoutMs: config.flowTimeoutMs ?? 300000,
        });
        flows.set(flow.flowId, flow);
        const opened = openBrowser(flow.url);
        // Complete the exchange in the background, owned by the plugin fiber, so
        // a tool timeout can never lose the captured token.
        awaitCallbackAndStore(ctx, flow, { ...config, clientId: creds.clientId, clientSecret: creds.clientSecret, scopes })
          .then(({ payload }) => {
            ctx.emit('gmail/authorized', { flowId: flow.flowId, email: undefined, storedAt: payload.storedAt });
            console.log(`gmail: sign-in complete — refresh token stored (${payload.storedAt})`);
          })
          .catch((error) => {
            console.error('gmail: sign-in failed:', error instanceof Error ? error.message : String(error));
          });
        return {
          status: 'pending',
          flowId: flow.flowId,
          url: flow.url,
          browserOpened: opened,
          message: opened
            ? 'Opened the Google sign-in page in your browser. Complete the sign-in there; the refresh token is captured automatically when you finish.'
            : 'Open this URL in your browser and sign in with Google. The refresh token is captured automatically when you finish.',
        };
      },
    },
    {
      name: 'gmail_auth_status',
      title: 'Gmail auth status',
      kind: 'read',
      description:
        'Reports whether this Gmail plugin has a stored credential (client id/secret configured and a refresh token available — either from GMAIL_REFRESH_TOKEN or captured by gmail_authorize), plus the state of any in-flight sign-in flows. Use after gmail_authorize to check completion.',
      parameters: {
        flow_id: { type: 'string', description: 'Optional flow id from gmail_authorize to inspect; when omitted, reports the overall state and every known flow.' },
      },
      async execute(args, exec) {
        const creds = await resolveOAuthCredentials(ctx, config);
        const all = [...flows.values()];
        const selected = args.flow_id ? all.filter((f) => f.flowId === args.flow_id) : all;
        return {
          authorized: Boolean(creds.refreshToken),
          hasClientId: Boolean(creds.clientId),
          hasClientSecret: Boolean(creds.clientSecret),
          hasRefreshToken: Boolean(creds.refreshToken),
          refreshTokenSource: creds.refreshToken === undefined ? 'none' : 'configured-or-stored',
          flows: selected.map((f) => ({
            flowId: f.flowId,
            status: f.status,
            error: f.error,
            settledAt: f.settledAt,
            url: f.url,
          })),
        };
      },
    },
  ];
  return list;
}
