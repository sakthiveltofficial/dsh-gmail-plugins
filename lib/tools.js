/**
 * Tool factory for the Gmail plugin.
 *
 * Wraps `defineTool` from `@deepseek-ai/dsh-tools` so every Gmail tool shares
 * one shape: spec-form parameters, JSON-object output rendering, and a generic
 * pending-call card. Tool modules build specs and call {@link gmailTool}.
 * @module @google-workspace/dsh-gmail/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import { jsonObjectOutput, presentCall } from './util.js';

/**
 * Build one registered model tool.
 * @param spec - { name, description, parameters, execute, title?, kind?, output? }
 */
export function gmailTool(spec) {
  const { name, description, parameters, execute, title, kind = 'other', output } = spec;
  return defineTool({
    name,
    description,
    parameters,
    output: output ?? jsonObjectOutput(),
    execute(args, exec) {
      return Promise.resolve(execute(args, exec));
    },
    presentCall: (args) => presentCall(title ?? name, kind, args),
  });
}

/** Register every tool returned by a module's `tools(ctx, deps)` list. */
export function registerTools(ctx, deps, tools) {
  for (const tool of tools) {
    ctx.tools.register(gmailTool(tool));
  }
}

/** Resolve the `user_id` argument against the configured default. */
export function userId(args, config) {
  const id = args.user_id ?? args.userId;
  return id === undefined || id === '' ? config.defaultUserId : id;
}
