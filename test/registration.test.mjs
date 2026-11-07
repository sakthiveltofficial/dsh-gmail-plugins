import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('tool surface: 61 non-auth tools, all unique', async () => {
  const modules = ['messages.js', 'threads.js', 'drafts.js', 'labels.js', 'filters.js', 'settings.js', 'people.js', 'attachments.js'];
  const all = [];
  for (const m of modules) {
    const mod = await import('../lib/tools/' + m);
    const list = mod.tools({}, { config: { defaultUserId: 'me', scopes: [] }, client: {} });
    for (const t of list) all.push(t.name);
  }
  assert.equal(all.length, 61, 'expected 61 non-auth tools (63 total minus the 2 authorize tools)');
  assert.equal(new Set(all).size, all.length, 'tool names must be unique');
});

test('gmail_authorize: scope parameter removed, scopes pinned to config', async (t) => {
  const src = await readFile(new URL('../lib/tools/authorize.js', import.meta.url), 'utf8');
  assert.ok(!/(^|[^A-Za-z])args\.scopes\b/.test(src), 'execute must not read a model-supplied args.scopes');
  assert.ok(src.includes('const scopes = config.scopes;'), 'scopes must come from config only');
  assert.ok(src.includes('parameters: {}'), 'gmail_authorize exposes no parameters');
  let auth;
  try {
    auth = await import('../lib/tools/authorize.js');
  } catch (err) {
    if (err.code === 'ERR_MODULE_NOT_FOUND' && String(err.message).includes('@deepseek-ai/dsh-credentials')) {
      t.skip('dsh-credentials not installed; run npm install to exercise the module');
      return;
    }
    throw err;
  }
  const list = auth.tools({}, { config: { defaultUserId: 'me', scopes: ['gmail.modify', 'gmail.send'] }, flows: new Map() });
  assert.equal(list.length, 2, 'authorize module exposes exactly 2 tools');
  const authorize = list.find((x) => x.name === 'gmail_authorize');
  assert.ok(authorize, 'gmail_authorize present');
  assert.ok(!('scopes' in (authorize.parameters ?? {})), 'parameters schema has no scopes key');
});