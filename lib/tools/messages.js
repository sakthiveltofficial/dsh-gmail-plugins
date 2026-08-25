/**
 * Message tools: send, fetch, forward, trash/untrash, delete, import/insert,
 * and label modification (single + batch).
 * @module @google-workspace/dsh-gmail/tools/messages
 */

import { buildMime, extractAttachments, extractText, formatAddressList, headersOf } from '../mime.js';
import { fromBase64Url, GmailError } from '../util.js';

const SYSTEM_LABEL_HINT =
  'System labels use their ID (INBOX, SPAM, TRASH, UNREAD, STARRED, IMPORTANT, SENT, DRAFT, CATEGORY_*); custom labels MUST use their internal ID (Label_123, from gmail_list_labels), never the display name.';

/** Default field set for metadata-level hydration. */
const METADATA_KEYS = ['messageId', 'threadId', 'labelIds', 'internalDate', 'snippet', 'subject', 'from', 'to', 'date'];

/** Hydrate one message id into a flat, model-friendly record. */
async function hydrate(client, userId, id, format, signal) {
  const message = await client.gmail('GET', `/users/${userId}/messages/${id}`, { query: { format }, signal });
  const headers = headersOf(message);
  const record = {
    messageId: message.id,
    threadId: message.threadId,
    labelIds: message.labelIds ?? [],
    internalDate: message.internalDate,
    snippet: message.snippet ?? '',
    subject: headers.Subject ?? '',
    from: headers.From ?? '',
    to: headers.To ?? '',
    cc: headers.Cc ?? '',
    date: headers.Date ?? '',
  };
  if (format === 'full' || format === 'raw') {
    const text = message.payload ? extractText(message.payload) : { text: '', html: '' };
    record.body = text.text;
    record.bodyHtml = text.html;
    record.attachments = message.payload ? extractAttachments(message.payload) : [];
    if (format === 'raw') record.raw = message.raw;
  }
  return record;
}

/** Shared recipient/subject/body parameter blocks for compose-like tools. */
function recipientParams() {
  return {
    recipient_email: { type: 'string', description: "Primary recipient's email address (e.g. 'user@example.com' or 'Jane Doe <user@example.com>'). A plain name without an email is invalid." },
    extra_recipients: { type: 'array', items: { type: 'string' }, description: "Additional 'To' recipients (not Cc or Bcc). Use only when recipient_email is also provided." },
    cc: { type: 'array', items: { type: 'string' }, description: "CC recipients (e.g. 'user@example.com' or 'John Doe <user@example.com>')." },
    bcc: { type: 'array', items: { type: 'string' }, description: "BCC recipients (e.g. 'user@example.com')." },
  };
}

function composeParams() {
  return {
    ...recipientParams(),
    subject: { type: 'string', description: 'Email subject line. Either subject or body must be provided.' },
    body: { type: 'string', description: 'Email body content (plain text or HTML); set is_html true when the body contains HTML tags.' },
    is_html: { type: 'boolean', description: 'Set true when body is already formatted HTML; plain-text newlines are otherwise converted to <br/> tags.' },
    attachment: { type: 'json', description: "File(s) to attach: a local file path, a public URL, an object { name, mimetype, base64 }, or an array mixing any of these. Total message size must stay under ~25 MB after base64 encoding." },
    user_id: { type: 'string', description: "User's email address or 'me' for the authenticated user." },
  };
}

/** Compose the `raw` body for send/insert/import after loading attachments. */
async function composeRaw(args) {
  let attachments = undefined;
  if (args.attachment !== undefined && args.attachment !== null && args.attachment !== '') {
    try {
      attachments = typeof args.attachment === 'string' ? JSON.parse(args.attachment) : args.attachment;
    } catch {
      attachments = args.attachment;
    }
  }
  const recipients = [args.recipient_email, ...(Array.isArray(args.extra_recipients) ? args.extra_recipients : [])].filter(Boolean);
  if (recipients.length === 0 && !args.cc && !args.bcc) {
    throw new GmailError("at least one of recipient_email, extra_recipients, cc, or bcc must be provided", 'GMAIL_INVALID_ARGS');
  }
  if (!args.subject && !args.body) {
    throw new GmailError('at least one of subject or body must be provided', 'GMAIL_INVALID_ARGS');
  }
  return buildMime({
    from: args.from_email,
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
      name: 'gmail_send_email',
      title: 'Send email',
      kind: 'write',
      description:
        "Sends an email via the Gmail API from the authenticated user's account. Sends immediately and is irreversible — confirm recipients, subject, body, and attachments before calling. Requires at least one of recipient_email/extra_recipients, cc, or bcc, and at least one of subject or body. Set is_html=true when the body contains HTML. Use gmail_reply_to_thread to reply inside an existing thread.",
      parameters: {
        ...composeParams(),
        from_email: { type: 'string', description: "Sender email for the 'From' header. Use a verified send-as alias configured in Gmail settings; defaults to the authenticated user's primary address." },
      },
      async execute(args, exec) {
        const raw = await composeRaw(args);
        const result = await client.gmail('POST', `/users/${uid(args)}/messages/send`, { body: { raw }, signal: exec.signal });
        const headers = headersOf(result);
        return {
          messageId: result.id,
          threadId: result.threadId,
          labelIds: result.labelIds ?? [],
          subject: headers.Subject ?? args.subject ?? '',
          to: headers.To ?? '',
          sent: true,
        };
      },
    },
    {
      name: 'gmail_fetch_emails',
      title: 'Fetch emails',
      kind: 'read',
      description:
        "Fetches a list of email messages from a Gmail account with filtering, pagination, and optional full-content retrieval. Results are NOT sorted by recency — sort by internalDate client-side. For large result sets, prefer ids_only=true or metadata-only listing, then hydrate via gmail_fetch_message_by_message_id. The messages field may be absent (valid no-results state).",
      parameters: {
        query: { type: 'string', description: "Gmail advanced search query (e.g. 'from:user subject:meeting'). Operators: from:, to:, subject:, label:, has:, is: (is:unread, is:read, is:starred, is:important, is:snoozed), in:, category:, after:YYYY/MM/DD, before:YYYY/MM/DD, AND/OR/NOT. Use label: only for user-created labels. after:/before: evaluate whole UTC calendar days; before: is exclusive." },
        user_id: { type: 'string', description: "User's email address or 'me' for the authenticated user. Non-'me' addresses require domain-level delegation." },
        verbose: { type: 'boolean', description: 'When false (default), uses fast metadata fetching and only subject, sender, recipient, time, and labels are guaranteed. Body content and attachment details require verbose=true.' },
        ids_only: { type: 'boolean', description: 'When true, returns only message IDs and thread IDs from the list API without fetching individual messages (fastest).' },
        label_ids: { type: 'array', items: { type: 'string' }, description: `Filter by label IDs (AND logic). ${SYSTEM_LABEL_HINT} Combining label_ids with label: in query can silently over-restrict results — use one strategy consistently.` },
        page_token: { type: 'string', description: "Opaque pagination token from a previous response's nextPageToken. Loop until nextPageToken is absent to avoid silently missing messages." },
        max_results: { type: 'integer', description: 'Maximum messages per page. Hard cap is 500 per page; the default of 1 retrieves only a single message — set higher for practical use.' },
        include_payload: { type: 'boolean', description: 'Set true to include full message payload (headers, body, attachments). When present, bodies are base64url-encoded in payload.parts; this tool decodes them for you. Implies verbose behavior.' },
        include_spam_trash: { type: 'boolean', description: 'Set true to include messages from SPAM and TRASH.' },
      },
      async execute(args, exec) {
        const userId = uid(args);
        const listing = await client.gmail('GET', `/users/${userId}/messages`, {
          query: {
            q: args.query,
            labelIds: args.label_ids,
            pageToken: args.page_token,
            maxResults: args.max_results,
            includeSpamTrash: args.include_spam_trash,
          },
          signal: exec.signal,
        });
        const entries = listing.messages ?? [];
        if (args.ids_only) {
          return {
            ids: entries.map((m) => ({ messageId: m.id, threadId: m.threadId })),
            nextPageToken: listing.nextPageToken,
            resultSizeEstimate: listing.resultSizeEstimate,
          };
        }
        const full = Boolean(args.include_payload) || Boolean(args.verbose);
        const format = full ? 'full' : 'metadata';
        const messages = await Promise.all(entries.map((m) => hydrate(client, userId, m.id, format, exec.signal)));
        return {
          messages,
          nextPageToken: listing.nextPageToken,
          resultSizeEstimate: listing.resultSizeEstimate,
          count: messages.length,
        };
      },
    },
    {
      name: 'gmail_fetch_message_by_message_id',
      title: 'Fetch message by ID',
      kind: 'read',
      description:
        "Fetches a specific email message by its Gmail API message ID (hexadecimal, e.g. '19b11732c1b578fd'). Do NOT pass subjects, dates, thread IDs, Message-ID headers, or fabricated values — only IDs from Gmail list/search responses. Use internalDate (epoch ms) rather than the Date header for recency checks.",
      parameters: {
        message_id: { type: 'string', required: true, description: 'The Gmail API message ID (hexadecimal string from gmail_fetch_emails / gmail_list_threads responses).' },
        format: { type: 'string', enum: ['minimal', 'metadata', 'full', 'raw'], description: "'metadata': headers only, ideal for summarization. 'full': complete MIME structure with decoded body and attachment list. 'raw': entire RFC 2822 message as base64url string. 'minimal': ID, thread ID, labels only." },
        user_id: { type: 'string', description: "User's email address or 'me' for the authenticated user." },
      },
      async execute(args, exec) {
        const format = args.format ?? 'metadata';
        const record = await hydrate(client, uid(args), args.message_id, format, exec.signal);
        return record;
      },
    },
    {
      name: 'gmail_fetch_message_by_thread_id',
      title: 'Fetch messages by thread',
      kind: 'read',
      description:
        'Retrieves all messages in a Gmail thread by thread ID. Message order is not guaranteed — sort by internalDate. Check labelIds per message to filter drafts. Cap concurrent bulk calls at ~10 and use exponential backoff.',
      parameters: {
        thread_id: { type: 'string', required: true, description: "Hexadecimal thread ID from Gmail API (e.g. '19bf77729bcb3a44'). Obtain from gmail_list_threads or gmail_fetch_emails. Prefixes like 'msg-f:'/'thread-f:' are auto-stripped. Legacy Gmail web UI IDs are NOT supported." },
        page_token: { type: 'string', description: 'Opaque pagination token; iterate using nextPageToken until absent for long threads.' },
        user_id: { type: 'string', description: "The user's email address or 'me'." },
      },
      async execute(args, exec) {
        const userId = uid(args);
        const threadId = String(args.thread_id).replace(/^(msg-f:|thread-f:)/i, '');
        const thread = await client.gmail('GET', `/users/${userId}/threads/${encodeURIComponent(threadId)}`, {
          query: { format: 'full', pageToken: args.page_token },
          signal: exec.signal,
        });
        const messages = (thread.messages ?? []).map((message) => {
          const headers = headersOf(message);
          const text = extractText(message.payload);
          return {
            messageId: message.id,
            threadId: message.threadId,
            labelIds: message.labelIds ?? [],
            internalDate: message.internalDate,
            subject: headers.Subject ?? '',
            from: headers.From ?? '',
            to: headers.To ?? '',
            date: headers.Date ?? '',
            body: text.text,
            bodyHtml: text.html,
            attachments: extractAttachments(message.payload),
          };
        });
        return { threadId: thread.id, historyId: thread.historyId, messages, count: messages.length };
      },
    },
    {
      name: 'gmail_forward_message',
      title: 'Forward message',
      kind: 'write',
      description:
        'Forwards an existing Gmail message to specified recipients, preserving the original body and attachments as a quoted forward. Verify recipients and content before forwarding to avoid unintended exposure. Keep concurrency to 5–10 and apply backoff for bulk forwarding.',
      parameters: {
        message_id: { type: 'string', required: true, description: 'Gmail message ID (hexadecimal, e.g. 17f45ec49a9c3f1b) from gmail_fetch_emails or gmail_list_threads.' },
        recipients: { type: 'array', required: true, items: { type: 'string' }, description: "List of email addresses to forward the message to." },
        cc: { type: 'array', items: { type: 'string' }, description: 'Email addresses to CC.' },
        bcc: { type: 'array', items: { type: 'string' }, description: 'Email addresses to BCC.' },
        additional_text: { type: 'string', description: 'Optional additional text to include before the forwarded content.' },
        user_id: { type: 'string', description: "User's email address or 'me'." },
      },
      async execute(args, exec) {
        const userId = uid(args);
        const original = await client.gmail('GET', `/users/${userId}/messages/${args.message_id}`, { query: { format: 'full' }, signal: exec.signal });
        const headers = headersOf(original);
        const text = extractText(original.payload);
        const quoted = [
          ...(args.additional_text ? [args.additional_text, ''] : []),
          '---------- Forwarded message ---------',
          `From: ${headers.From ?? ''}`,
          `Date: ${headers.Date ?? ''}`,
          `Subject: ${headers.Subject ?? ''}`,
          `To: ${headers.To ?? ''}`,
          '',
          (text.text || text.html) || (original.snippet ?? ''),
        ].join('\n');
        const raw = await buildMime({
          to: args.recipients,
          cc: args.cc,
          bcc: args.bcc,
          subject: `Fwd: ${headers.Subject ?? ''}`,
          body: quoted,
        });
        const result = await client.gmail('POST', `/users/${userId}/messages/send`, { body: { raw }, signal: exec.signal });
        return { messageId: result.id, threadId: result.threadId, forwarded: true, subject: `Fwd: ${headers.Subject ?? ''}`, recipients: args.recipients };
      },
    },
    {
      name: 'gmail_add_label_to_email',
      title: 'Modify message labels',
      kind: 'write',
      description:
        "Adds and/or removes Gmail labels on a single message by message ID. Ensure message_id and every label ID are valid (use gmail_list_labels for custom label IDs). To mark as read, remove 'UNREAD'; to archive, remove 'INBOX'. SENT, DRAFT, CHAT are immutable. A label cannot appear in both add and remove lists.",
      parameters: {
        message_id: { type: 'string', required: true, description: "Immutable Gmail message ID (hexadecimal). Do NOT use UUIDs, thread IDs, or internal system IDs — they cause 'Invalid id value' errors. Obtain from gmail_fetch_emails or gmail_list_threads." },
        add_label_ids: { type: 'array', items: { type: 'string' }, description: `Label IDs to add (IDs, not display names). ${SYSTEM_LABEL_HINT} Use the full CATEGORY_ prefix (CATEGORY_UPDATES, not UPDATES).` },
        remove_label_ids: { type: 'array', items: { type: 'string' }, description: `Label IDs to remove. ${SYSTEM_LABEL_HINT} A label cannot appear in both add_label_ids and remove_label_ids.` },
        user_id: { type: 'string', description: "User's email address or 'me'." },
      },
      async execute(args, exec) {
        if (!args.add_label_ids && !args.remove_label_ids) {
          throw new GmailError('at least one of add_label_ids or remove_label_ids must be provided', 'GMAIL_INVALID_ARGS');
        }
        const result = await client.gmail('POST', `/users/${uid(args)}/messages/${args.message_id}/modify`, {
          body: {
            addLabelIds: args.add_label_ids ?? [],
            removeLabelIds: args.remove_label_ids ?? [],
          },
          signal: exec.signal,
        });
        return { messageId: result.id, labelIds: result.labelIds ?? [] };
      },
    },
    {
      name: 'gmail_batch_modify_messages',
      title: 'Batch modify messages',
      kind: 'write',
      description:
        'Modifies labels on up to 1,000 Gmail messages in one API call — bulk archive, mark read/unread, or apply custom labels. High-volume calls may return 429/403 rate-limit errors; apply exponential backoff.',
      parameters: {
        messageIds: { type: 'array', required: true, items: { type: 'string' }, description: 'List of message IDs to modify (max 1,000). Accepts messageIds, ids, or message_ids as the parameter name. Get IDs from gmail_fetch_emails or gmail_list_threads.' },
        addLabelIds: { type: 'array', items: { type: 'string' }, description: `Label IDs to add. ${SYSTEM_LABEL_HINT} At least one of add/remove must be provided; the lists must not overlap.` },
        removeLabelIds: { type: 'array', items: { type: 'string' }, description: `Label IDs to remove. ${SYSTEM_LABEL_HINT} Remove 'UNREAD' to mark as read, 'INBOX' to archive. 'DRAFT' cannot be removed — use gmail_delete_draft.` },
        userId: { type: 'string', description: "User's email address or 'me'." },
      },
      async execute(args, exec) {
        if (!args.addLabelIds && !args.removeLabelIds) {
          throw new GmailError('at least one of addLabelIds or removeLabelIds must be provided', 'GMAIL_INVALID_ARGS');
        }
        await client.gmail('POST', `/users/${args.userId ?? config.defaultUserId}/messages/batchModify`, {
          body: { ids: args.messageIds, addLabelIds: args.addLabelIds ?? [], removeLabelIds: args.removeLabelIds ?? [] },
          signal: exec.signal,
        });
        return { modified: args.messageIds.length, messageIds: args.messageIds };
      },
    },
    {
      name: 'gmail_batch_delete_messages',
      title: 'Batch delete messages',
      kind: 'write',
      description:
        'Permanently deletes multiple Gmail messages in bulk, bypassing Trash with no recovery possible. Use for retention enforcement or mailbox hygiene only after explicit user confirmation and verifying a sample of message IDs. Prefer gmail_move_to_trash when reversibility may be needed. High-volume calls may trigger 429/403; apply exponential backoff.',
      parameters: {
        messageIds: { type: 'array', required: true, items: { type: 'string' }, description: 'List of Gmail message IDs to delete permanently. Each must be a hexadecimal string from gmail_fetch_emails or gmail_list_threads — never human-readable descriptions.' },
        userId: { type: 'string', description: "User's email address or 'me'." },
      },
      async execute(args, exec) {
        await client.gmail('POST', `/users/${args.userId ?? config.defaultUserId}/messages/batchDelete`, {
          body: { ids: args.messageIds },
          signal: exec.signal,
        });
        return { deleted: args.messageIds.length, messageIds: args.messageIds, permanent: true };
      },
    },
    {
      name: 'gmail_delete_message',
      title: 'Delete message',
      kind: 'write',
      description:
        'Permanently deletes a specific email message by its Gmail ID. This bypasses Trash and cannot be undone — prefer gmail_move_to_trash when recovery may be needed.',
      parameters: {
        message_id: { type: 'string', required: true, description: 'Identifier of the email message to delete (hexadecimal Gmail ID).' },
        user_id: { type: 'string', description: "User's email address or 'me'." },
      },
      async execute(args, exec) {
        await client.gmail('DELETE', `/users/${uid(args)}/messages/${args.message_id}`, { signal: exec.signal });
        return { messageId: args.message_id, deleted: true, permanent: true };
      },
    },
    {
      name: 'gmail_move_to_trash',
      title: 'Move to trash',
      kind: 'write',
      description:
        'Moves an existing email message to the trash. Trashed messages are recoverable and still count toward storage quota until purged. Prefer this over gmail_batch_delete_messages when recovery may be needed; for bulk operations use gmail_batch_modify_messages instead of repeated calls.',
      parameters: {
        message_id: { type: 'string', required: true, description: 'Hexadecimal Gmail message ID from gmail_fetch_emails. Verify the correct message via subject/snippet before trashing.' },
        user_id: { type: 'string', description: "User's email address or 'me'." },
      },
      async execute(args, exec) {
        const result = await client.gmail('POST', `/users/${uid(args)}/messages/${args.message_id}/trash`, { signal: exec.signal });
        return { messageId: result.id, inTrash: true };
      },
    },
    {
      name: 'gmail_untrash_message',
      title: 'Untrash message',
      kind: 'write',
      description: 'Removes a message from the trash, restoring it to the mailbox.',
      parameters: {
        message_id: { type: 'string', required: true, description: 'Hexadecimal Gmail message ID from gmail_fetch_emails.' },
        user_id: { type: 'string', description: "User's email address or 'me'." },
      },
      async execute(args, exec) {
        const result = await client.gmail('POST', `/users/${uid(args)}/messages/${args.message_id}/untrash`, { signal: exec.signal });
        return { messageId: result.id, restored: true };
      },
    },
    {
      name: 'gmail_import_message',
      title: 'Import message',
      kind: 'write',
      description:
        "Imports a message into the mailbox with standard email delivery scanning and classification, without sending it through SMTP. This method doesn't perform SPF checks, so it may not work for some spam messages.",
      parameters: {
        raw: { type: 'string', required: true, description: 'The entire email message in RFC 2822 format, base64url-encoded.' },
        deleted: { type: 'boolean', description: 'Mark the email as permanently deleted (visible only in Google Vault). Workspace accounts only.' },
        never_mark_spam: { type: 'boolean', description: 'Ignore the Gmail spam classifier and never mark this email as SPAM.' },
        internal_date_source: { type: 'string', enum: ['receivedTime', 'dateHeader'], description: "Source for Gmail's internal date of the message." },
        process_for_calendar: { type: 'boolean', description: 'Process calendar invites in the email and add extracted meetings to Google Calendar.' },
        user_id: { type: 'string', description: "User's email address or 'me'." },
      },
      async execute(args, exec) {
        const result = await client.gmail('POST', `/users/${uid(args)}/messages/import`, {
          query: {
            deleted: args.deleted,
            neverMarkSpam: args.never_mark_spam,
            internalDateSource: args.internal_date_source,
            processForCalendar: args.process_for_calendar,
          },
          body: { raw: args.raw },
          signal: exec.signal,
        });
        return { messageId: result.id, threadId: result.threadId, labelIds: result.labelIds ?? [], imported: true };
      },
    },
    {
      name: 'gmail_insert_message',
      title: 'Insert message',
      kind: 'write',
      description:
        'Inserts a message directly into the mailbox (similar to IMAP APPEND), bypassing most scanning and classification. This does not send the message.',
      parameters: {
        raw: { type: 'string', required: true, description: 'The entire email message in RFC 2822 format, base64url-encoded.' },
        deleted: { type: 'boolean', description: 'Mark the email as permanently deleted (visible only in Google Vault). Workspace accounts only.' },
        internalDateSource: { type: 'string', enum: ['receivedTime', 'dateHeader'], description: "Source for Gmail's internal date of the message." },
        user_id: { type: 'string', description: "User's email address or 'me'." },
      },
      async execute(args, exec) {
        const result = await client.gmail('POST', `/users/${uid(args)}/messages`, {
          query: { internalDateSource: args.internalDateSource, deleted: args.deleted },
          body: { raw: args.raw },
          signal: exec.signal,
        });
        return { messageId: result.id, threadId: result.threadId, labelIds: result.labelIds ?? [], inserted: true };
      },
    },
    {
      name: 'gmail_list_messages',
      title: 'List messages (deprecated)',
      kind: 'read',
      description:
        'DEPRECATED: prefer gmail_fetch_emails. Lists message IDs in the mailbox with optional filtering by labels or a search query. Returns IDs only; hydrate with gmail_fetch_message_by_message_id.',
      parameters: {
        q: { type: 'string', description: "Gmail search query, same format as the Gmail search box (e.g. 'from:someuser@example.com is:unread'). Cannot be used with the gmail.metadata scope." },
        user_id: { type: 'string', description: "User's email address or 'me'." },
        label_ids: { type: 'array', items: { type: 'string' }, description: `Only return messages with ALL of these label IDs. ${SYSTEM_LABEL_HINT}` },
        page_token: { type: 'string', description: 'Page token from a previous response.' },
        max_results: { type: 'integer', description: 'Maximum messages to return. Defaults to 100; max 500.' },
        include_spam_trash: { type: 'boolean', description: 'Include SPAM and TRASH. Default false.' },
      },
      async execute(args, exec) {
        const result = await client.gmail('GET', `/users/${uid(args)}/messages`, {
          query: { q: args.q, labelIds: args.label_ids, pageToken: args.page_token, maxResults: args.max_results, includeSpamTrash: args.include_spam_trash },
          signal: exec.signal,
        });
        return {
          messages: (result.messages ?? []).map((m) => ({ messageId: m.id, threadId: m.threadId })),
          nextPageToken: result.nextPageToken,
          resultSizeEstimate: result.resultSizeEstimate,
          deprecated: true,
        };
      },
    },
  ];
  return list;
}
