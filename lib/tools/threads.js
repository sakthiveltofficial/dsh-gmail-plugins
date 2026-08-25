/**
 * Thread tools: list, modify labels, trash/untrash, delete, and reply in-thread.
 * @module @google-workspace/dsh-gmail/tools/threads
 */

import { buildMime, extractAttachments, extractText, headersOf } from '../mime.js';
import { GmailError } from '../util.js';

export function tools(ctx, deps) {
  const { client, config } = deps;
  const uid = (args) => args.user_id ?? config.defaultUserId;
  const list = [
    {
      name: 'gmail_list_threads',
      title: 'List threads',
      kind: 'read',
      description:
        "Retrieves a list of email threads from a Gmail account with filtering and pagination. Spam and trash are excluded by default unless targeted via label:spam or label:trash in the query. Use verbose=true for full message details per thread (keep max_results modest — responses can be very large).",
      parameters: {
        query: { type: 'string', description: "Gmail search query syntax (e.g. 'from:user@example.com is:unread'). Operators: from:, to:, subject:, label:, is:unread, has:attachment, after:, before: (UTC, YYYY/MM/DD). Exact subject phrases need quotes (e.g. subject:'meeting notes')." },
        user_id: { type: 'string', description: "User's email address or 'me'." },
        verbose: { type: 'boolean', description: 'If true, returns complete message details (headers, body, attachments) for each message in the thread. Keep max_results modest when verbose is enabled.' },
        page_token: { type: 'string', description: 'Token from a previous response; omit for the first page.' },
        max_results: { type: 'integer', description: 'Maximum threads to return. Hard cap ~500 per call. Loop using nextPageToken until absent for full mailbox coverage.' },
      },
      async execute(args, exec) {
        const userId = uid(args);
        const listing = await client.gmail('GET', `/users/${userId}/threads`, {
          query: { q: args.query, pageToken: args.page_token, maxResults: args.max_results },
          signal: exec.signal,
        });
        const threads = (listing.threads ?? []).map((t) => ({ threadId: t.id, snippet: t.snippet, historyId: t.historyId }));
        if (args.verbose && threads.length > 0) {
          for (const thread of threads) {
            const detail = await client.gmail('GET', `/users/${userId}/threads/${thread.threadId}`, { query: { format: 'full' }, signal: exec.signal });
            thread.messages = (detail.messages ?? []).map((message) => {
              const headers = headersOf(message);
              const text = extractText(message.payload);
              return {
                messageId: message.id,
                internalDate: message.internalDate,
                labelIds: message.labelIds ?? [],
                subject: headers.Subject ?? '',
                from: headers.From ?? '',
                to: headers.To ?? '',
                date: headers.Date ?? '',
                body: text.text || text.html,
                attachments: extractAttachments(message.payload),
              };
            });
          }
        }
        return { threads, nextPageToken: listing.nextPageToken, count: threads.length };
      },
    },
    {
      name: 'gmail_modify_thread_labels',
      title: 'Modify thread labels',
      kind: 'write',
      description:
        "Adds or removes existing label IDs on a Gmail thread, affecting all its messages. Use gmail_list_labels to discover label IDs. To modify a single message only, use gmail_add_label_to_email. If a label appears in both add and remove lists, the add operation takes priority.",
      parameters: {
        thread_id: { type: 'string', required: true, description: 'Immutable ID of the thread to modify.' },
        add_label_ids: { type: 'array', items: { type: 'string' }, description: "Label IDs to add. System labels use uppercase names (INBOX, STARRED, IMPORTANT, UNREAD, SPAM, TRASH, CATEGORY_*); custom labels use 'Label_N'. Accepts a list or a JSON-encoded string." },
        remove_label_ids: { type: 'array', items: { type: 'string' }, description: "Label IDs to remove. Same ID rules as add_label_ids. Labels in both lists are automatically removed from this list (add takes priority)." },
        user_id: { type: 'string', description: "User's email address or 'me'." },
      },
      async execute(args, exec) {
        if (!args.add_label_ids && !args.remove_label_ids) {
          throw new GmailError('at least one of add_label_ids or remove_label_ids must be provided', 'GMAIL_INVALID_ARGS');
        }
        const result = await client.gmail('POST', `/users/${uid(args)}/threads/${args.thread_id}/modify`, {
          body: { addLabelIds: args.add_label_ids ?? [], removeLabelIds: args.remove_label_ids ?? [] },
          signal: exec.signal,
        });
        return { threadId: result.id, modified: true };
      },
    },
    {
      name: 'gmail_move_thread_to_trash',
      title: 'Trash thread',
      kind: 'write',
      description: 'Moves the specified thread (and all its messages) to the trash. Trashed threads are recoverable.',
      parameters: {
        thread_id: { type: 'string', required: true, description: 'The ID of the thread to trash. Moves all messages in the thread to trash.' },
        user_id: { type: 'string', description: "User's email address or 'me'." },
      },
      async execute(args, exec) {
        const result = await client.gmail('POST', `/users/${uid(args)}/threads/${args.thread_id}/trash`, { signal: exec.signal });
        return { threadId: result.id, inTrash: true };
      },
    },
    {
      name: 'gmail_untrash_thread',
      title: 'Untrash thread',
      kind: 'write',
      description: 'Removes a thread from the trash, restoring it and its messages.',
      parameters: {
        thread_id: { type: 'string', required: true, description: 'The ID of the thread to remove from trash.' },
        user_id: { type: 'string', description: "User's email address or 'me'." },
      },
      async execute(args, exec) {
        const result = await client.gmail('POST', `/users/${uid(args)}/threads/${args.thread_id}/untrash`, { signal: exec.signal });
        return { threadId: result.id, restored: true };
      },
    },
    {
      name: 'gmail_delete_thread',
      title: 'Delete thread',
      kind: 'write',
      description:
        'Immediately and permanently deletes a thread and all its messages. This operation cannot be undone — use gmail_move_thread_to_trash for reversible deletion.',
      parameters: {
        id: { type: 'string', required: true, description: 'ID of the Thread to delete.' },
        user_id: { type: 'string', description: "User's email address or 'me'." },
      },
      async execute(args, exec) {
        await client.gmail('DELETE', `/users/${uid(args)}/threads/${args.id}`, { signal: exec.signal });
        return { threadId: args.id, deleted: true, permanent: true };
      },
    },
    {
      name: 'gmail_reply_to_thread',
      title: 'Reply to thread',
      kind: 'write',
      description:
        "Sends a reply within a specific Gmail thread using the original thread's subject — do not provide a custom subject as it starts a new conversation instead of replying in-thread. Requires a valid thread_id and at least one of recipient_email, cc, or bcc. Supports optional file attachments.",
      parameters: {
        thread_id: { type: 'string', required: true, description: "Identifier of the Gmail thread for the reply (hexadecimal, typically 15-16 chars, e.g. '169eefc8138e68ca'). Must be a threadId, NOT a messageId. Prefixes like 'msg-f:'/'thread-f:' are auto-stripped. Use gmail_list_threads or gmail_fetch_emails to retrieve valid thread IDs." },
        recipient_email: { type: 'string', description: "Primary recipient's email address in format 'user@domain.com'. Required if cc and bcc are not provided. Use extra_recipients for multiple recipients." },
        extra_recipients: { type: 'array', items: { type: 'string' }, description: "Additional 'To' recipients (not Cc or Bcc). Use only when recipient_email is also provided." },
        cc: { type: 'array', items: { type: 'string' }, description: "CC recipients in format 'user@domain.com'." },
        bcc: { type: 'array', items: { type: 'string' }, description: "BCC recipients in format 'user@domain.com'." },
        message_body: { type: 'string', description: 'Content of the reply message, either plain text or HTML. Also accepts body as an alias.' },
        is_html: { type: 'boolean', description: 'Indicates if message_body is HTML. A mismatch makes recipients see raw HTML tags as plain text.' },
        attachment: { type: 'json', description: "File(s) to attach: a local file path, a public URL, an object { name, mimetype, base64 }, or an array. Total message size must stay under ~25 MB; use Drive links for large files." },
        user_id: { type: 'string', description: "Identifier for the user sending the reply; 'me' refers to the authenticated user." },
      },
      async execute(args, exec) {
        const userId = uid(args);
        const threadId = String(args.thread_id).replace(/^(msg-f:|thread-f:)/i, '');
        const original = await client.gmail('GET', `/users/${userId}/threads/${encodeURIComponent(threadId)}`, { query: { format: 'metadata' }, signal: exec.signal });
        const first = original.messages?.[0];
        if (!first) throw new GmailError(`thread ${threadId} has no messages or is inaccessible`, 'GMAIL_THREAD_NOT_FOUND', 404);
        const headers = headersOf(first);
        const subject = headers.Subject ?? '';
        const inReplyTo = headers['Message-ID'] ?? '';
        const references = [headers.References, inReplyTo].filter(Boolean).join(' ');
        const recipients = [args.recipient_email, ...(Array.isArray(args.extra_recipients) ? args.extra_recipients : [])].filter(Boolean);
        if (recipients.length === 0 && !args.cc && !args.bcc) {
          throw new GmailError('at least one of recipient_email, cc, or bcc must be provided', 'GMAIL_INVALID_ARGS');
        }
        let attachments;
        if (args.attachment !== undefined && args.attachment !== null && args.attachment !== '') {
          try {
            attachments = typeof args.attachment === 'string' ? JSON.parse(args.attachment) : args.attachment;
          } catch {
            attachments = args.attachment;
          }
        }
        const raw = await buildMime({
          to: recipients,
          cc: args.cc,
          bcc: args.bcc,
          subject: subject.startsWith('Re:') ? subject : `Re: ${subject}`,
          body: args.message_body ?? args.body ?? '',
          isHtml: Boolean(args.is_html),
          attachments,
          inReplyTo,
          references,
        });
        const result = await client.gmail('POST', `/users/${userId}/messages/send`, { body: { raw }, signal: exec.signal });
        return { messageId: result.id, threadId: result.threadId, repliedInThread: true, subject: subject.startsWith('Re:') ? subject : `Re: ${subject}` };
      },
    },
  ];
  return list;
}
