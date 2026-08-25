/**
 * Polling triggers inspired by the Composio Gmail triggers.
 *
 * While the plugin is mounted and a trigger is enabled, the plugin polls the
 * mailbox on a fixed interval and emits a Cordis event for every message that
 * was not present on the previous poll:
 *
 * - `gmail/message-received` — payload matches the Composio "New Gmail Message"
 *   trigger (sender, subject, message_id, thread_id, to, message_text,
 *   message_timestamp, label_ids, attachment_list, payload, preview).
 * - `gmail/message-sent` — payload matches the Composio "Email Sent" trigger
 *   (sender, recipients, subject, message_id, thread_id, to, cc, bcc,
 *   message_text, message_timestamp, attachment_list, payload).
 *
 * The first poll only seeds the seen-set (no emission), so activating the
 * plugin does not replay the whole mailbox. Polling stops when the plugin is
 * stopped or the session ends.
 * @module @google-workspace/dsh-gmail/triggers
 */

import { extractAttachments, extractText, headersOf } from './mime.js';

const RECEIVED_EVENT = 'gmail/message-received';
const SENT_EVENT = 'gmail/message-sent';

/** Hydrate one message id into the trigger payload documented above. */
async function hydrateTriggerMessage(client, userId, id, signal) {
  const message = await client.gmail('GET', `/users/${userId}/messages/${id}`, { query: { format: 'full' }, signal });
  const headers = headersOf(message);
  const text = extractText(message.payload);
  const attachments = extractAttachments(message.payload);
  return {
    message_id: message.id,
    thread_id: message.threadId,
    label_ids: message.labelIds ?? [],
    subject: headers.Subject ?? '',
    sender: headers.From ?? '',
    to: headers.To ?? '',
    cc: headers.Cc ?? '',
    bcc: headers.Bcc ?? '',
    recipients: [headers.To, headers.Cc, headers.Bcc].filter(Boolean).join(', '),
    message_text: text.text || text.html,
    message_timestamp: message.internalDate ? new Date(Number(message.internalDate)).toISOString() : undefined,
    attachment_list: attachments,
    payload: message.payload,
    preview: message.snippet ?? '',
  };
}

/**
 * Start the enabled triggers.
 * @param ctx - plugin context (must expose the `timer` service)
 * @param config - resolved plugin config
 * @param client - bound Gmail client
 * @param getUserId - resolves the userId for the configured account
 * @returns a disposer that stops every polling loop
 */
export function startTriggers(ctx, config, client, getUserId) {
  const timer = ctx.get('timer');
  if (timer === undefined) {
    console.error('gmail: triggers enabled but no timer service is mounted; triggers will not poll');
    return () => {};
  }
  const intervalMs = Math.max(60, Math.floor(config.triggerIntervalMinutes * 60 * 1000));
  const disposers = [];
  const triggers = [];
  if (config.enableReceivedTrigger) {
    triggers.push({
      event: RECEIVED_EVENT,
      query: config.receivedQuery,
      label: 'gmail-message-received',
    });
  }
  if (config.enableSentTrigger) {
    triggers.push({
      event: SENT_EVENT,
      query: config.sentQuery,
      label: 'gmail-message-sent',
    });
  }
  for (const trigger of triggers) {
    let seen = new Set();
    let firstPoll = true;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const userId = getUserId();
        const listing = await client.gmail('GET', `/users/${userId}/messages`, {
          query: { q: trigger.query, maxResults: 200, includeSpamTrash: false },
        });
        const ids = (listing.messages ?? []).map((m) => m.id);
        const fresh = ids.filter((id) => !seen.has(id));
        if (firstPoll) {
          // Seed the seen-set without emitting, so activation does not replay the mailbox.
          for (const id of ids) seen.add(id);
          firstPoll = false;
          console.log(`gmail: ${trigger.label} trigger primed with ${ids.length} existing message(s)`);
          return;
        }
        for (const id of fresh) seen.add(id);
        for (const id of fresh) {
          try {
            const payload = await hydrateTriggerMessage(client, userId, id, undefined);
            ctx.emit(trigger.event, payload);
            console.log(`gmail: ${trigger.label} -> ${payload.subject || '(no subject)'} (${id})`);
          } catch (error) {
            console.error(`gmail: ${trigger.label} failed to hydrate ${id}:`, error instanceof Error ? error.message : String(error));
          }
        }
        // Bound the seen-set so long-running sessions do not grow it unboundedly.
        if (seen.size > 10000) {
          seen = new Set([...seen].slice(-5000));
        }
      } catch (error) {
        console.error(`gmail: ${trigger.label} poll failed:`, error instanceof Error ? error.message : String(error));
      } finally {
        polling = false;
      }
    };
    disposers.push(timer.interval(poll, intervalMs));
  }
  return () => {
    for (const dispose of disposers) dispose();
  };
}
