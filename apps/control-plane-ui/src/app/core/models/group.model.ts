import { GrantScope, type Grant } from "./grant.model";

/** Access group used to model domain membership for entitlement management. */
export interface Group
{
  /** Stable group identifier. */
  id: string;
  /** Human-friendly group name. */
  name: string;
  /** Organizational scope represented by the group. */
  scope: GrantScope;
  /** Optional operator-facing description. */
  description?: string;
  /** Current member count snapshot. */
  memberCount: number;
  /** Default grants associated with the group. */
  grants: Grant[];
}
