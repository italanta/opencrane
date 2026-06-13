/**
 * The awareness contract version this SDK implements.
 *
 * Every tenant pod consumes the SDK pinned to this version (P4B.1). The fleet
 * canary/rollout (P4B.3) promotes a new version cohort-by-cohort; a pod refuses
 * to talk to an org index advertising an *incompatible* (different major)
 * contract so a half-rolled-out fleet never silently mixes schemas.
 *
 * Format: `awareness/v<major>alpha<minor>` (pre-1.0 uses the `vNalphaM` form).
 */
export const AWARENESS_CONTRACT_VERSION = "awareness/v1alpha1";

/**
 * Extract the major-version token from an awareness contract version string.
 * The major is the `v<N>` segment; differing majors are incompatible.
 *
 * @param version - A contract version string (e.g. `awareness/v1alpha1`).
 * @returns The major token (e.g. `v1`), or null when unparseable.
 */
function _major(version: string): string | null
{
  const match = /\/(v\d+)/.exec(version);
  return match ? match[1] : null;
}

/**
 * Whether two awareness contract versions are compatible (same major).
 *
 * @param a - First contract version.
 * @param b - Second contract version.
 * @returns True when both parse to the same major version.
 */
export function ___IsContractCompatible(a: string, b: string): boolean
{
  const majorA = _major(a);
  const majorB = _major(b);
  return majorA !== null && majorA === majorB;
}

/**
 * Assert that a peer/server contract version is compatible with this SDK.
 *
 * @param peerVersion - The contract version advertised by the org index/peer.
 * @throws When the peer version is missing or a different major than this SDK.
 */
export function ___AssertContractCompatible(peerVersion: string): void
{
  if (!___IsContractCompatible(AWARENESS_CONTRACT_VERSION, peerVersion))
  {
    throw new Error(`awareness contract mismatch: SDK is ${AWARENESS_CONTRACT_VERSION}, peer advertised ${peerVersion || "(none)"}`);
  }
}
