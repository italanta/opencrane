/** A valid API payload-type string for a share. */
export type SharePayloadType = "mcp-server" | "skill-bundle";
/** A valid API recipient-kind string for a share. */
export type ShareRecipientType = "user" | "group";
/** A valid API scope string for a share (mirrors GrantScope; defaults to personal). */
export type ShareScope = "org" | "department" | "project" | "personal";

/** Request body for creating a share. */
export interface CreateShareBody
{
  payloadType?: string;
  payloadId?: string;
  recipientType?: string;
  recipientId?: string;
  scope?: string;
  note?: string;
}
