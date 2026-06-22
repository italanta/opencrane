import { ClusterTenantIsolationTier } from "@opencrane/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { _ReadExternalWebhookConfig } from "../../core/cluster-tenants/external-webhook.config.js";
import { _BuildClusterTenantProvisionerRegistry, SHARED_PROVISIONER_ID } from "../../core/cluster-tenants/registry.js";

/** Env keys mutated by these tests, restored after each case. */
const _WEBHOOK_ENV = ["CLUSTER_TENANT_PROVISIONER_WEBHOOK_URL", "CLUSTER_TENANT_PROVISIONER_WEBHOOK_TOKEN", "CLUSTER_TENANT_PROVISIONER_WEBHOOK_ID"];

describe("cluster-tenant provisioner registry (DOMAIN.T3 tier-availability gate)", function _suite()
{
	afterEach(function _restoreEnv()
	{
		for (const key of _WEBHOOK_ENV) delete process.env[key];
	});

	it("advertises the built-in shared backend for the two in-cluster tiers", function ()
	{
		const registry = _BuildClusterTenantProvisionerRegistry();

		expect(registry.isTierAvailable(ClusterTenantIsolationTier.Shared)).toBe(true);
		expect(registry.isTierAvailable(ClusterTenantIsolationTier.DedicatedNodes)).toBe(true);

		const caps = registry.capabilities();
		expect(caps).toEqual([{ id: SHARED_PROVISIONER_ID, supportedTiers: [ClusterTenantIsolationTier.Shared, ClusterTenantIsolationTier.DedicatedNodes] }]);
	});

	it("leaves dedicatedCluster unavailable when no external webhook is configured", function ()
	{
		const registry = _BuildClusterTenantProvisionerRegistry();

		expect(registry.isTierAvailable(ClusterTenantIsolationTier.DedicatedCluster)).toBe(false);
	});

	it("advertises dedicatedCluster only once an external webhook backend is configured", function ()
	{
		process.env.CLUSTER_TENANT_PROVISIONER_WEBHOOK_URL = "https://provisioner.example.com";
		process.env.CLUSTER_TENANT_PROVISIONER_WEBHOOK_TOKEN = "secret";
		process.env.CLUSTER_TENANT_PROVISIONER_WEBHOOK_ID = "vendor-x";

		const registry = _BuildClusterTenantProvisionerRegistry();

		expect(registry.isTierAvailable(ClusterTenantIsolationTier.DedicatedCluster)).toBe(true);
		expect(registry.capabilities()).toContainEqual({ id: "vendor-x", supportedTiers: [ClusterTenantIsolationTier.DedicatedCluster] });
	});

	it("refuses a non-HTTPS webhook endpoint (token would leak in plaintext)", function ()
	{
		process.env.CLUSTER_TENANT_PROVISIONER_WEBHOOK_URL = "http://provisioner.example.com";
		process.env.CLUSTER_TENANT_PROVISIONER_WEBHOOK_TOKEN = "secret";

		expect(() => _ReadExternalWebhookConfig()).toThrow(/https/);
	});

	it("defaults the external backend id to 'external' when none is supplied", function ()
	{
		process.env.CLUSTER_TENANT_PROVISIONER_WEBHOOK_URL = "https://provisioner.example.com";
		process.env.CLUSTER_TENANT_PROVISIONER_WEBHOOK_TOKEN = "secret";

		const config = _ReadExternalWebhookConfig();

		expect(config?.id).toBe("external");
	});
});
