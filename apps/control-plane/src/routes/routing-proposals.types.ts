/**
 * Route-local types for the routing proposals API (AIR.7). The `RoutingProposal` DTO + status enum
 * are owned by `@opencrane/contracts`; this file carries the proposal-decision result envelope.
 */

/** The outcome of an approve/reject decision on a routing proposal. */
export interface DecideProposalResult
{
  /** The decided proposal's id. */
  id: string;
  /** The resulting lifecycle status. */
  status: "applied" | "rejected";
  /** The model the skill was pinned to on apply; null on reject. */
  appliedModel: string | null;
}
