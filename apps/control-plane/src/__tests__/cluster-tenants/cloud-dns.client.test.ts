import { describe, expect, it, vi } from "vitest";

import { CloudDnsClient } from "../../core/cluster-tenants/cloud-dns.client.js";

/**
 * Build a CloudDnsClient whose lazy SDK loader is stubbed with a fake DNS surface,
 * so the record-change logic is exercised without the real @google-cloud/dns SDK.
 */
function _clientWithFakeZone(existing: Array<{ metadata: { data: string | string[]; ttl: number } }>)
{
  const createChange = vi.fn().mockResolvedValue([{}]);
  const getRecords = vi.fn().mockResolvedValue([existing]);
  const record = vi.fn().mockImplementation((type: string, metadata: unknown) => ({ type, metadata }));
  const zone = { getRecords, createChange, record };
  const dns = { zone: vi.fn().mockReturnValue(zone) };

  const client = new CloudDnsClient("proj", "opencrane-zone");
  // Inject the fake DNS into the memoised slot, bypassing the dynamic import.
  (client as unknown as { dns: unknown }).dns = dns;

  return { client, getRecords, createChange, record, zone };
}

describe("CloudDnsClient — per-org A record provisioning (idempotent)", function _suite()
{
  it("creates the A record (with a trailing-dot FQDN) when none exists", async function _create()
  {
    const { client, getRecords, createChange, record } = _clientWithFakeZone([]);

    await client.ensureARecord("*.acme.weownai.eu", ["203.0.113.10"], 300);

    expect(getRecords).toHaveBeenCalledWith({ name: "*.acme.weownai.eu.", type: "A" });
    expect(record).toHaveBeenCalledWith("A", { name: "*.acme.weownai.eu.", ttl: 300, data: ["203.0.113.10"] });
    expect(createChange).toHaveBeenCalledWith(expect.objectContaining({ add: expect.anything() }));
    expect(createChange.mock.calls[0][0]).not.toHaveProperty("delete");
  });

  it("is a no-op when the same record data already exists", async function _noop()
  {
    const { client, createChange } = _clientWithFakeZone([{ metadata: { data: ["203.0.113.10"], ttl: 300 } }]);

    await client.ensureARecord("*.acme.weownai.eu", ["203.0.113.10"], 300);

    expect(createChange).not.toHaveBeenCalled();
  });

  it("replaces the record (delete + add) when the existing data differs", async function _replace()
  {
    const { client, createChange } = _clientWithFakeZone([{ metadata: { data: ["198.51.100.1"], ttl: 300 } }]);

    await client.ensureARecord("*.acme.weownai.eu", ["203.0.113.10"], 300);

    expect(createChange).toHaveBeenCalledWith(expect.objectContaining({ delete: expect.anything(), add: expect.anything() }));
  });

  it("deletes the record when present, and is a no-op when absent", async function _delete()
  {
    const present = _clientWithFakeZone([{ metadata: { data: ["203.0.113.10"], ttl: 300 } }]);
    await present.client.deleteARecord("*.acme.weownai.eu");
    expect(present.createChange).toHaveBeenCalledWith(expect.objectContaining({ delete: expect.anything() }));

    const absent = _clientWithFakeZone([]);
    await absent.client.deleteARecord("*.acme.weownai.eu");
    expect(absent.createChange).not.toHaveBeenCalled();
  });
});
