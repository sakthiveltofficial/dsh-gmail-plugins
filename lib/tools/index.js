/**
 * Aggregates every Gmail tool module into one registration pass.
 * @module @google-workspace/dsh-gmail/tools
 */

import { registerTools } from '../tools.js';
import * as messages from './messages.js';
import * as drafts from './drafts.js';
import * as threads from './threads.js';
import * as labels from './labels.js';
import * as filters from './filters.js';
import * as settings from './settings.js';
import * as people from './people.js';
import * as attachments from './attachments.js';
import * as authorize from './authorize.js';

const MODULES = [messages, drafts, threads, labels, filters, settings, people, attachments, authorize];

/** Register every Gmail tool into `ctx.tools`. Returns the registered count. */
export function registerAll(ctx, deps) {
  let count = 0;
  for (const mod of MODULES) {
    const tools = mod.tools(ctx, deps);
    registerTools(ctx, deps, tools);
    count += tools.length;
  }
  return count;
}
