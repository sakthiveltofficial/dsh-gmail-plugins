import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildMime,
  formatAddress,
  isPublicIpAddress,
  loadAttachment,
  normalizeMimeType,
  resolveAllowedPath,
} from '../lib/mime.js';
import { GmailError } from '../lib/util.js';

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const CRLF = CR + LF;

// ---------------------------------------------------------------------------
// CR/LF header injection
// ---------------------------------------------------------------------------
test('formatAddress rejects CR/LF injection in a bare recipient', () => {
  assert.throws(() => formatAddress('victim@example.com' + CRLF + 'Bcc: attacker@evil.example' + CRLF), GmailError);
});

test('formatAddress rejects CR/LF injection in a bracketed recipient', () => {
  assert.throws(() => formatAddress('Victim <victim@example.com>' + CRLF + 'Bcc: attacker@evil.example'), GmailError);
});

test('formatAddress rejects control characters', () => {
  assert.throws(() => formatAddress('victim@example.com\u0007Bcc: x@y.z'), GmailError);
});

test('formatAddress rejects malformed bare addresses', () => {
  assert.throws(() => formatAddress('not-an-email'), GmailError);
  assert.throws(() => formatAddress('a b@example.com'), GmailError);
  assert.throws(() => formatAddress('a<b>@example.com'), GmailError);
});

test('formatAddress accepts valid bare and bracketed addresses', () => {
  assert.equal(formatAddress('user@example.com'), 'user@example.com');
  assert.equal(formatAddress('Jane Doe <user@example.com>'), 'Jane Doe <user@example.com>');
  assert.equal(formatAddress('用户 <user@example.com>'), '=?UTF-8?B?' + Buffer.from('用户', 'utf8').toString('base64') + '?= <user@example.com>');
});

test('buildMime rejects a To recipient attempting header injection', async () => {
  await assert.rejects(
    buildMime({ to: 'victim@example.com' + CRLF + 'Bcc: hidden@evil.example' + CRLF, subject: 't', body: 'b' }),
    (err) => err instanceof GmailError && err.code === 'GMAIL_INVALID_ADDRESS',
  );
});

test('buildMime sanitizes In-Reply-To / References echoed from inbound mail', async () => {
  const raw = await buildMime({
    to: 'user@example.com',
    subject: 'Re: hi',
    body: 'reply',
    inReplyTo: '<orig@host.example>' + CRLF + 'Bcc: injected@evil.example' + CRLF + '<x@y.z>',
    references: '<a@b.c>' + CRLF + 'X-Evil: 1' + CRLF + '<d@e.f>',
  });
  // The smuggler text survives only as inert data on the same header line:
  // the CR/LF that would create a real header is gone.
  assert.ok(!raw.includes(CRLF + 'Bcc: injected@evil.example'), 'In-Reply-To must not smuggle headers');
  assert.ok(!raw.includes(CRLF + 'X-Evil: 1'), 'References must not smuggle headers');
  assert.ok(raw.includes('In-Reply-To: <orig@host.example> Bcc: injected@evil.example <x@y.z>'), 'In-Reply-To CR/LF collapsed and ids preserved');
  assert.ok(raw.includes('References: <a@b.c> X-Evil: 1 <d@e.f>'), 'References CR/LF collapsed and ids preserved');
});

test('buildMime sanitizes a crafted attachment mimetype', async () => {
  const raw = await buildMime({
    to: 'user@example.com',
    subject: 's',
    body: 'b',
    attachments: [{ name: 'evil.txt', mimetype: 'text/plain' + CRLF + 'Bcc: via-mimetype@evil.example' + CRLF, bytes: Buffer.from('hello') }],
  });
  assert.ok(!raw.includes('Bcc: via-mimetype@evil.example'), 'mimetype must not smuggle headers');
  assert.ok(raw.includes('Content-Type: text/plain'), 'mimetype kept after sanitization');
});

test('normalizeMimeType rejects CR/LF and bogus values', () => {
  assert.equal(normalizeMimeType('text/plain' + CRLF + 'Bcc: x@y.z'), 'application/octet-stream');
  assert.equal(normalizeMimeType('../../../etc/passwd'), 'application/octet-stream');
  assert.equal(normalizeMimeType('TEXT/PLAIN; charset=utf-8'), 'text/plain');
  assert.equal(normalizeMimeType('image/png'), 'image/png');
});

// ---------------------------------------------------------------------------
// Path policy
// ---------------------------------------------------------------------------
test('resolveAllowedPath (default): relative allowed, absolute and escapes denied', () => {
  const rel = resolveAllowedPath('notes/a.txt', []);
  assert.ok(path.isAbsolute(rel));
  assert.ok(rel.startsWith(process.cwd()));
  assert.throws(() => resolveAllowedPath('/etc/passwd', []), GmailError);
  assert.throws(() => resolveAllowedPath('../outside.txt', []), GmailError);
});

test('resolveAllowedPath (root set): inside allowed, outside and escapes denied', () => {
  const root = path.resolve('/tmp/dsh-gmail-test-root');
  assert.equal(resolveAllowedPath('a.txt', [root]), path.join(root, 'a.txt'));
  assert.equal(resolveAllowedPath(path.join(root, 'sub', 'b.txt'), [root]), path.join(root, 'sub', 'b.txt'));
  assert.throws(() => resolveAllowedPath('/etc/passwd', [root]), GmailError);
  assert.throws(() => resolveAllowedPath('../x.txt', [root]), GmailError);
});

test('loadAttachment: local file under cwd allowed, absolute denied by default', async (t) => {
  const dir = await mkdtemp(path.join(process.cwd(), '.test-fixtures-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const absolute = path.join(dir, 'f.txt');
  await writeFile(absolute, 'payload');
  const relative = path.relative(process.cwd(), absolute);
  const loaded = await loadAttachment(relative, {});
  assert.equal(Buffer.from(loaded.bytes).toString(), 'payload');
  await assert.rejects(() => loadAttachment('/etc/hostname', {}), (e) => e instanceof GmailError && e.code === 'GMAIL_ATTACHMENT_POLICY');
});

test('loadAttachment: root policy admits only the configured subtree', async (t) => {
  const base = path.join(tmpdir(), 'dsh-gmail-root-' + Date.now());
  const inside = path.join(base, 'in');
  await mkdir(inside, { recursive: true });
  await writeFile(path.join(inside, 'ok.txt'), 'ok');
  const outside = await mkdtemp(path.join(tmpdir(), 'dsh-gmail-out-'));
  t.after(() => Promise.all([rm(base, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  await writeFile(path.join(outside, 'bad.txt'), 'bad');
  const limits = { allowedRoots: [base] };
  const ok = await loadAttachment('in/ok.txt', limits);
  assert.equal(Buffer.from(ok.bytes).toString(), 'ok');
  await assert.rejects(() => loadAttachment(path.join(outside, 'bad.txt'), limits), GmailError);
});

test('loadAttachment: size cap enforced for files and inline objects', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-gmail-size-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'big.bin');
  await writeFile(file, Buffer.alloc(64));
  await assert.rejects(() => loadAttachment(file, { maxBytes: 32, allowedRoots: [dir] }), (e) => e.code === 'GMAIL_ATTACHMENT_TOO_LARGE');
  await assert.rejects(() => loadAttachment({ name: 'x.bin', base64: Buffer.alloc(64).toString('base64') }, { maxBytes: 32 }), (e) => e.code === 'GMAIL_ATTACHMENT_TOO_LARGE');
});

// ---------------------------------------------------------------------------
// SSRF guard
// ---------------------------------------------------------------------------
test('isPublicIpAddress blocks private/special ranges', () => {
  const blocked = ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fc00::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1'];
  for (const ip of blocked) assert.equal(isPublicIpAddress(ip), false, ip + ' must be blocked');
  const allowed = ['8.8.8.8', '1.1.1.1', '104.16.132.229', '2606:4700::6810:84e5'];
  for (const ip of allowed) assert.equal(isPublicIpAddress(ip), true, ip + ' must be allowed');
});

test('loadAttachment refuses loopback / link-local / private URLs', async () => {
  for (const url of ['http://127.0.0.1:9/x', 'http://localhost:9/x', 'http://169.254.169.254/latest/meta-data', 'http://10.0.0.5/x', 'http://192.168.1.1/x']) {
    await assert.rejects(() => loadAttachment(url, {}), (e) => e instanceof GmailError && e.code === 'GMAIL_ATTACHMENT_POLICY', url);
  }
});

test('loadAttachment enforces allowRemote and allowLocal toggles', async () => {
  await assert.rejects(() => loadAttachment('http://8.8.8.8/x', { allowRemote: false }), GmailError);
  await assert.rejects(() => loadAttachment('rel-file.txt', { allowLocal: false }), GmailError);
});

test('loadAttachment aborts when a download exceeds the byte cap (content-length)', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-length': '5000' });
    res.end(Buffer.alloc(5000));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    await assert.rejects(() => loadAttachment('http://127.0.0.1:' + port + '/big', { maxBytes: 1000, allowedRoots: [] }), GmailError);
  } finally {
    server.close();
  }
});

test('buildMime rejects oversized inline attachments', async () => {
  await assert.rejects(
    buildMime({ to: 'a@b.c', subject: 's', body: 'b', attachments: [{ name: 'big.bin', bytes: Buffer.alloc(1024) }], attachmentOptions: { maxBytes: 512 } }),
    (e) => e instanceof GmailError && e.code === 'GMAIL_ATTACHMENT_TOO_LARGE',
  );
});