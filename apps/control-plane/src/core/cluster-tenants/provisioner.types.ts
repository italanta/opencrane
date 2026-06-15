import type { ClusterTenantProvisionRequest, ClusterTenantProvisionResult } from "@opencrane/contracts";

/**
 * A backend that materialises a cluster tenant's isolation boundary. The
 * built-in shared provisioner maps a tenant to a namespace; an external webhook
 * provisioner delegates `dedicatedCluster` provisioning to an out-of-process
 * backend at arm's length. The registry routes a tenant to the right provisioner
 * by advertised tier capability.
 */
export interface ClusterTenantProvisioner
{
  /**
   * Provision the customer's isolation boundary.
   * @param req - Generic, vendor-neutral provision request.
   * @returns The resulting phase plus the bound namespace and/or kubeconfig ref.
   */
  provision(req: ClusterTenantProvisionRequest): Promise<ClusterTenantProvisionResult>;
  /**
   * Tear down the customer's boundary.
   * @param name - Customer key being deprovisioned.
   */
  deprovision(name: string): Promise<void>;
  /**
   * Read the current observed state of a provisioned boundary.
   * @param name - Customer key to read.
   * @returns The latest provision result for the customer.
   */
  getStatus(name: string): Promise<ClusterTenantProvisionResult>;
  /**
   * Resolve the Kubernetes Secret reference holding the customer's kubeconfig.
   * @param name - Customer key to resolve.
   * @returns The Secret name, or null when the tier needs no separate kubeconfig.
   */
  getKubeconfigRef(name: string): Promise<string | null>;
}
