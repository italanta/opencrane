/** Minimal Deployment shape required for readiness checks. */
export interface DeploymentStatusSnapshot
{
  /** Desired replica configuration. */
  spec?:
  {
    /** Number of desired replicas. */
    replicas?: number;
  };

  /** Current deployment status from the cluster. */
  status?:
  {
    /** Number of pods that have passed readiness probes. */
    readyReplicas?: number;
  };
}
