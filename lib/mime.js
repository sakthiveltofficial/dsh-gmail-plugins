/**
 * RFC 2822 / MIME construction and payload parsing for Gmail messages.
 *
 * `buildMime` produces the raw source that tools base64url-encode into the
 * Gmail `raw` field. `extractText` / `extractAttachments` / `headersOf` walk a
 * fetched message's `payload` tree so fetch tools can present bodies and
 * attachment metadata without dumping the whole MIME structure.
 * @module @google-workspace/dsh-gmail/mime
 */

import { readFile, stat } from 'node:fs/promises';
import { lookup as dnsLookup } from 'node:dns/promises';
import path from 'node:path';
import { fromBase64Url, GmailError, hasControlChars, isValidHeaderName, stripControlChars } from './util.js';

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
  if (hasControlChars(value)) {
    throw new GmailError('invalid address: control characters (CR/LF) are not allowed in recipient/sender addresses', 'GMAIL_INVALID_ADDRESS');
  }
  const match = /^(.*?)<([^>]+)>$/.exec(value);
  if (match) {
    const name = match[1].trim();
    const email = match[2].trim();
    if (email.includes('<') || email.includes('>')) {
      throw new GmailError(`invalid address: malformed bracketed address ${JSON.stringify(value)}`, 'GMAIL_INVALID_ADDRESS');
    }
    return name.length > 0 ? `${encodeHeaderWord(name)} <${email}>` : email;
  }
  // Bare address: reject anything that is not a plain address (no whitespace,
  // angle brackets, or commas), so crafted values cannot smuggle headers.
  if (!/^[^\s<>@,]+@[^\s<>@,]+$/.test(value)) {
    throw new GmailError(`invalid address: expected 'user@example.com' (got ${JSON.stringify(value)})`, 'GMAIL_INVALID_ADDRESS');
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

/** Sanitize a Message-ID / References value echoed from inbound mail. */
function sanitizeMessageIds(value) {
  return stripControlChars(value).slice(0, 900);
}

/** Defaults for attachment loading policy (see `resolveLimits`). */
const ATTACHMENT_DEFAULTS = Object.freeze({
  maxBytes: 20 * 1024 * 1024,
  timeoutMs: 15000,
  allowRemote: true,
  allowLocal: true,
});

/**
 * Normalize attachment policy options (from config or per-call overrides) into
 * a limits object. Accepts config names (`maxAttachmentBytes`,
 * `attachmentFetchTimeoutMs`, `allowRemoteAttachments`, `allowLocalAttachments`,
 * `attachmentRoot`) and internal names (`maxBytes`, `timeoutMs`, `allowRemote`,
 * `allowLocal`, `allowedRoots`).
 */
export function resolveLimits(options = {}) {
  const rawRoots = options.allowedRoots !== undefined && options.allowedRoots !== null && options.allowedRoots !== ''
    ? (Array.isArray(options.allowedRoots) ? options.allowedRoots : attachmentRoots(options.allowedRoots))
    : attachmentRoots(options.attachmentRoot);
  return {
    maxBytes: positiveInt(options.maxBytes ?? options.maxAttachmentBytes, ATTACHMENT_DEFAULTS.maxBytes),
    timeoutMs: positiveInt(options.timeoutMs ?? options.attachmentFetchTimeoutMs, ATTACHMENT_DEFAULTS.timeoutMs),
    allowRemote: options.allowRemote ?? options.allowRemoteAttachments ?? ATTACHMENT_DEFAULTS.allowRemote,
    allowLocal: options.allowLocal ?? options.allowLocalAttachments ?? ATTACHMENT_DEFAULTS.allowLocal,
    allowedRoots: rawRoots,
  };
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Expand a `attachmentRoot` config value (path or ;/,-separated list) into absolute roots. */
function attachmentRoots(value) {
  if (value === undefined || value === null || value === '') return [];
  const items = Array.isArray(value) ? value : String(value).split(/[;,]/);
  return items.map((s) => s.trim()).filter(Boolean).map((s) => path.resolve(s));
}

/**
 * Resolve an attachment-related path under the configured root policy.
 * - With `attachmentRoot` set: the path must resolve inside one of the roots
 *   (relative paths resolve against the first root).
 * - Without it: only relative paths that stay inside the process working
 *   directory are allowed; absolute paths are rejected.
 * @returns the resolved absolute path
 */
export function resolveAllowedPath(input, allowedRoots) {
  const raw = String(input ?? '');
  if (raw.length === 0) throw new GmailError('empty path', 'GMAIL_ATTACHMENT_POLICY');
  const roots = allowedRoots ?? [];
  if (roots.length > 0) {
    const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(roots[0], raw);
    if (!isInsideAny(abs, roots)) {
      throw new GmailError(`path is outside the configured attachment root (${roots.join(', ')}): ${raw}`, 'GMAIL_ATTACHMENT_POLICY');
    }
    return abs;
  }
  if (path.isAbsolute(raw)) {
    throw new GmailError('absolute attachment paths are disabled by default — set the plugin attachmentRoot config option to allow one or more directories', 'GMAIL_ATTACHMENT_POLICY');
  }
  const abs = path.resolve(raw);
  if (!isInsideAny(abs, [process.cwd()])) {
    throw new GmailError(`attachment path escapes the working directory: ${raw}`, 'GMAIL_ATTACHMENT_POLICY');
  }
  return abs;
}

function isInsideAny(child, parents) {
  for (const parent of parents) {
    const rel = path.relative(parent, child);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return true;
  }
  return false;
}

/**
 * Load attachment bytes from a local path, a public URL, or an inline object.
 * Enforces the attachment policy: path allowlist, SSRF guard on remote URLs,
 * per-attachment byte cap, and download timeout.
 */
export async function loadAttachment(input, options = {}) {
  const limits = resolveLimits(options);
  if (typeof input === 'string') {
    if (/^https?:\/\//i.test(input)) {
      if (!limits.allowRemote) {
        throw new GmailError('remote attachment URLs are disabled by the plugin config (allowRemoteAttachments=false)', 'GMAIL_ATTACHMENT_POLICY');
      }
      const bytes = await fetchAttachmentBytes(input, limits);
      const name = safeDecodeURIComponent(input.split('/').pop()?.split('?')[0] ?? 'attachment');
      return { name, mimetype: guessMime(name), bytes };
    }
    if (!limits.allowLocal) {
      throw new GmailError('local attachment paths are disabled by the plugin config (allowLocalAttachments=false)', 'GMAIL_ATTACHMENT_POLICY');
    }
    const abs = resolveAllowedPath(input, limits.allowedRoots);
    const info = await stat(abs).catch(() => undefined);
    if (!info) throw new GmailError(`attachment file not found: ${input}`, 'GMAIL_ATTACHMENT_FILE');
    if (info.isDirectory()) throw new GmailError(`attachment path is a directory: ${input}`, 'GMAIL_ATTACHMENT_FILE');
    if (info.size > limits.maxBytes) {
      throw new GmailError(`attachment file exceeds the ${limits.maxBytes}-byte limit: ${input}`, 'GMAIL_ATTACHMENT_TOO_LARGE');
    }
    const bytes = await readFile(abs);
    const name = input.split('/').pop() ?? 'attachment';
    return { name, mimetype: guessMime(name), bytes };
  }
  if (typeof input === 'object' && input !== null) {
    const name = input.name ?? input.filename ?? 'attachment';
    const mimetype = input.mimetype ?? input.mimeType ?? guessMime(name);
    if (input.base64) {
      const bytes = Buffer.from(input.base64, 'base64');
      assertAttachmentSize(bytes, limits);
      return { name, mimetype, bytes };
    }
    if (input.base64url || input.contentBase64) {
      const bytes = Buffer.from(input.base64url ?? input.contentBase64, 'base64url');
      assertAttachmentSize(bytes, limits);
      return { name, mimetype, bytes };
    }
    if (input.path) return loadAttachment(input.path, limits);
    if (input.url) return loadAttachment(input.url, limits);
    throw new GmailError(`attachment object needs one of base64, base64url, path, or url (got ${Object.keys(input).join(', ') || 'nothing'})`, 'GMAIL_INVALID_ARGS');
  }
  throw new GmailError(`attachment must be a path, URL, or { name, mimetype, base64 } object (got ${typeof input})`, 'GMAIL_INVALID_ARGS');
}

function assertAttachmentSize(bytes, limits) {
  if (bytes.length > limits.maxBytes) {
    throw new GmailError(`attachment exceeds the ${limits.maxBytes}-byte limit`, 'GMAIL_ATTACHMENT_TOO_LARGE');
  }
}

/**
 * Validate/normalize a MIME type string. Any parameter suffix is dropped and
 * only RFC 2045 token characters survive, so crafted values (e.g. with CR/LF)
 * can never reach a Content-Type header.
 */
export function normalizeMimeType(value) {
  const text = String(value ?? '').trim();
  if (hasControlChars(text)) return 'application/octet-stream';
  const match = /^([A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*)\/([A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*)/.exec(text);
  if (!match) return 'application/octet-stream';
  return `${match[1].toLowerCase()}/${match[2].toLowerCase()}`;
}

const MAX_FETCH_REDIRECTS = 6;

/** Download http(s) bytes with SSRF guard, size cap, and timeout. */
async function fetchAttachmentBytes(urlString, limits) {
  let current;
  try {
    current = new URL(urlString);
  } catch {
    throw new GmailError(`invalid attachment URL: ${urlString}`, 'GMAIL_ATTACHMENT_POLICY');
  }
  for (let hop = 0; hop <= MAX_FETCH_REDIRECTS; hop += 1) {
    if (!/^https?:$/.test(current.protocol)) {
      throw new GmailError(`only http/https attachment URLs are allowed (got ${current.protocol})`, 'GMAIL_ATTACHMENT_POLICY');
    }
    await assertPublicHost(current);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
    try {
      const response = await fetch(current, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'user-agent': 'dsh-gmail-plugin' },
      });
      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        current = new URL(response.headers.get('location'), current);
        continue;
      }
      if (!response.ok) {
        throw new GmailError(`attachment download failed: ${current.href} (HTTP ${response.status})`, 'GMAIL_ATTACHMENT_DOWNLOAD');
      }
      const declared = Number(response.headers.get('content-length') ?? 0);
      if (Number.isFinite(declared) && declared > limits.maxBytes) {
        await response.body?.cancel?.();
        throw new GmailError(`attachment exceeds the ${limits.maxBytes}-byte limit: ${current.href}`, 'GMAIL_ATTACHMENT_TOO_LARGE');
      }
      return await readStreamCapped(response.body, limits.maxBytes, current.href);
    } catch (error) {
      if (error instanceof GmailError) throw error;
      const reason = controller.signal.aborted ? 'timed out or aborted' : (error instanceof Error ? error.message : String(error));
      throw new GmailError(`attachment download failed: ${current.href} (${reason})`, 'GMAIL_ATTACHMENT_DOWNLOAD');
    } finally {
      clearTimeout(timer);
    }
  }
  throw new GmailError(`too many redirects downloading attachment from ${urlString}`, 'GMAIL_ATTACHMENT_DOWNLOAD');
}

async function readStreamCapped(stream, maxBytes, source) {
  if (!stream) return new Uint8Array(0);
  const chunks = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch (error) {
      throw new GmailError(`attachment download interrupted: ${source} (${error instanceof Error ? error.message : String(error)})`, 'GMAIL_ATTACHMENT_DOWNLOAD');
    }
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new GmailError(`attachment exceeds the ${maxBytes}-byte limit: ${source}`, 'GMAIL_ATTACHMENT_TOO_LARGE');
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function assertPublicHost(url) {
  const hostname = url.hostname;
  if (!hostname) throw new GmailError(`attachment URL has no host: ${url.href}`, 'GMAIL_ATTACHMENT_POLICY');
  let addresses;
  try {
    addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    throw new GmailError(`cannot resolve attachment host "${hostname}": ${error instanceof Error ? error.message : String(error)}`, 'GMAIL_ATTACHMENT_POLICY');
  }
  const blocked = addresses.filter(({ address }) => !isPublicIpAddress(address));
  if (blocked.length > 0) {
    throw new GmailError(
      `attachment URL resolves to a non-public address (${blocked.map((b) => b.address).join(', ')}): ${hostname} — refusing to fetch private/loopback/link-local hosts (SSRF guard)`,
      'GMAIL_ATTACHMENT_POLICY',
    );
  }
}

/**
 * Best-effort public-IP check covering private (RFC 1918), loopback, link-local
 * (incl. the cloud metadata 169.254.169.254), CGNAT, multicast/reserved, and
 * IPv6 equivalents. Hostnames are resolved here at fetch time, so a name that
 * maps to a private address is rejected even when it is not a literal IP.
 */
export function isPublicIpAddress(ip) {
  const value = String(ip ?? '').split('%')[0];
  if (value.includes(':')) return isPublicIpv6(parseIpv6(value));
  return isPublicIpv4(parseIpv4(value));
}

function parseIpv4(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return [0, 0, 0, 0];
  return parts.map((p) => {
    const n = Number(p);
    return Number.isInteger(n) && n >= 0 && n <= 255 ? n : 0;
  });
}

function isPublicIpv4(a) {
  const [o1, o2, o3] = a;
  if (o1 === 0) return false;
  if (o1 === 10) return false;
  if (o1 === 100 && o2 >= 64 && o2 <= 127) return false;
  if (o1 === 127) return false;
  if (o1 === 169 && o2 === 254) return false;
  if (o1 === 172 && o2 >= 16 && o2 <= 31) return false;
  if (o1 === 192 && o2 === 0 && o3 === 0) return false;
  if (o1 === 192 && o2 === 0 && o3 === 2) return false;
  if (o1 === 192 && o2 === 168) return false;
  if (o1 === 198 && o2 === 18) return false;
  if (o1 === 198 && o2 === 51 && o3 === 100) return false;
  if (o1 === 203 && o2 === 0 && o3 === 113) return false;
  if (o1 >= 224) return false;
  return true;
}

function parseIpv6(ip) {
  const out = new Array(8).fill(0);
  const text = ip.toLowerCase();
  const parts = text.split('::');
  const headRaw = parts[0] ? parts[0].split(':').filter(Boolean) : [];
  const tailRaw = parts.length > 1 && parts[1] ? parts[1].split(':').filter(Boolean) : [];
  const headWords = headRaw.map(ipv6PartToWords).flat();
  const tailWords = tailRaw.map(ipv6PartToWords).flat();
  const gap = 8 - headWords.length - tailWords.length;
  if (gap < 0) return out;
  headWords.forEach((w, i) => { out[i] = w; });
  tailWords.forEach((w, i) => { out[8 - tailWords.length + i] = w; });
  return out;
}

/** One IPv6 group: hex word, or a trailing dotted-quad IPv4 encoded as two words. */
function ipv6PartToWords(part) {
  if (part.includes('.')) {
    const [a, b, c, d] = part.split('.').map((n) => {
      const v = Number(n);
      return Number.isInteger(v) && v >= 0 && v <= 255 ? v : 0;
    });
    return [a * 256 + b, c * 256 + d];
  }
  return [hexToWord(part)];
}

function hexToWord(hex) {
  const n = Number.parseInt(hex, 16);
  return Number.isFinite(n) && n >= 0 && n <= 0xffff ? n : 0;
}

function isPublicIpv6(a) {
  if (a.every((w) => w === 0)) return false;
  if (a[0] === 0 && a[1] === 0 && a[2] === 0 && a[3] === 0 && a[4] === 0 && a[5] === 0 && a[6] === 0 && a[7] === 1) return false;
  if ((a[0] & 0xfe00) === 0xfc00) return false;
  if ((a[0] & 0xffc0) === 0xfe80) return false;
  if ((a[0] & 0xff00) === 0xff00) return false;
  if (a[0] === 0 && a[1] === 0 && a[2] === 0 && a[3] === 0 && a[4] === 0 && a[5] === 0xffff) {
    return isPublicIpv4([(a[6] >> 8) & 0xff, a[6] & 0xff, (a[7] >> 8) & 0xff, a[7] & 0xff]);
  }
  if (a[0] === 0 && a[1] === 0 && a[2] === 0 && a[3] === 0 && a[4] === 0 && a[5] === 0) return false;
  return true;
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
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
    if (!isValidHeaderName(name)) {
      throw new GmailError(`invalid MIME header name ${JSON.stringify(name)}`, 'GMAIL_INVALID_HEADER');
    }
    const text = String(value);
    if (hasControlChars(text)) {
      throw new GmailError(`invalid MIME header value for ${name}: control characters (CR/LF) are not allowed`, 'GMAIL_INVALID_HEADER');
    }
    lines.push(`${name}: ${text}`);
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
  const { from, to, cc, bcc, subject = '', body = '', isHtml = false, attachments = [], inReplyTo, references, attachmentOptions = {} } = options;
  const limits = resolveLimits(attachmentOptions);
  const headers = {
    'MIME-Version': '1.0',
    'Date': new Date().toUTCString(),
    'Message-ID': generateMessageId(),
    'From': formatAddress(from),
    'To': formatAddressList(to),
    'Cc': formatAddressList(cc),
    'Bcc': formatAddressList(bcc),
    'Subject': encodeHeaderWord(subject),
    ...(inReplyTo ? { 'In-Reply-To': sanitizeMessageIds(inReplyTo) } : {}),
    ...(references ? { 'References': sanitizeMessageIds(references) } : {}),
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
        : await loadAttachment(item, limits);
      const bytes = loadedItem.bytes ?? Buffer.alloc(0);
      if (bytes.length > limits.maxBytes) {
        throw new GmailError(`attachment ${loadedItem.name ?? 'attachment'} exceeds the ${limits.maxBytes}-byte limit`, 'GMAIL_ATTACHMENT_TOO_LARGE');
      }
      const name = encodeHeaderWord(loadedItem.name ?? 'attachment');
      attachParts.push(part({
        headers: {
          'Content-Type': `${normalizeMimeType(loadedItem.mimetype ?? guessMime(loadedItem.name ?? ''))}; name="${name}"`,
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
