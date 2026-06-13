/**
 * @opencrane/awareness — the Org Context / Awareness SDK (P4B.1).
 *
 * Consumed by every OpenClaw tenant pod (pinned to a contract version) to
 * retrieve org context directly from its per-tenant Cognee, with guaranteed
 * citations and contract-version stamping. No control-plane retrieval mediation.
 */
export { AwarenessClient } from "./awareness-client.js";
export { AWARENESS_CONTRACT_VERSION, ___AssertContractCompatible, ___IsContractCompatible } from "./contract-version.js";
export type { Citation, CitableSource } from "./citation.types.js";
export type {
  AwarenessClientOptions,
  AwarenessHit,
  AwarenessQuery,
  AwarenessResult,
  CogneeSearchHit,
  CogneeSearchTransport,
} from "./awareness-client.types.js";
