/**
 * Draft tools: create, get, list, update, delete, and send.
 * @module @google-workspace/dsh-gmail/tools/drafts
 */

import { buildMime, extractText, headersOf } from '../mime.js';
import { GmailError } from '../util.js';

function draftRecipientParams() {
  return {
    recipient_email: { type: 'string', description: "Primary recipient's email address (e.g. 'user@example.com' or 'John Doe <user@example.com>'). Optional for drafts — recipients can be added later before sending." },
    extra_recipients: { type: 'array', items: { type: 'string' }, description: "Additional 'To' recipients (not Cc or Bcc). Use only when recipient_email is also provided." },
    cc: { type: 'array', items: { type: 'string' }, description: "CC recipients (e.g. 'user@example.com')." },
    bcc: { type: 'array', items: { type: 'string' }, description: "BCC recipients (e.g. 'user@example.com')." },
    subject: { type: 'string', description: 'Email subject line. When replying to an existing thread (thread_id provided), leave this empty to stay in the same thread; setting a subject creates a NEW thread.' },
    body: { type: 'string', description: 'Email body content (plain text or HTML); set is_html true when HTML. Can also be provided as message_body.' },
    is_html: { type: 'boolean', description: 'Set true if body is already formatted HTML; plain-text newlines are otherwise converted to <br/> tags.' },
    attachment: { type: 'json', description: "File(s) to attach: a local file path, a public URL, an object { name, mimetype, base64 }, or an array. Total message size must stay under ~25 MB." },
    thread_id: { type: 'string', description: 'ID of an existing Gmail thread to reply to; omit for a new thread. If invalid or inaccessible, the draft is created as a new thread instead of failing.' },
    user_id: { type: 'string', description: "User's email address or 'me'." },
  };
}

/** Build the draft message body from compose-like args. */
async function draftMessage(args) {
  let attachments;
  if (args.attachment !== undefined && args.attachment !== null && args.attachment !== '') {
    try {
      attachments = typeof args.attachment === 'string' ? JSON.parse(args.attachment) : args.attachment;
    } catch {
      attachments = args.attachment;
    }
  }
  const recipients = [args.recipient_email, ...(Array.isArray(args.extra_recipients) ? args.extra_recipients : [])].filter(Boolean);
  if (recipients.length === 0 && !args.cc && !args.bcc && !args.subject && !args.body) {
    throw new GmailError('a draft needs at least one of recipient_email/cc/bcc or subject/body', 'GMAIL_INVALID_ARGS');
  }
  return buildMime({
    to: recipients,
    cc: args.cc,
    bcc: args.bcc,
    subject: args.subject ?? '',
    body: args.body ?? '',
    isHtml: Boolean(args.is_html),
    attachments,
  });
}

export function tools(ctx, deps) {
  const { client, config } = deps;
  const uid = (args) => args.user_id ?? config.defaultUserId;
  const list = [
    {
      name: 'gmail_create_email_draft',
      title: 'Create draft',
      kind: 'write',
      description:
        'Creates a Gmail email draft with To/Cc/Bcc recipients, subject, plain/HTML body (set is_html=true for HTML), attachments, and optional threading. Returns a draft_id that must be used as-is with gmail_send_draft — synthetic or stale IDs will fail. When creating a draft reply to an existing thread, leave subject empty to stay in that thread. HTTP 429 may occur on rapid create/send sequences; apply exponential backoff.',
      parameters: draftRecipientParams(),
      async execute(args, exec) {
        const raw = await draftMessage(args);
        const result = await client.gmail('POST', `/users/${uid(args)}/drafts`, { body: { message: { raw } }, signal: exec.signal });
        return { draftId: result.id, messageId: result.message?.id, threadId: result.message?.threadId };
      },
    },
    {
      name: 'gmail_get_draft',
      title: 'Get draft',
      kind: 'read',
      description:
        "Retrieves a single Gmail draft by ID. Use this to fetch and inspect draft content before sending via gmail_send_draft. The format parameter controls the level of detail.",
      parameters: {
        draft_id: { type: 'string', required: true, description: "The ID of the draft to retrieve (e.g. 'r99885592323229922'). Use gmail_list_drafts to retrieve valid draft IDs." },
        format: { type: 'string', enum: ['minimal', 'full', 'raw', 'metadata'], description: "'minimal' (ID/labels only), 'full' (complete data with parsed payload), 'raw' (base64url-encoded RFC 2822), 'metadata' (ID/labels/headers only)." },
        user_id: { type: 'string', description: "The user's email address or 'me'." },
      },
      async execute(args, exec) {
        const result = await client.gmail('GET', `/users/${uid(args)}/drafts/${args.draft_id}`, {
          query: { format: args.format ?? 'full' },
          signal: exec.signal,
        });
        const headers = headersOf(result.message);
        const text = result.message?.payload ? extractText(result.message.payload) : { text: '', html: '' };
        return {
          draftId: result.id,
          messageId: result.message?.id,
          threadId: result.message?.threadId,
          subject: headers.Subject ?? '',
          from: headers.From ?? '',
          to: headers.To ?? '',
          date: headers.Date ?? '',
          body: text.text || text.html,
          ...(args.format === 'raw' ? { raw: result.message?.raw } : {}),
        };
      },
    },
    {
      name: 'gmail_list_drafts',
      title: 'List drafts',
      kind: 'read',
      description:
        'Retrieves a paginated list of email drafts. Use verbose=true for full draft details (subject, body, sender, timestamp); otherwise only draft IDs are returned. Draft ordering is non-guaranteed — iterate using page_token until absent. Newly created drafts may not appear immediately. Apply exponential backoff on 403/429.',
      parameters: {
        user_id: { type: 'string', description: "User's mailbox ID; use 'me' for the authenticated user." },
        verbose: { type: 'boolean', description: 'If true, fetches full draft details including subject, sender, recipient, body, and timestamp. Use verbose=true before destructive operations to confirm draft identity.' },
        page_token: { type: 'string', description: 'Token from a previous response to retrieve a specific page.' },
        max_results: { type: 'integer', description: 'Maximum number of drafts to return per page.' },
      },
      async execute(args, exec) {
        const userId = uid(args);
        const listing = await client.gmail('GET', `/users/${userId}/drafts`, {
          query: { pageToken: args.page_token, maxResults: args.max_results },
          signal: exec.signal,
        });
        const drafts = (listing.drafts ?? []).map((d) => ({ draftId: d.id, messageId: d.message?.id }));
        if (args.verbose) {
          for (const draft of drafts) {
            const detail = await client.gmail('GET', `/users/${userId}/drafts/${draft.draftId}`, { query: { format: 'metadata' }, signal: exec.signal });
            const headers = headersOf(detail.message);
            draft.subject = headers.Subject ?? '';
            draft.from = headers.From ?? '';
            draft.to = headers.To ?? '';
            draft.date = headers.Date ?? '';
          }
        }
        return { drafts, nextPageToken: listing.nextPageToken, count: drafts.length };
      },
    },
    {
      name: 'gmail_update_draft',
      title: 'Update draft',
      kind: 'write',
      description:
        "Updates (replaces) an existing draft's content in-place by draft ID. This action replaces the entire draft content with the new message — it does not patch individual fields, so provide complete content. If not provided, previous body/subject/recipients are preserved.",
      parameters: {
        draft_id: { type: 'string', required: true, description: 'The ID of the draft to update, from gmail_list_drafts or gmail_create_email_draft.' },
        ...draftRecipientParams(),
      },
      async execute(args, exec) {
        const raw = await draftMessage({ ...args, thread_id: undefined });
        const result = await client.gmail('PUT', `/users/${uid(args)}/drafts/${args.draft_id}`, { body: { message: { raw } }, signal: exec.signal });
        return { draftId: result.id, messageId: result.message?.id, threadId: result.message?.threadId, updated: true };
      },
    },
    {
      name: 'gmail_delete_draft',
      title: 'Delete draft',
      kind: 'write',
      description:
        'Permanently deletes a Gmail draft by ID with no recovery possible. Verify the correct draft_id and obtain explicit user confirmation before calling. Draft IDs typically have an "r" prefix and differ from message IDs — do not interchange them.',
      parameters: {
        draft_id: { type: 'string', required: true, description: 'Immutable ID of the draft to delete (e.g. "r-1234567890"), from gmail_list_drafts or gmail_create_email_draft. Confirm the exact ID when multiple similar drafts exist.' },
        user_id: { type: 'string', description: "User's email address or 'me'; 'me' is recommended." },
      },
      async execute(args, exec) {
        await client.gmail('DELETE', `/users/${uid(args)}/drafts/${args.draft_id}`, { signal: exec.signal });
        return { draftId: args.draft_id, deleted: true, permanent: true };
      },
    },
    {
      name: 'gmail_send_draft',
      title: 'Send draft',
      kind: 'write',
      description:
        'Sends an existing draft AS-IS to the recipients already defined inside it. IMPORTANT: this action cannot add or override recipients (to, cc, bcc). If the draft has no recipients, create a new draft with recipients first, or use gmail_send_email. Sending is immediate and irreversible — confirm recipients and content first. Gmail enforces ~25 MB message size and daily send caps (~500 recipients/day personal, ~2,000/day Workspace).',
      parameters: {
        draft_id: { type: 'string', required: true, description: "The ID of the draft to send (e.g. 'r99885592323229922'), from gmail_list_drafts or gmail_create_email_draft. Do not confuse draft_id with message_id." },
        user_id: { type: 'string', description: "The user's email address or 'me'." },
      },
      async execute(args, exec) {
        const result = await client.gmail('POST', `/users/${uid(args)}/drafts/send`, { body: { id: args.draft_id }, signal: exec.signal });
        return { messageId: result.id, threadId: result.threadId, labelIds: result.labelIds ?? [], sent: true };
      },
    },
  ];
  return list;
}
