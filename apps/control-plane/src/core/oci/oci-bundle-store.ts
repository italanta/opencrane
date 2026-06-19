import { createHash } from "node:crypto";

import { ___DoWithTrace } from "@opencrane/observability";

import { _log } from "../../log.js";
import type { OciBundleStoreConfig, OciFetch, OciPushResult, OciResponse } from "./oci-bundle-store.types.js";

/** Media type for the stored skill-bundle layer blob. */
const _BUNDLE_MEDIA_TYPE = "application/vnd.opencrane.skill.bundle.v1+text";

/** Media type for the (empty) OCI config blob each manifest references. */
const _CONFIG_MEDIA_TYPE = "application/vnd.oci.empty.v1+json";

/** Media type of the OCI image manifest. */
const _MANIFEST_MEDIA_TYPE = "application/vnd.oci.image.manifest.v1+json";

/** The canonical empty OCI config object. */
const _EMPTY_CONFIG = "{}";

/**
 * Compute the OCI content digest (`sha256:<hex>`) of a UTF-8 string.
 *
 * @param content - The bytes to digest.
 * @returns The `sha256:`-prefixed lowercase hex digest.
 */
function _Digest(content: string): string
{
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

/** Validate an OCI content digest is well-formed `sha256:<64 hex>` before it touches a URL. */
function _AssertDigest(digest: string): void
{
  if (!/^sha256:[a-f0-9]{64}$/.test(digest))
  {
    throw new Error(`Invalid OCI digest (expected sha256:<64 hex>): ${digest}`);
  }
}

/**
 * Default transport: wrap Node's global `fetch` in the narrow {@link OciFetch} shape.
 * Node's `Response` is structurally a superset of `OciResponse`, so the single cast is
 * a documented narrowing, not a type bridge.
 */
const _DefaultFetch: OciFetch = async function _defaultFetch(url, init)
{
  const res = await fetch(url, init as RequestInit);
  return res as OciResponse;
};

/**
 * Content-addressable store for skill bundles backed by an OCI registry
 * (Zot — see plan P4D.2). Bundles are pushed as a single-layer OCI artifact and
 * retrieved by their `sha256:` digest, with the pulled bytes re-verified against
 * that digest so a corrupted/substituted blob is rejected rather than served.
 *
 * Implements the minimal OCI Distribution v2 surface: blob upload (POST then
 * digest-qualified PUT), manifest PUT (so the blob is referenced and not
 * garbage-collected), and blob GET by digest.
 */
export class OciBundleStore
{
  /** Registry base URL, trailing slash stripped. */
  private readonly registryUrl: string;

  /** Repository path bundles live under. */
  private readonly repository: string;

  /** Transport (injectable for tests). */
  private readonly fetchFn: OciFetch;

  /**
   * @param config - Registry URL, repository, and optional transport override.
   */
  public constructor(config: OciBundleStoreConfig)
  {
    // 1. Reject a malformed registry URL early — every request is built from it.
    try
    {
      new URL(config.registryUrl);
    }
    catch
    {
      throw new Error(`Invalid OCI registryUrl: ${config.registryUrl}`);
    }

    // 2. Constrain the repository to a valid OCI name so it cannot inject path segments.
    if (!/^[a-z0-9]+([._-][a-z0-9]+)*(\/[a-z0-9]+([._-][a-z0-9]+)*)*$/.test(config.repository))
    {
      throw new Error(`Invalid OCI repository name: ${config.repository}`);
    }

    this.registryUrl = config.registryUrl.replace(/\/+$/, "");
    this.repository = config.repository;
    this.fetchFn = config.fetchFn ?? _DefaultFetch;
  }

  /**
   * Push a skill bundle and the artifact that references it.
   *
   * @param content - The raw bundle text.
   * @returns The stored bundle's digest and size.
   */
  public async pushBundle(content: string): Promise<OciPushResult>
  {
    const digest = _Digest(content);
    const size = Buffer.byteLength(content, "utf8");
    // Capture `this` so the traced callback can be a named function expression
    // (repo style) while still reaching the instance's transport + helpers.
    const self = this;

    // Trace the push as `oci.bundle.push`; the digest + size make a slow or
    // failing registry interaction attributable to a specific bundle.
    return ___DoWithTrace("oci.bundle.push", { repository: this.repository, digest, sizeBytes: size }, async function _push(): Promise<OciPushResult>
    {
      // 1. Upload the bundle as a layer blob and the empty config blob. Both must
      //    exist before the manifest that references them can be accepted.
      await self._uploadBlob(content, digest);
      await self._uploadBlob(_EMPTY_CONFIG, _Digest(_EMPTY_CONFIG));

      // 2. PUT a manifest referencing the layer so the registry keeps the blob
      //    (unreferenced blobs are eligible for garbage collection). The manifest
      //    is tagged by the layer's hex digest, a valid OCI tag.
      await self._putManifest(content, digest);

      _log.info({ repository: self.repository, digest, sizeBytes: size }, "oci bundle pushed");
      return { digest, size };
    });
  }

  /**
   * Fetch a bundle by digest and verify the bytes match it.
   *
   * @param digest - The `sha256:` digest to retrieve.
   * @returns The bundle text, or null when the registry has no such blob.
   * @throws When the registry errors, or the returned bytes do not match `digest`.
   */
  public async pullBundle(digest: string): Promise<string | null>
  {
    // 0. Reject a malformed digest before it reaches the registry URL.
    _AssertDigest(digest);
    // Capture `this` so the traced callback can be a named function expression.
    const self = this;

    // Trace the pull as `oci.bundle.pull`.
    return ___DoWithTrace("oci.bundle.pull", { repository: this.repository, digest }, async function _pull(): Promise<string | null>
    {
      // 1. Fetch the blob directly by its content-addressable digest.
      const res = await self.fetchFn(`${self.registryUrl}/v2/${self.repository}/blobs/${digest}`, {
        method: "GET",
        headers: { accept: _BUNDLE_MEDIA_TYPE },
      });

      // 2. A missing blob is an expected "not stored" signal, not an error.
      if (res.status === 404)
      {
        _log.debug({ repository: self.repository, digest }, "oci bundle not found");
        return null;
      }
      if (!res.ok)
      {
        throw new Error(`OCI blob GET failed for ${digest}: HTTP ${res.status}`);
      }

      // 3. Re-verify the digest — never serve bytes that do not hash to what was asked for.
      const content = await res.text();
      const actual = _Digest(content);
      if (actual !== digest)
      {
        throw new Error(`OCI digest mismatch: requested ${digest}, got ${actual}`);
      }

      _log.debug({ repository: self.repository, digest, sizeBytes: Buffer.byteLength(content, "utf8") }, "oci bundle pulled");
      return content;
    });
  }

  /**
   * Upload one blob via the two-step OCI flow: POST to open a session, then PUT
   * the bytes qualified by their digest.
   *
   * @param content - The blob bytes.
   * @param digest  - The blob's `sha256:` digest.
   */
  private async _uploadBlob(content: string, digest: string): Promise<void>
  {
    // 1. Open an upload session. A 201 here means the registry already has this blob
    //    (content-addressed re-push) — nothing more to do, which keeps push idempotent.
    const start = await this.fetchFn(`${this.registryUrl}/v2/${this.repository}/blobs/uploads/`, { method: "POST" });
    if (start.status === 201)
    {
      return;
    }
    if (start.status !== 202)
    {
      throw new Error(`OCI blob upload start failed: HTTP ${start.status}`);
    }
    const location = start.headers.get("location");
    if (!location)
    {
      throw new Error("OCI blob upload start returned no Location header");
    }

    // 2. Complete the upload by PUTting the bytes with the digest query param. Accept any
    //    2xx (registries return 201, occasionally 204) so a re-push does not spuriously fail.
    const sep = location.includes("?") ? "&" : "?";
    const put = await this.fetchFn(`${this._absolute(location)}${sep}digest=${encodeURIComponent(digest)}`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: content,
    });
    if (!put.ok)
    {
      throw new Error(`OCI blob upload finalize failed for ${digest}: HTTP ${put.status}`);
    }
  }

  /**
   * PUT the image manifest that references the bundle layer + empty config.
   *
   * @param content - The bundle bytes (for size).
   * @param digest  - The layer (bundle) digest, also used as the manifest tag.
   */
  private async _putManifest(content: string, digest: string): Promise<void>
  {
    const manifest = JSON.stringify({
      schemaVersion: 2,
      mediaType: _MANIFEST_MEDIA_TYPE,
      config: { mediaType: _CONFIG_MEDIA_TYPE, digest: _Digest(_EMPTY_CONFIG), size: Buffer.byteLength(_EMPTY_CONFIG, "utf8") },
      layers: [{ mediaType: _BUNDLE_MEDIA_TYPE, digest, size: Buffer.byteLength(content, "utf8") }],
    });

    // Tag the manifest by the layer's hex digest (a valid OCI reference).
    const reference = digest.replace("sha256:", "");
    const res = await this.fetchFn(`${this.registryUrl}/v2/${this.repository}/manifests/${reference}`, {
      method: "PUT",
      headers: { "content-type": _MANIFEST_MEDIA_TYPE },
      body: manifest,
    });
    // Accept any 2xx: a re-push of an identical manifest returns 200, a new one 201.
    if (!res.ok)
    {
      throw new Error(`OCI manifest PUT failed for ${digest}: HTTP ${res.status}`);
    }
  }

  /**
   * Resolve an upload `Location` against the registry, refusing anything that would
   * leave the registry's own origin. The registry controls this header, so a relative
   * path or a same-origin absolute URL is accepted; any other origin (or a
   * protocol-relative `//host`) is rejected rather than followed.
   */
  private _absolute(location: string): string
  {
    // 1. Plain absolute path on the registry (but not protocol-relative `//host`).
    if (location.startsWith("/") && !location.startsWith("//"))
    {
      return `${this.registryUrl}${location}`;
    }

    // 2. Absolute URL — allow only if it shares the registry's origin.
    let parsed: URL;
    try
    {
      parsed = new URL(location);
    }
    catch
    {
      throw new Error(`OCI upload Location is not a valid URL or path: ${location}`);
    }
    if (parsed.origin !== new URL(this.registryUrl).origin)
    {
      throw new Error(`OCI upload Location points outside the registry origin: ${parsed.origin}`);
    }
    return location;
  }
}
