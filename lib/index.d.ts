/**
 * Type declarations for @google-workspace/dsh-gmail.
 *
 * The plugin is consumed through the Cordis host (name / inject / Config /
 * apply); these declarations stay intentionally loose because the runtime
 * types come from @deepseek-ai/cordis and @deepseek-ai/schemastery.
 * @module @google-workspace/dsh-gmail
 */

/** Plugin config options (schemastery schema mirrors these). */
export interface Config {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  clientIdRef?: string;
  clientSecretRef?: string;
  refreshTokenRef?: string;
  /** OAuth scopes requested at consent time; gmail_authorize cannot change them. */
  scopes?: string[];
  defaultUserId?: string;
  timeoutMs?: number;
  triggerIntervalMinutes?: number;
  enableReceivedTrigger?: boolean;
  enableSentTrigger?: boolean;
  receivedQuery?: string;
  sentQuery?: string;
  flowTimeoutMs?: number;
  redirectPort?: number;
  /** Directories allowed for local attachment paths; empty = relative under cwd only. */
  attachmentRoot?: string;
  maxAttachmentBytes?: number;
  attachmentFetchTimeoutMs?: number;
  allowRemoteAttachments?: boolean;
  allowLocalAttachments?: boolean;
}

export declare const name: string;
export declare const inject: string[];
/** Schemastery config schema (values are validated at mount time). */
export declare const Config: any;
/** Apply the plugin to a Cordis context. */
export declare function apply(ctx: any, config: Config): void;