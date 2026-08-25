/**
 * Contacts / People API tools: get contacts (connections), get people (one
 * person or Other Contacts), and search people.
 * @module @google-workspace/dsh-gmail/tools/people
 */

const OTHER_CONTACTS_FIELDS = ['emailAddresses', 'metadata', 'names', 'phoneNumbers'];

function normalizePerson(person) {
  return {
    resourceName: person.resourceName,
    etag: person.etag,
    names: (person.names ?? []).map((n) => ({ displayName: n.displayName, givenName: n.givenName, familyName: n.familyName })),
    emailAddresses: (person.emailAddresses ?? []).map((e) => ({ value: e.value, type: e.type })),
    phoneNumbers: (person.phoneNumbers ?? []).map((p) => ({ value: p.value, type: p.type })),
    organizations: (person.organizations ?? []).map((o) => ({ name: o.name, title: o.title, department: o.department })),
    birthdays: (person.birthdays ?? []).map((b) => b.date),
    genders: (person.genders ?? []).map((g) => g.value),
    ...(person.contactSource ? { contactSource: person.contactSource } : {}),
  };
}

export function tools(ctx, deps) {
  const { client } = deps;
  const list = [
    {
      name: 'gmail_get_contacts',
      title: 'Get contacts',
      kind: 'read',
      description:
        "Fetches contacts (connections) for the authenticated Google account with field selection and pagination. Only covers saved contacts and 'Other Contacts'; email-header-only senders are out of scope (use gmail_fetch_emails for those). Contact records may have sparse data — handle missing fields gracefully. People API shares a per-user QPS quota; HTTP 429 requires exponential backoff (1s, 2s, 4s).",
      parameters: {
        resource_name: { type: 'string', description: "Identifier for the person resource whose connections are listed; use 'people/me' for the authenticated user." },
        person_fields: { type: 'string', description: "Comma-separated person fields to retrieve (e.g. 'names,emailAddresses')." },
        page_token: { type: 'string', description: "Token from a previous response's nextPageToken. Repeat until nextPageToken is absent — stopping early silently omits contacts." },
        include_other_contacts: { type: 'boolean', description: "Include 'Other Contacts' (interacted with but not explicitly saved) in addition to regular contacts. WARNING: they often lack names/phones even when requested. When true, person_fields is restricted to emailAddresses, names, phoneNumbers, and metadata only." },
      },
      async execute(args, exec) {
        const resourceName = args.resource_name ?? 'people/me';
        const fields = args.person_fields ?? 'names,emailAddresses';
        const result = await client.people('GET', `/people/${encodeURIComponent(resourceName.replace(/^people\//, ''))}/connections`, {
          query: { personFields: fields, pageToken: args.page_token, pageSize: 100, sortOrder: 'LAST_MODIFIED_ASCENDING' },
          signal: exec.signal,
        });
        const contacts = (result.connections ?? []).map(normalizePerson);
        return { contacts, nextPageToken: result.nextPageToken, totalItems: result.totalItems, count: contacts.length };
      },
    },
    {
      name: 'gmail_get_people',
      title: 'Get people',
      kind: 'read',
      description:
        "Retrieves either a specific person's details (using resource_name) or lists 'Other Contacts' (if other_contacts is true), with person_fields specifying the data to return. Scope is limited to the authenticated user's own contacts and 'Other Contacts' history.",
      parameters: {
        resource_name: { type: 'string', description: 'Resource name identifying the person to retrieve (e.g. people/me or a contact resource name). Used only when other_contacts is false.' },
        other_contacts: { type: 'boolean', description: "If true, retrieves 'Other Contacts' (ignoring resource_name, enabling pagination/sync). If false, retrieves the single person specified by resource_name." },
        person_fields: { type: 'string', description: "Comma-separated field mask (e.g. 'names,emailAddresses'). Omitted fields are silently absent. With other_contacts=true, only emailAddresses, names, phoneNumbers, metadata are valid." },
        page_size: { type: 'integer', description: 'Number of Other Contacts to return per page. Only when other_contacts is true.' },
        page_token: { type: 'string', description: 'Opaque token from a previous response to fetch the next page of Other Contacts.' },
        sync_token: { type: 'string', description: "Token from a previous Other Contacts list call to retrieve only changes since the last sync; leave empty for an initial full sync." },
        sources: { type: 'array', items: { type: 'string' }, description: "Source types for Other Contacts: READ_SOURCE_TYPE_CONTACT supports basic fields; READ_SOURCE_TYPE_PROFILE supports extended fields but requires READ_SOURCE_TYPE_CONTACT to also be included." },
      },
      async execute(args, exec) {
        if (args.other_contacts) {
          const result = await client.people('GET', '/people/me/otherContacts', {
            query: {
              readMask: args.person_fields ?? OTHER_CONTACTS_FIELDS.join(','),
              pageSize: args.page_size,
              pageToken: args.page_token,
              syncToken: args.sync_token,
              sources: args.sources,
            },
            signal: exec.signal,
          });
          const contacts = (result.otherContacts ?? []).map(normalizePerson);
          return { contacts, nextPageToken: result.nextPageToken, nextSyncToken: result.nextSyncToken, count: contacts.length };
        }
        const resourceName = args.resource_name ?? 'people/me';
        const result = await client.people('GET', `/people/${encodeURIComponent(resourceName.replace(/^people\//, ''))}`, {
          query: { personFields: args.person_fields ?? 'names,emailAddresses,phoneNumbers,organizations,birthdays,genders' },
          signal: exec.signal,
        });
        return { person: normalizePerson(result) };
      },
    },
    {
      name: 'gmail_search_people',
      title: 'Search people',
      kind: 'read',
      description:
        "Searches contacts by matching the query against names, nicknames, emails, phone numbers, and organizations, optionally including 'Other Contacts'. Only searches the authenticated user's contact directory — people existing solely in message headers won't appear (use gmail_fetch_emails for those). Results may be zero or multiple; never auto-select from ambiguous results. Follow next_page_token until empty and deduplicate by email.",
      parameters: {
        query: { type: 'string', required: true, description: 'Matches contact names, nicknames, email addresses, phone numbers, and organization fields.' },
        page_size: { type: 'integer', description: 'Maximum results to return; values > 30 are capped to 30 by the API.' },
        person_fields: { type: 'string', description: "Comma-separated fields to return (e.g. 'names,emailAddresses'). When other_contacts is true, only emailAddresses, metadata, names, phoneNumbers are allowed." },
        other_contacts: { type: 'boolean', description: "When true, searches both saved contacts and 'Other Contacts' but restricts person_fields to emailAddresses, metadata, names, phoneNumbers. When false, searches saved contacts only with all person_fields available." },
      },
      async execute(args, exec) {
        const result = await client.people('GET', '/people:searchContacts', {
          query: {
            query: args.query,
            pageSize: args.page_size ?? 30,
            readMask: args.person_fields ?? (args.other_contacts ? OTHER_CONTACTS_FIELDS.join(',') : 'names,emailAddresses,phoneNumbers,organizations'),
          },
          signal: exec.signal,
        });
        const contacts = (result.results ?? []).map((r) => normalizePerson(r.person));
        return { contacts, count: contacts.length, totalSize: result.totalSize };
      },
    },
  ];
  return list;
}
