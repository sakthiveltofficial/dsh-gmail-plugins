/**
 * Account settings and administration tools: profile, history, IMAP/POP,
 * forwarding, vacation responder, language, send-as aliases, S/MIME, CSE, and
 * watch notifications.
 * @module @google-workspace/dsh-gmail/tools/settings
 */

import { GmailError } from '../util.js';

export function tools(ctx, deps) {
  const { client, config } = deps;
  const uid = (args) => args.user_id ?? config.defaultUserId;
  const list = [
    {
      name: 'gmail_get_profile',
      title: 'Get profile',
      kind: 'read',
      description:
        "Retrieves Gmail profile information (email address, aggregate messagesTotal/threadsTotal, historyId). messagesTotal counts individual emails; threadsTotal counts conversations; neither is per-label — use gmail_fetch_emails with label filters for label-specific counts. The returned historyId seeds incremental sync via gmail_list_history. Use the returned email address to dynamically identify the authenticated account rather than hard-coding it.",
      parameters: {
        user_id: { type: 'string', description: "The user's email address or 'me'. Prefer 'me' unless explicitly targeting another account." },
      },
      async execute(args, exec) {
        const result = await client.gmail('GET', `/users/${uid(args)}/profile`, { signal: exec.signal });
        return {
          emailAddress: result.emailAddress,
          messagesTotal: result.messagesTotal,
          threadsTotal: result.threadsTotal,
          historyId: result.historyId,
        };
      },
    },
    {
      name: 'gmail_list_history',
      title: 'List history',
      kind: 'read',
      description:
        "Lists Gmail mailbox change history since a known startHistoryId, for incremental mailbox syncs. Persist the latest historyId as a checkpoint across sessions. An empty history list is valid (no new changes). On 404 (historyIdTooOld) or 400 (invalidArgument), fetch a fresh historyId via gmail_get_profile, then do a one-time full sync via gmail_fetch_emails before resuming incremental calls.",
      parameters: {
        start_history_id: { type: 'string', required: true, description: 'Required. Returns history records after this ID. Should be a numeric string; if invalid or too old, the API returns 404 — perform a full sync in that case.' },
        user_id: { type: 'string', description: "The user's email address or 'me'." },
        label_id: { type: 'string', description: 'Only return history records involving messages with this label ID.' },
        page_token: { type: 'string', description: 'Token to retrieve a specific page of results; loop until no nextPageToken is returned.' },
        max_results: { type: 'integer', description: 'Maximum number of history records to return. Default 100; max 500.' },
        history_types: { type: 'array', items: { type: 'string' }, description: 'Filter by specific history types: messageAdded, messageDeleted, labelAdded, labelRemoved.' },
      },
      async execute(args, exec) {
        const result = await client.gmail('GET', `/users/${uid(args)}/history`, {
          query: {
            startHistoryId: args.start_history_id,
            labelId: args.label_id,
            pageToken: args.page_token,
            maxResults: args.max_results,
            historyTypes: args.history_types,
          },
          signal: exec.signal,
        });
        return { history: result.history ?? [], nextPageToken: result.nextPageToken, historyId: result.historyId, count: (result.history ?? []).length };
      },
    },
    {
      name: 'gmail_get_imap_settings',
      title: 'Get IMAP settings',
      kind: 'read',
      description: 'Retrieves the IMAP settings for a Gmail user account, including whether IMAP is enabled, auto-expunge behavior, expunge behavior, and maximum folder size.',
      parameters: {
        user_id: { type: 'string', description: "The user's email address or 'me'." },
      },
      async execute(args, exec) {
        const result = await client.gmail('GET', `/users/${uid(args)}/settings/imap`, { signal: exec.signal });
        return {
          enabled: result.enabled,
          autoExpunge: result.autoExpunge,
          expungeBehavior: result.expungeBehavior,
          maxFolderSize: result.maxFolderSize,
        };
      },
    },
    {
      name: 'gmail_update_imap_settings',
      title: 'Update IMAP settings',
      kind: 'write',
      description: 'Updates IMAP settings for a Gmail account: enable/disable IMAP, set auto-expunge behavior, or configure folder size limits.',
      parameters: {
        enabled: { type: 'boolean', description: 'Whether IMAP is enabled for the account.' },
        autoExpunge: { type: 'boolean', description: 'If true, Gmail immediately expunges a message when it is marked as deleted in IMAP.' },
        maxFolderSize: { type: 'integer', description: 'Optional limit on messages per IMAP folder. Legal values: 0 (no limit), 1000, 2000, 5000, 10000.' },
        expungeBehavior: { type: 'string', enum: ['expungeBehaviorUnspecified', 'archive', 'trash', 'deleteForever'], description: 'Action executed when a message is expunged from the last visible IMAP folder.' },
        user_id: { type: 'string', description: "The user's email address or 'me'." },
      },
      async execute(args, exec) {
        if (args.enabled === undefined && args.autoExpunge === undefined && args.maxFolderSize === undefined && args.expungeBehavior === undefined) {
          throw new GmailError('at least one IMAP setting must be provided', 'GMAIL_INVALID_ARGS');
        }
        const body = {};
        if (args.enabled !== undefined) body.enabled = args.enabled;
        if (args.autoExpunge !== undefined) body.autoExpunge = args.autoExpunge;
        if (args.maxFolderSize !== undefined) body.maxFolderSize = args.maxFolderSize;
        if (args.expungeBehavior !== undefined) body.expungeBehavior = args.expungeBehavior;
        const result = await client.gmail('PUT', `/users/${uid(args)}/settings/imap`, { body, signal: exec.signal });
        return { enabled: result.enabled, autoExpunge: result.autoExpunge, expungeBehavior: result.expungeBehavior, maxFolderSize: result.maxFolderSize, updated: true };
      },
    },
    {
      name: 'gmail_get_pop_settings',
      title: 'Get POP settings',
      kind: 'read',
      description: 'Retrieves POP settings for a Gmail account, including the access window and message disposition.',
      parameters: {
        user_id: { type: 'string', description: "The user's email address or 'me'." },
      },
      async execute(args, exec) {
        const result = await client.gmail('GET', `/users/${uid(args)}/settings/pop`, { signal: exec.signal });
        return { accessWindow: result.accessWindow, disposition: result.disposition };
      },
    },
    {
      name: 'gmail_update_pop_settings',
      title: 'Update POP settings',
      kind: 'write',
      description: 'Updates POP settings for a Gmail account: configure the POP access window or message disposition behavior.',
      parameters: {
        access_window: { type: 'string', enum: ['accessWindowUnspecified', 'disabled', 'fromNowOn', 'allMail'], description: 'The range of messages which are accessible via POP.' },
        disposition: { type: 'string', enum: ['dispositionUnspecified', 'leaveInInbox', 'archive', 'trash', 'markRead'], description: 'The action executed on a message after it has been fetched via POP.' },
        user_id: { type: 'string', description: "The user's email address or 'me'." },
      },
      async execute(args, exec) {
        if (!args.access_window && !args.disposition) {
          throw new GmailError('at least one of access_window or disposition must be provided', 'GMAIL_INVALID_ARGS');
        }
        const body = {};
        if (args.access_window) body.accessWindow = args.access_window;
        if (args.disposition) body.disposition = args.disposition;
        const result = await client.gmail('PUT', `/users/${uid(args)}/settings/pop`, { body, signal: exec.signal });
        return { accessWindow: result.accessWindow, disposition: result.disposition, updated: true };
      },
    },
    {
      name: 'gmail_get_auto_forwarding',
      title: 'Get auto-forwarding settings',
      kind: 'read',
      description: 'Retrieves the auto-forwarding setting for the account: enabled status, forwarding email address, and message disposition.',
      parameters: {
        user_id: { type: 'string', description: "The user's email address or 'me'." },
      },
      async execute(args, exec) {
        const result = await client.gmail('GET', `/users/${uid(args)}/settings/autoForwarding`, { signal: exec.signal });
        return { enabled: result.enabled, emailAddress: result.emailAddress, disposition: result.disposition };
      },
    },
    {
      name: 'gmail_list_forwarding_addresses',
      title: 'List forwarding addresses',
      kind: 'read',
      description: 'Lists all forwarding addresses allowed to be used for forwarding messages for the account.',
      parameters: {
        user_id: { type: 'string', description: "The user's email address or 'me'." },
      },
      async execute(args, exec) {
        const result = await client.gmail('GET', `/users/${uid(args)}/settings/forwardingAddresses`, { signal: exec.signal });
        return { forwardingAddresses: result.forwardingAddress ?? [], count: (result.forwardingAddress ?? []).length };
      },
    },
    {
      name: 'gmail_get_vacation_settings',
      title: 'Get vacation settings',
      kind: 'read',
      description: 'Retrieves vacation responder (out-of-office) settings for a Gmail user.',
      parameters: {
        user_id: { type: 'string', description: "The user's email address or 'me'." },
      },
      async execute(args, exec) {
        const result = await client.gmail('GET', `/users/${uid(args)}/settings/vacation`, { signal: exec.signal });
        return {
          enableAutoReply: result.enableAutoReply,
          responseSubject: result.responseSubject,
          responseBodyPlainText: result.responseBodyPlainText,
          responseBodyHtml: result.responseBodyHtml,
          restrictToContacts: result.restrictToContacts,
          restrictToDomain: result.restrictToDomain,
          startTime: result.startTime,
          endTime: result.endTime,
        };
      },
    },
    {
      name: 'gmail_update_vacation_settings',
      title: 'Update vacation settings',
      kind: 'write',
      description: 'Updates vacation responder (out-of-office auto-reply) settings. To enable auto-replies, either the response subject or body must be nonempty. If both plain text and HTML bodies are specified, the HTML body is used.',
      parameters: {
        enableAutoReply: { type: 'boolean', description: 'Controls whether Gmail automatically replies to messages.' },
        responseSubject: { type: 'string', description: 'Optional text prepended to the subject line in vacation responses.' },
        responseBodyPlainText: { type: 'string', description: 'Response body in plain text format.' },
        responseBodyHtml: { type: 'string', description: 'Response body in HTML format. Gmail sanitizes the HTML before storing. Takes precedence over plain text.' },
        restrictToContacts: { type: 'boolean', description: 'Whether responses are sent only to recipients in the contact list.' },
        restrictToDomain: { type: 'boolean', description: 'Whether responses are sent only to recipients inside the user\'s domain (Workspace only).' },
        startTime: { type: 'string', description: 'Optional start time for sending auto-replies (epoch ms). If both start and end are specified, start must precede end.' },
        endTime: { type: 'string', description: 'Optional end time for sending auto-replies (epoch ms). Gmail replies only to messages received before the end time.' },
        userId: { type: 'string', description: "The user's email address or 'me'." },
      },
      async execute(args, exec) {
        const body = {};
        for (const key of ['enableAutoReply', 'responseSubject', 'responseBodyPlainText', 'responseBodyHtml', 'restrictToContacts', 'restrictToDomain', 'startTime', 'endTime']) {
          if (args[key] !== undefined) body[key] = args[key];
        }
        if (Object.keys(body).length === 0) {
          throw new GmailError('at least one vacation setting must be provided', 'GMAIL_INVALID_ARGS');
        }
        const result = await client.gmail('PUT', `/users/${args.userId ?? config.defaultUserId}/settings/vacation`, { body, signal: exec.signal });
        return { enableAutoReply: result.enableAutoReply, responseSubject: result.responseSubject, updated: true };
      },
    },
    {
      name: 'gmail_get_language_settings',
      title: 'Get language settings',
      kind: 'read',
      description: 'Retrieves the display language preference for the authenticated user or a specific Gmail account.',
      parameters: {
        user_id: { type: 'string', description: "The user's email address or 'me'." },
      },
      async execute(args, exec) {
        const result = await client.gmail('GET', `/users/${uid(args)}/settings/language`, { signal: exec.signal });
        return { displayLanguage: result.displayLanguage };
      },
    },
    {
      name: 'gmail_update_language_settings',
      title: 'Update language settings',
      kind: 'write',
      description:
        "Updates the display language preference. The returned displayLanguage may differ from the requested value if Gmail selects a close variant.",
      parameters: {
        display_language: { type: 'string', required: true, description: "The language to display Gmail in, as an RFC 3066 Language Tag (e.g. 'en-GB', 'fr', 'ja', 'es', 'de', 'en'). Gmail may save a close variant if the requested language is not directly supported." },
        user_id: { type: 'string', description: "The user's email address or 'me'." },
      },
      async execute(args, exec) {
        const result = await client.gmail('PUT', `/users/${uid(args)}/settings/language`, { body: { displayLanguage: args.display_language }, signal: exec.signal });
        return { displayLanguage: result.displayLanguage, updated: true };
      },
    },
    {
      name: 'gmail_list_send_as',
      title: 'List send-as aliases',
      kind: 'read',
      description: "Lists the send-as aliases for a Gmail account, including the primary address and custom 'from' aliases — the available sending addresses for composing emails.",
      parameters: {
        user_id: { type: 'string', description: "The user's email address or 'me'." },
      },
      async execute(args, exec) {
        const result = await client.gmail('GET', `/users/${uid(args)}/settings/sendAs`, { signal: exec.signal });
        return { sendAs: result.sendAs ?? [], count: (result.sendAs ?? []).length };
      },
    },
    {
      name: 'gmail_get_send_as',
      title: 'Get send-as alias',
      kind: 'read',
      description:
        "Retrieves a specific send-as alias configuration: display name, signature, SMTP settings, and verification status. Fails with HTTP 404 if the address is not a member of the send-as collection.",
      parameters: {
        send_as_email: { type: 'string', required: true, description: "The send-as alias email address to retrieve (appears in the 'From' header)." },
        user_id: { type: 'string', description: "The user's email address or 'me'." },
      },
      async execute(args, exec) {
        const result = await client.gmail('GET', `/users/${uid(args)}/settings/sendAs/${encodeURIComponent(args.send_as_email)}`, { signal: exec.signal });
        return sendAsView(result);
      },
    },
    {
      name: 'gmail_patch_send_as',
      title: 'Patch send-as alias',
      kind: 'write',
      description:
        "Patches an existing send-as alias: display name, reply-to address, signature, default status, or SMTP configuration. Addresses other than the primary can only be updated by service accounts with domain-wide authority.",
      parameters: {
        send_as_email: { type: 'string', required: true, description: "The send-as alias email address to update (appears in the 'From' header)." },
        display_name: { type: 'string', description: "A name that appears in the 'From' header for mail sent using this alias. If the admin has disabled name updates, requests to update the primary login silently fail." },
        reply_to_address: { type: 'string', description: "Optional email address for the 'Reply-To' header. Gmail omits the header if empty." },
        signature: { type: 'string', description: 'Optional HTML signature included in messages composed with this alias in the Gmail web UI. Added to new emails only. Gmail sanitizes HTML before saving.' },
        is_default: { type: 'boolean', description: "Whether this address is the default 'From' address. Setting true makes other send-as addresses non-default. Only true can be written." },
        treat_as_alias: { type: 'boolean', description: "Whether Gmail treats this address as an alias for the user's primary email. Only applies to custom 'from' aliases." },
        smtp_msa: { type: 'json', description: 'SMTP relay configuration: { host, port, securityMode, username, password, verifyCertificate? }.' },
        user_id: { type: 'string', description: "The user's email address or 'me'." },
      },
      async execute(args, exec) {
        const body = sendAsPatchBody(args);
        if (Object.keys(body).length === 0) {
          throw new GmailError('at least one send-as property must be provided', 'GMAIL_INVALID_ARGS');
        }
        const result = await client.gmail('PATCH', `/users/${uid(args)}/settings/sendAs/${encodeURIComponent(args.send_as_email)}`, { body, signal: exec.signal });
        return { ...sendAsView(result), updated: true };
      },
    },
    {
      name: 'gmail_update_send_as',
      title: 'Update send-as alias',
      kind: 'write',
      description:
        "Updates a send-as alias: display name, signature, reply-to address, default status, or SMTP settings. Gmail sanitizes HTML signatures before saving. Addresses other than the primary can only be updated by service accounts with domain-wide authority.",
      parameters: {
        send_as_email: { type: 'string', required: true, description: "The send-as alias email address to update (appears in the 'From' header)." },
        display_name: { type: 'string', description: "Name to appear in the 'From' header. For custom from addresses, Gmail populates with the primary account name if empty." },
        reply_to_address: { type: 'string', description: "Optional email address for the 'Reply-To' header. Gmail omits the header if empty." },
        signature: { type: 'string', description: 'Optional HTML signature for messages composed with this alias in the Gmail web UI. Added to new emails only.' },
        is_default: { type: 'boolean', description: "Set true to make this the default 'From' address. Only legal writable value is true." },
        treat_as_alias: { type: 'boolean', description: "Whether Gmail treats this address as an alias for the user's primary email. Only applies to custom from aliases." },
        smtp_msa: { type: 'json', description: 'SMTP relay configuration: { host, port, securityMode, username, password, verifyCertificate? }.' },
        user_id: { type: 'string', description: "The user's email address or 'me'." },
      },
      async execute(args, exec) {
        const body = sendAsPatchBody(args);
        if (Object.keys(body).length === 0) {
          throw new GmailError('at least one send-as property must be provided', 'GMAIL_INVALID_ARGS');
        }
        const result = await client.gmail('PUT', `/users/${uid(args)}/settings/sendAs/${encodeURIComponent(args.send_as_email)}`, { body, signal: exec.signal });
        return { ...sendAsView(result), updated: true };
      },
    },
    {
      name: 'gmail_list_smime_info',
      title: 'List S/MIME configs',
      kind: 'read',
      description: 'Lists the S/MIME certificate configurations associated with a specific send-as email address.',
      parameters: {
        send_as_email: { type: 'string', required: true, description: "The email address that appears in the 'From' header for mail sent using this alias." },
        user_id: { type: 'string', description: "The user's email address or 'me'." },
      },
      async execute(args, exec) {
        const result = await client.gmail('GET', `/users/${uid(args)}/settings/sendAs/${encodeURIComponent(args.send_as_email)}/smimeInfo`, { signal: exec.signal });
        return { smimeInfo: result.smimeInfo ?? [], count: (result.smimeInfo ?? []).length };
      },
    },
    {
      name: 'gmail_list_cse_identities',
      title: 'List CSE identities',
      kind: 'read',
      description: 'Lists client-side encrypted (CSE) identities for the authenticated user, including key pair associations.',
      parameters: {
        user_id: { type: 'string', description: "The requester's primary email address or 'me'." },
        page_size: { type: 'integer', description: 'The number of identities to return; defaults to 20.' },
        page_token: { type: 'string', description: 'Pagination token indicating which page of identities to return.' },
      },
      async execute(args, exec) {
        const result = await client.gmail('GET', `/users/${uid(args)}/cse/identities`, {
          query: { pageSize: args.page_size, pageToken: args.page_token },
          signal: exec.signal,
        });
        return { identities: result.identities ?? [], nextPageToken: result.nextPageToken, count: (result.identities ?? []).length };
      },
    },
    {
      name: 'gmail_list_cse_keypairs',
      title: 'List CSE key pairs',
      kind: 'read',
      description: 'Lists client-side encryption (CSE) key pairs, including public keys and enablement states. Supports pagination.',
      parameters: {
        user_id: { type: 'string', description: "The requester's primary email address or 'me'." },
        page_size: { type: 'integer', description: 'The number of key pairs to return per page; defaults to 20.' },
        page_token: { type: 'string', description: 'Pagination token; omit for the first page.' },
      },
      async execute(args, exec) {
        const result = await client.gmail('GET', `/users/${uid(args)}/cse/keypairs`, {
          query: { pageSize: args.page_size, pageToken: args.page_token },
          signal: exec.signal,
        });
        return { keyPairs: result.keyPairs ?? [], nextPageToken: result.nextPageToken, count: (result.keyPairs ?? []).length };
      },
    },
    {
      name: 'gmail_stop_watch',
      title: 'Stop watch notifications',
      kind: 'write',
      description: 'Stops receiving push notifications for a Gmail mailbox, disabling watch notifications previously set up via the watch endpoint.',
      parameters: {
        user_id: { type: 'string', description: "The user's email address or 'me'." },
      },
      async execute(args, exec) {
        await client.gmail('POST', `/users/${uid(args)}/stop`, { signal: exec.signal });
        return { watching: false, stopped: true };
      },
    },
  ];
  return list;
}

/** Map snake_case send-as args onto the Gmail sendAs resource body keys. */
function sendAsPatchBody(args) {
  const body = {};
  if (args.display_name !== undefined) body.displayName = args.display_name;
  if (args.reply_to_address !== undefined) body.replyToAddress = args.reply_to_address;
  if (args.signature !== undefined) body.signature = args.signature;
  if (args.is_default !== undefined) body.isDefault = args.is_default;
  if (args.treat_as_alias !== undefined) body.treatAsAlias = args.treat_as_alias;
  if (args.smtp_msa !== undefined) body.smtpMsa = args.smtp_msa;
  return body;
}

/** Normalize a sendAs resource into a flat view. */
function sendAsView(result) {
  return {
    sendAsEmail: result.sendAsEmail,
    displayName: result.displayName,
    replyToAddress: result.replyToAddress,
    signature: result.signature,
    isDefault: result.isDefault,
    isPrimary: result.isPrimary,
    treatAsAlias: result.treatAsAlias,
    verificationStatus: result.verificationStatus,
    smtpMsa: result.smtpMsa,
  };
}
