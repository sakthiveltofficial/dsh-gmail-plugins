/**
 * RFC 2822 / MIME construction and payload parsing for Gmail messages.
 *
 * `buildMime` produces the raw source that tools base64url-encode into the
 * Gmail `raw` field. `extractText` / `extractAttachments` / `headersOf` walk a
 * fetched message's `payload` tree so fetch tools can present bodies and
 * attachment metadata without dumping the whole MIME structure.
 * @module @google-workspace/dsh-gmail/mime
 */

import { readFile } from 'node:fs/promises';
import { fromBase64Url } from './util.js';

/** RFC 2047 encode a header value when it contains non-ASCII or control bytes. */
export function encodeHeaderWord(text) {
  const value = String(text ?? '');
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** Format one recipient entry: `email` or `Name <email>` with encoded name. */
export function formatAddress(entry) {
  const value = String(entry ?? '').trim();
  if (value.length === 0) return '';
  const match = /^(.*?)<([^>]+)>$/.exec(value);
  if (match) {
    const name = match[1].trim();
    return name.length > 0 ? `${encodeHeaderWord(name)} <${match[2].trim()}>` : match[2].trim();
  }
  return value;
}

/** Format a recipient list into a header value. */
export function formatAddressList(list) {
  if (list === undefined || list === null) return '';
  const entries = Array.isArray(list) ? list : [list];
  return entries.map(formatAddress).filter((v) => v.length > 0).join(', ');
}

function generateMessageId() {
  const suffix = Math.random().toString(36).slice(2, 12);
  return `<dsh-gmail-${Date.now().toString(36)}-${suffix}>`;
}

/** Load attachment bytes from a local path, a public URL, or an inline object. */
export async function loadAttachment(input) {
  if (typeof input === 'string') {
    if (/^https?:\/\//i.test(input)) {
      const response = await fetch(input);
      if (!response.ok) {
        throw new Error(`attachment download failed: ${input} (HTTP ${response.status})`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      const name = decodeURIComponent(input.split('/').pop()?.split('?')[0] ?? 'attachment');
      return { name, mimetype: guessMime(name), bytes };
    }
    const bytes = await readFile(input);
    const name = input.split('/').pop() ?? 'attachment';
    return { name, mimetype: guessMime(name), bytes };
  }
  if (typeof input === 'object' && input !== null) {
    const name = input.name ?? input.filename ?? 'attachment';
    const mimetype = input.mimetype ?? input.mimeType ?? guessMime(name);
    if (input.base64) {
      return { name, mimetype, bytes: Buffer.from(input.base64, 'base64') };
    }
    if (input.base64url || input.contentBase64) {
      return { name, mimetype, bytes: Buffer.from(input.base64url ?? input.contentBase64, 'base64url') };
    }
    if (input.path) return loadAttachment(input.path);
    if (input.url) return loadAttachment(input.url);
    throw new Error(`attachment object needs one of base64, base64url, path, or url (got ${Object.keys(input).join(', ') || 'nothing'})`);
  }
  throw new Error(`attachment must be a path, URL, or { name, mimetype, base64 } object (got ${typeof input})`);
}

const MIME_BY_EXT = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', txt: 'text/plain',
  csv: 'text/csv', html: 'text/html', htm: 'text/html', md: 'text/markdown',
  json: 'application/json', zip: 'application/zip', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  mp4: 'video/mp4', mp3: 'audio/mpeg', mov: 'video/quicktime',
};

/** Guess a MIME type from a filename; defaults to octet-stream. */
export function guessMime(name) {
  const ext = String(name).split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/** One MIME part builder with RFC 2047 headers and proper boundary handling. */
function part({ headers, body }) {
  const lines = [];
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (value === undefined || value === null || String(value).length === 0) continue;
    lines.push(`${name}: ${value}`);
  }
  lines.push('', body);
  return lines.join('\r\n');
}

/**
 * Build a complete RFC 2822 message source.
 * @param options - from/to/cc/bcc/subject/body/isHtml/attachments/inReplyTo/references
 * @returns a Promise of the raw message text (base64url-encoded into Gmail `raw`).
 */
export async function buildMime(options) {
  const { from, to, cc, bcc, subject = '', body = '', isHtml = false, attachments = [], inReplyTo, references } = options;
  const headers = {
    'MIME-Version': '1.0',
    'Date': new Date().toUTCString(),
    'Message-ID': generateMessageId(),
    'From': formatAddress(from),
    'To': formatAddressList(to),
    'Cc': formatAddressList(cc),
    'Bcc': formatAddressList(bcc),
    'Subject': encodeHeaderWord(subject),
    ...(inReplyTo ? { 'In-Reply-To': inReplyTo } : {}),
    ...(references ? { 'References': references } : {}),
  };
  const loaded = (Array.isArray(attachments) ? attachments : [attachments]).filter((v) => v !== undefined && v !== null);

  const textBody = isHtml ? '' : body;
  const htmlBody = isHtml ? body : htmlEscape(body);

  const bodyParts = [];
  if (textBody.length > 0) bodyParts.push(part({ headers: { 'Content-Type': 'text/plain; charset=UTF-8', 'Content-Transfer-Encoding': 'base64' }, body: Buffer.from(textBody, 'utf8').toString('base64') }));
  if (htmlBody.length > 0) bodyParts.push(part({ headers: { 'Content-Type': 'text/html; charset=UTF-8', 'Content-Transfer-Encoding': 'base64' }, body: Buffer.from(htmlBody, 'utf8').toString('base64') }));

  let content;
  if (loaded.length === 0 && bodyParts.length <= 1) {
    // Simple single-part message.
    const single = bodyParts[0] ?? part({
      headers: { 'Content-Type': 'text/plain; charset=UTF-8', 'Content-Transfer-Encoding': 'base64' },
      body: Buffer.from(textBody, 'utf8').toString('base64'),
    });
    content = single;
  } else if (loaded.length === 0) {
    // Both text and html: multipart/alternative.
    const boundary = `dsh-alt-${Math.random().toString(36).slice(2, 14)}`;
    headers['Content-Type'] = `multipart/alternative; boundary="${boundary}"`;
    content = ['', ...bodyParts.map((p) => `--${boundary}\r\n${p}`), `--${boundary}--`, ''].join('\r\n');
  } else {
    // Attachments present: multipart/mixed with an optional alternative subtree.
    const boundary = `dsh-mix-${Math.random().toString(36).slice(2, 14)}`;
    headers['Content-Type'] = `multipart/mixed; boundary="${boundary}"`;
    const inner = [];
    if (bodyParts.length > 0) {
      if (bodyParts.length === 1) {
        inner.push(bodyParts[0]);
      } else {
        const altBoundary = `dsh-alt-${Math.random().toString(36).slice(2, 14)}`;
        inner.push(part({
          headers: { 'Content-Type': `multipart/alternative; boundary="${altBoundary}"` },
          body: `\r\n${bodyParts.map((p) => `--${altBoundary}\r\n${p}`).join('\r\n')}\r\n--${altBoundary}--`,
        }));
      }
    }
    const attachParts = [];
    for (const item of loaded) {
      const loadedItem = item && typeof item === 'object' && !item.base64 && !item.base64url && !item.path && !item.url && item.bytes
        ? item
        : await loadAttachment(item);
      const bytes = loadedItem.bytes ?? Buffer.alloc(0);
      const name = encodeHeaderWord(loadedItem.name ?? 'attachment');
      attachParts.push(part({
        headers: {
          'Content-Type': `${loadedItem.mimetype ?? guessMime(loadedItem.name ?? '')}; name="${name}"`,
          'Content-Transfer-Encoding': 'base64',
          'Content-Disposition': `attachment; filename="${name}"`,
        },
        body: bytes.toString('base64').replace(/(.{76})/g, '$1\r\n'),
      }));
    }
    content = ['', ...inner.map((p) => `--${boundary}\r\n${p}`), ...attachParts.map((p) => `--${boundary}\r\n${p}`), `--${boundary}--`, ''].join('\r\n');
  }
  return part({ headers, body: content });
}

/** Escape plain text into HTML paragraphs for non-HTML bodies. */
function htmlEscape(text) {
  return String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .split(/\r?\n/).map((line) => line.trim().length === 0 ? '<br/>' : `<div>${line}</div>`)
    .join('');
}

/** Decode one MIME part's body from its transfer encoding. */
export function decodePartBody(partData) {
  const data = partData?.body?.data;
  if (!data) return '';
  const encoding = (partData?.body?.encoding ?? '').toLowerCase();
  if (encoding === 'base64' || typeof data === 'string') return fromBase64Url(data);
  return String(data);
}

/**
 * Walk a message payload tree and extract plain-text and HTML bodies plus
 * inline-visible text, preferring the leaf-most parts.
 */
export function extractText(payload) {
  const found = { text: '', html: '' };
  const walk = (node, depth) => {
    if (!node) return;
    const mime = node.mimeType ?? '';
    if (node.parts && node.parts.length > 0) {
      for (const child of node.parts) walk(child, depth + 1);
      return;
    }
    if (mime === 'text/plain' && !found.text) found.text = decodePartBody(node);
    if (mime === 'text/html' && !found.html) found.html = decodePartBody(node);
  };
  walk(payload, 0);
  return found;
}

/** List attachments (parts with a filename or attachmentId) from a payload tree. */
export function extractAttachments(payload) {
  const result = [];
  const walk = (node) => {
    if (!node) return;
    if (node.parts) {
      for (const child of node.parts) walk(child);
      return;
    }
    const filename = node.filename;
    if (filename || node.body?.attachmentId) {
      result.push({
        filename: filename || '',
        mimetype: node.mimeType ?? 'application/octet-stream',
        attachmentId: node.body?.attachmentId,
        size: node.body?.size,
      });
    }
  };
  walk(payload);
  return result;
}

/** Read the most important headers of a message into a flat object. */
export function headersOf(message) {
  const headers = message?.payload?.headers ?? [];
  const wanted = ['From', 'To', 'Cc', 'Bcc', 'Subject', 'Date', 'Reply-To', 'Message-ID', 'References', 'In-Reply-To'];
  const out = {};
  for (const header of headers) {
    if (wanted.includes(header.name)) out[header.name] = header.value;
  }
  return out;
}
