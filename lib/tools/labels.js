/**
 * Label tools: list, get, create, patch/update, and delete.
 * @module @google-workspace/dsh-gmail/tools/labels
 */

import { GmailError } from '../util.js';

const LABEL_NAME_HINT =
  'Must be unique, non-blank, max 225 chars, no commas. Forward slashes create hierarchical nested labels (Work/Projects; missing parents are auto-created like mkdir -p). Periods are allowed. Must not be a reserved system label (Inbox, Starred, Sent, Drafts, Spam, Trash, ...).';

const LABEL_COLOR_HINT =
  "Gmail only accepts colors from its predefined palette of 102 hex values. Provide a common color name ('YELLOW', 'BLUE', ...), a palette name, or an exact hex (e.g. '#4a86e8'). text_color and background_color must be supplied together; if only one is given, a complementary color is auto-selected for contrast.";

export function tools(ctx, deps) {
  const { client, config } = deps;
  const uid = (args) => args.user_id ?? config.defaultUserId;
  const list = [
    {
      name: 'gmail_list_labels',
      title: 'List labels',
      kind: 'read',
      description:
        "Retrieves all system and user-created labels in a single unpaginated response. Primary use: obtain internal label IDs (e.g. 'Label_123') required by other tools — display names cannot be used as label identifiers. System labels are case-sensitive (INBOX, UNREAD, SPAM, TRASH, ...); INBOX, SPAM, and TRASH are read-only. Do not hardcode label IDs across sessions; refresh via this tool on conflict errors.",
      parameters: {
        user_id: { type: 'string', description: "Identifies the Gmail account (owner's email or 'me')." },
        include_details: { type: 'boolean', description: 'If true, fetches detailed info per label including message/thread counts (messagesTotal, messagesUnread, threadsTotal, threadsUnread). Requires additional API calls and may be slower. Counts are eventually consistent.' },
      },
      async execute(args, exec) {
        const userId = uid(args);
        const listing = await client.gmail('GET', `/users/${userId}/labels`, { signal: exec.signal });
        const labels = listing.labels ?? [];
        if (args.include_details) {
          for (const label of labels) {
            const detail = await client.gmail('GET', `/users/${userId}/labels/${label.id}`, { signal: exec.signal });
            label.messagesTotal = detail.messagesTotal;
            label.messagesUnread = detail.messagesUnread;
            label.threadsTotal = detail.threadsTotal;
            label.threadsUnread = detail.threadsUnread;
            label.color = detail.color;
            label.labelListVisibility = detail.labelListVisibility;
            label.messageListVisibility = detail.messageListVisibility;
          }
        }
        return { labels, count: labels.length };
      },
    },
    {
      name: 'gmail_get_label',
      title: 'Get label details',
      kind: 'read',
      description:
        "Gets details for a specified Gmail label: name, type, visibility settings, message/thread counts, and color.",
      parameters: {
        id: { type: 'string', required: true, description: 'The ID of the label: a system label (INBOX, SENT, DRAFT, UNREAD, STARRED, SPAM, TRASH) or a user-created label ID (Label_1, Label_42).' },
        user_id: { type: 'string', description: "The user's email address or 'me'." },
      },
      async execute(args, exec) {
        const result = await client.gmail('GET', `/users/${uid(args)}/labels/${args.id}`, { signal: exec.signal });
        return {
          id: result.id,
          name: result.name,
          type: result.type,
          messagesTotal: result.messagesTotal,
          messagesUnread: result.messagesUnread,
          threadsTotal: result.threadsTotal,
          threadsUnread: result.threadsUnread,
          color: result.color,
          labelListVisibility: result.labelListVisibility,
          messageListVisibility: result.messageListVisibility,
        };
      },
    },
    {
      name: 'gmail_create_label',
      title: 'Create label',
      kind: 'write',
      description:
        "Creates a new label with a unique name. Returns a labelId (e.g. 'Label_123') required for downstream tools like gmail_add_label_to_email, gmail_batch_modify_messages, and gmail_modify_thread_labels — those tools do not accept display names. If the name already exists, returns a 409; use gmail_list_labels to reuse the existing label or gmail_patch_label to update it.",
      parameters: {
        label_name: { type: 'string', required: true, description: `REQUIRED. The name for the new label. ${LABEL_NAME_HINT} 'name' is also accepted as an alias.` },
        text_color: { type: 'string', description: `Text color for the label. ${LABEL_COLOR_HINT}` },
        background_color: { type: 'string', description: `Background color for the label. ${LABEL_COLOR_HINT}` },
        label_list_visibility: { type: 'string', enum: ['labelShow', 'labelShowIfUnread', 'labelHide'], description: 'How the label is displayed in the Gmail sidebar label list.' },
        message_list_visibility: { type: 'string', enum: ['show', 'hide'], description: 'How messages with this label are displayed in the message list. Values differ from label_list_visibility — do NOT use labelShow/labelHide here.' },
        user_id: { type: 'string', description: "The email address of the user in whose account the label will be created." },
      },
      async execute(args, exec) {
        const name = args.label_name ?? args.name;
        if (!name) throw new GmailError('label_name is required', 'GMAIL_INVALID_ARGS');
        const body = { name };
        if (args.text_color || args.background_color) {
          body.color = {
            ...(args.text_color ? { textColor: args.text_color } : {}),
            ...(args.background_color ? { backgroundColor: args.background_color } : {}),
          };
        }
        if (args.label_list_visibility) body.labelListVisibility = args.label_list_visibility;
        if (args.message_list_visibility) body.messageListVisibility = args.message_list_visibility;
        const result = await client.gmail('POST', `/users/${uid(args)}/labels`, { body, signal: exec.signal });
        return { labelId: result.id, name: result.name, type: result.type };
      },
    },
    {
      name: 'gmail_patch_label',
      title: 'Patch label',
      kind: 'write',
      description:
        "Patches a user-created label. System labels (INBOX, SENT, SPAM, ...) cannot be modified and will be rejected. At least one of name, messageListVisibility, labelListVisibility, or color must be provided.",
      parameters: {
        id: { type: 'string', required: true, description: 'The ID of the label to update.' },
        name: { type: 'string', description: 'The display name of the label. Must be non-empty, unique among user labels, and must not contain `,`, `/`, or `.`.' },
        color: { type: 'json', description: "The color to assign: { backgroundColor, textColor }, both from Gmail's predefined palette — arbitrary hex values or omitting either field causes a 400 error." },
        labelListVisibility: { type: 'string', enum: ['labelShow', 'labelShowIfUnread', 'labelHide'], description: 'The visibility of the label in the label list in the Gmail web interface.' },
        messageListVisibility: { type: 'string', enum: ['show', 'hide'], description: 'The visibility of messages with this label in the message list.' },
        userId: { type: 'string', description: "The user's email address or 'me'." },
      },
      async execute(args, exec) {
        if (!args.name && !args.messageListVisibility && !args.labelListVisibility && !args.color) {
          throw new GmailError('at least one of name, messageListVisibility, labelListVisibility, or color must be provided', 'GMAIL_INVALID_ARGS');
        }
        const body = {};
        if (args.name) body.name = args.name;
        if (args.labelListVisibility) body.labelListVisibility = args.labelListVisibility;
        if (args.messageListVisibility) body.messageListVisibility = args.messageListVisibility;
        if (args.color) body.color = args.color;
        const result = await client.gmail('PATCH', `/users/${args.userId ?? config.defaultUserId}/labels/${args.id}`, { body, signal: exec.signal });
        return { labelId: result.id, name: result.name, updated: true };
      },
    },
    {
      name: 'gmail_update_label',
      title: 'Update label',
      kind: 'write',
      description:
        "Updates the properties of an existing Gmail label (name, visibility settings, or color). System labels cannot be modified. At least one of name, messageListVisibility, labelListVisibility, or color must be provided.",
      parameters: {
        id: { type: 'string', required: true, description: 'The ID of the label to update.' },
        name: { type: 'string', description: 'The display name of the label.' },
        color: { type: 'json', description: 'Color settings: both backgroundColor and textColor must be provided together, from the Gmail palette.' },
        labelListVisibility: { type: 'string', enum: ['labelShow', 'labelShowIfUnread', 'labelHide'], description: 'Visibility of the label in the label list (Gmail sidebar).' },
        messageListVisibility: { type: 'string', enum: ['show', 'hide'], description: 'Visibility of messages with this label in the message list.' },
        userId: { type: 'string', description: "The user's email address or 'me'." },
      },
      async execute(args, exec) {
        if (!args.name && !args.messageListVisibility && !args.labelListVisibility && !args.color) {
          throw new GmailError('at least one of name, messageListVisibility, labelListVisibility, or color must be provided', 'GMAIL_INVALID_ARGS');
        }
        const body = {};
        if (args.name) body.name = args.name;
        if (args.labelListVisibility) body.labelListVisibility = args.labelListVisibility;
        if (args.messageListVisibility) body.messageListVisibility = args.messageListVisibility;
        if (args.color) body.color = args.color;
        const result = await client.gmail('PUT', `/users/${args.userId ?? config.defaultUserId}/labels/${args.id}`, { body, signal: exec.signal });
        return { labelId: result.id, name: result.name, updated: true };
      },
    },
    {
      name: 'gmail_delete_label',
      title: 'Delete label (permanent)',
      kind: 'write',
      description:
        "Permanently DELETES a user-created Gmail label definition from the account, removing it from all messages. WARNING: this deletes the label itself, not just from a message. System labels (INBOX, SENT, UNREAD, ...) cannot be deleted. To add/remove labels from specific messages, use gmail_add_label_to_email instead.",
      parameters: {
        label_id: { type: 'string', required: true, description: "ID of the user-created label to permanently delete (format 'Label_<id>', e.g. 'Label_1'). System labels cannot be deleted." },
        user_id: { type: 'string', description: "User's email address or 'me'." },
      },
      async execute(args, exec) {
        await client.gmail('DELETE', `/users/${uid(args)}/labels/${args.label_id}`, { signal: exec.signal });
        return { labelId: args.label_id, deleted: true, permanent: true };
      },
    },
    {
      name: 'gmail_remove_label',
      title: 'Remove label (deprecated)',
      kind: 'write',
      description:
        'DEPRECATED: use gmail_delete_label instead. Permanently deletes a user-created Gmail label by ID; cannot delete system labels.',
      parameters: {
        label_id: { type: 'string', required: true, description: 'ID of the user-created label to permanently delete; must exist and not be a system label.' },
        user_id: { type: 'string', description: "User's email address or 'me'." },
      },
      async execute(args, exec) {
        await client.gmail('DELETE', `/users/${uid(args)}/labels/${args.label_id}`, { signal: exec.signal });
        return { labelId: args.label_id, deleted: true, permanent: true, deprecated: true };
      },
    },
  ];
  return list;
}
