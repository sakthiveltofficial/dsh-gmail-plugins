/**
 * Filter tools: list, get, create, and delete Gmail filters (rules).
 * @module @google-workspace/dsh-gmail/tools/filters
 */

import { GmailError } from '../util.js';

const CRITERIA_DESC =
  "REQUIRED. Message matching criteria. At least one criteria field must be specified: from, to, subject, query, negatedQuery, size, sizeComparison, or hasTheWord / doesNotHaveTheWord.";
const ACTION_DESC =
  "REQUIRED. Action the filter performs on matching messages. At least one action field must be specified: addLabelIds, removeLabelIds, forward, or (Workspace only) markImportant / markAsRead / archive / neverSpam.";

export function tools(ctx, deps) {
  const { client, config } = deps;
  const uid = (args) => args.user_id ?? config.defaultUserId;
  const list = [
    {
      name: 'gmail_list_filters',
      title: 'List filters',
      kind: 'read',
      description:
        'Lists all Gmail filters (rules) in the mailbox. Use for security audits to detect malicious filter rules, or before creating new filters to avoid duplicates.',
      parameters: {
        user_id: { type: 'string', description: "The user's email address or 'me'." },
      },
      async execute(args, exec) {
        const result = await client.gmail('GET', `/users/${uid(args)}/settings/filters`, { signal: exec.signal });
        return { filters: result.filter ?? [], count: (result.filter ?? []).length };
      },
    },
    {
      name: 'gmail_get_filter',
      title: 'Get filter',
      kind: 'read',
      description: 'Retrieves a specific Gmail filter by its ID, including its criteria and actions.',
      parameters: {
        id: { type: 'string', required: true, description: 'The ID of the filter to fetch.' },
        user_id: { type: 'string', description: "The user's email address or 'me'." },
      },
      async execute(args, exec) {
        const result = await client.gmail('GET', `/users/${uid(args)}/settings/filters/${args.id}`, { signal: exec.signal });
        return { id: result.id, criteria: result.criteria, action: result.action };
      },
    },
    {
      name: 'gmail_create_filter',
      title: 'Create filter',
      kind: 'write',
      description:
        'Creates a new Gmail filter with specified criteria and actions, automatically organizing incoming messages. You can create a maximum of 1,000 filters per account.',
      parameters: {
        criteria: { type: 'json', required: true, description: CRITERIA_DESC },
        action: { type: 'json', required: true, description: ACTION_DESC },
        user_id: { type: 'string', description: "The user's email address or 'me'." },
      },
      async execute(args, exec) {
        if (!args.criteria || !args.action) {
          throw new GmailError('criteria and action are both required', 'GMAIL_INVALID_ARGS');
        }
        const result = await client.gmail('POST', `/users/${uid(args)}/settings/filters`, {
          body: { criteria: args.criteria, action: args.action },
          signal: exec.signal,
        });
        return { id: result.id, criteria: result.criteria, action: result.action, created: true };
      },
    },
    {
      name: 'gmail_delete_filter',
      title: 'Delete filter',
      kind: 'write',
      description: 'Permanently deletes a Gmail filter by its ID, removing the filtering rule.',
      parameters: {
        filter_id: { type: 'string', required: true, description: 'The ID of the filter to delete, from gmail_list_filters.' },
        user_id: { type: 'string', description: "The user's email address or 'me'." },
      },
      async execute(args, exec) {
        await client.gmail('DELETE', `/users/${uid(args)}/settings/filters/${args.filter_id}`, { signal: exec.signal });
        return { filterId: args.filter_id, deleted: true, permanent: true };
      },
    },
  ];
  return list;
}
