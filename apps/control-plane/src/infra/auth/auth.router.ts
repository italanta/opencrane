import { createHash, randomBytes } from "crypto";
import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import type * as k8s from "@kubernetes/client-node";

import { _log } from "../../log.js";
import type { OidcAuthService } from "./oidc.service.js";
import { _AuthorizeDeviceGrant, _CreateDeviceGrant, _FindGrantByUserCode, _PollDeviceGrant } from "./device-grant.js";
import { _ResolveOpenClawPairing } from "./openclaw-pairing.js";
import { _RecordBrokeredDevice } from "./brokered-device.js";
import { _CutTenant } from "../../core/connections/cut-tenant.js";
import type { OpenClawGatewayAdmin } from "../../core/connections/gateway-admin.types.js";
import { _ResolveGatewayTarget } from "../../core/connections/gateway-resolve.js";

/**
 * Build the auth router covering:
 *  - Session introspection (GET /me)
 *  - OpenClaw connection broker (POST /pod-token)
 *  - OIDC browser flow (GET /login, GET /callback, POST /logout)
 *  - Device authorization grant for CLI (POST /device, GET /device/activate, GET /device/token)
 *
 * All routes in this router are mounted before `___AuthMiddleware` and are
 * therefore public — authentication is enforced per-handler where required.
 *
 * @param authService  - OIDC auth service instance.
 * @param prisma       - Prisma client used to persist device-issued access tokens.
 * @param coreApi      - Kubernetes Core V1 API client (pod ops for the self-serve cut).
 * @param gatewayAdmin - OpenClaw gateway revoke client for the self-serve kill-switch (CONN.5).
 */
export function ___AuthRouter(authService: OidcAuthService, prisma: PrismaClient, coreApi: k8s.CoreV1Api, gatewayAdmin: OpenClawGatewayAdmin): Router
{
  const router = Router();
  const namespace = process.env.NAMESPACE ?? "default";

  // --------------------------------------------------------------------------
  // Session introspection
  // --------------------------------------------------------------------------

  /** Report the current auth mode and authenticated user session, if any. */
  router.get("/me", async function _me(req, res, next)
  {
    try
    {
      res.json(await authService.getStatus(req));
    }
    catch (err)
    {
      next(err);
    }
  });

  /**
   * Reverse-proxy auth check for a tenant's OpenClaw gateway (trusted-proxy mode,
   * OC-2 / CONN.4). The pod's ingress runs this as an nginx `auth_request` on the
   * WebSocket upgrade: a valid OIDC session returns 204 with the caller's verified
   * email in `X-Forwarded-User`; the ingress injects that header (overwriting any
   * client-supplied value) so the gateway — configured `gateway.auth.mode =
   * trusted-proxy`, trusting only the ingress source — authenticates the socket as
   * that user, with no credential ever held by the browser.
   *
   * This makes the control-plane the connection **broker**: every gateway socket
   * is authorised here against the live session. **Central cut** falls out for
   * free — revoking the session makes this return 401, so the ingress refuses new
   * upgrades (live sockets are still severed by the pod-delete kill-switch).
   *
   * Public (mounted before `___AuthMiddleware`); enforces the session inline.
   */
  router.get("/gateway-verify", function _gatewayVerify(req, res)
  {
    const authUser = req.session?.authUser;
    const email = typeof authUser?.email === "string" ? authUser.email.trim().toLowerCase() : "";
    if (!authUser || email.length === 0)
    {
      res.status(401).json({ error: "Authentication required", code: "UNAUTHORIZED" });
      return;
    }
    // Identity the ingress copies into the upstream `X-Forwarded-User` header
    // (and strips any client-supplied one) for the gateway to trust.
    res.setHeader("X-Forwarded-User", email);
    res.status(204).end();
  });

  /**
   * Routing-authority endpoint for the identity-routing gateway proxy (DOMAIN.T4).
   *
   * Where `/gateway-verify` answers a yes/no for nginx's `auth_request` (single-host,
   * per-user-subdomain model), this endpoint answers **where** a session's gateway
   * socket should go when every user in an org shares one host: it returns the verified
   * identity plus the authoritative `{ tenant, podService }` the proxy forwards to. The
   * proxy holds NO session logic — the control plane stays the sole auth authority
   * (delegate-auth, like the nginx `auth_request`), so the express session store is
   * never shared across services.
   *
   * **Cross-tenant safety (routing half):** the target is resolved solely from the
   * session's IdP-verified email via the fail-closed email→tenant rule — no
   * request-supplied tenant input — and a missing/ambiguous mapping fails closed with
   * **403**. Combined with per-pod owner pinning (CONN.10, the pod-level half) this is
   * defence in depth: neither the routing layer nor the pod will serve a foreign user.
   *
   * Public (mounted before `___AuthMiddleware`); enforces the session inline.
   */
  router.get("/gateway-resolve", async function _gatewayResolve(req, res, next)
  {
    try
    {
      const authUser = req.session?.authUser;
      if (!authUser)
      {
        res.status(401).json({ error: "Authentication required", code: "UNAUTHORIZED" });
        return;
      }

      const email = typeof authUser.email === "string" ? authUser.email : "";
      const sub = typeof authUser.sub === "string" ? authUser.sub : "";
      const outcome = await _ResolveGatewayTarget(prisma, namespace, email, sub);

      if (!outcome.ok)
      {
        // Every fail-closed reason is a 403: the proxy treats it as "refuse the upgrade".
        const message = outcome.code === "AMBIGUOUS_TENANT"
          ? "Multiple OpenClaw pods match this account; contact your administrator"
          : outcome.code === "NO_TENANT"
            ? "No OpenClaw is provisioned for this account"
            : "Session has no email claim; cannot resolve a tenant";
        res.status(403).json({ error: message, code: outcome.code });
        return;
      }

      res.status(200).json(outcome.resolved);
    }
    catch (err)
    {
      next(err);
    }
  });

  // --------------------------------------------------------------------------
  // OpenClaw pairing broker (single sign-on across control plane + pod)
  // --------------------------------------------------------------------------

  /**
   * Hand the caller the connection coordinates for **their own** OpenClaw pod's
   * Gateway, derived from their OIDC session — so they log in once and the pod
   * connection follows, never a second login (see `docs/auth.md`).
   *
   * Under trusted-proxy gateway auth (CONN.4) the browser holds **no credential**:
   * it opens the returned `wss://` gateway URL, and the ingress authorises that
   * socket against the live session via `/auth/gateway-verify` (injecting the
   * verified user). So this route returns only the gateway URL — no token. The
   * earlier designs (a minted Kubernetes token, then a bootstrap pairing token)
   * are both retired.
   *
   * **Cross-tenant safety:** the target tenant is resolved solely from the
   * session's IdP-verified email — there is no request-supplied tenant input —
   * and an email matching more than one tenant fails closed. A caller therefore
   * cannot obtain another user's pod connection.
   *
   * **This route is mounted before `___AuthMiddleware`** (the whole auth router
   * is public), so it enforces the session check inline.
   */
  router.post("/pod-token", async function _podToken(req, res, next)
  {
    try
    {
      // 1. Require an established OIDC browser session.
      const authUser = req.session?.authUser;
      if (!authUser)
      {
        res.status(401).json({ error: "Authentication required", code: "UNAUTHORIZED" });
        return;
      }

      // 2. Resolve the caller's tenant by their verified email (one pod per user).
      const email = typeof authUser.email === "string" ? authUser.email.toLowerCase() : "";
      if (!email)
      {
        res.status(403).json({ error: "Session has no email claim; cannot resolve a tenant", code: "FORBIDDEN" });
        return;
      }

      const matches = await prisma.tenant.findMany({
        where: { email: { equals: email, mode: "insensitive" } },
        select: { name: true, ingressHost: true, configOverrides: true },
      });

      if (matches.length === 0)
      {
        res.status(403).json({ error: "No OpenClaw is provisioned for this account", code: "NO_TENANT" });
        return;
      }

      // Fail closed: an ambiguous email→tenant mapping must never silently pick
      // one pod, which could hand the caller another tenant's connection.
      if (matches.length > 1)
      {
        res.status(409).json({ error: "Multiple OpenClaw pods match this account; contact your administrator", code: "AMBIGUOUS_TENANT" });
        return;
      }

      const tenant = matches[0];

      // 3. Resolve the pod's gateway URL (the connection coordinate).
      const pairing = _ResolveOpenClawPairing(tenant.configOverrides, tenant.ingressHost);
      if (!pairing)
      {
        res.status(409).json({ error: "OpenClaw pod is not paired yet", code: "POD_NOT_READY" });
        return;
      }

      // 4. Record the brokered connection so the per-user kill-switch (CONN.5)
      //    knows which (tenant, subject) connections exist to revoke. Best-effort:
      //    a registry write failure must not deny the caller their pod connection.
      const subject = authUser.sub.length > 0 ? authUser.sub : email;
      try
      {
        await _RecordBrokeredDevice(prisma, { tenant: tenant.name, subject, gatewayUrl: pairing.gatewayUrl });
      }
      catch (err)
      {
        _log.warn({ tenant: tenant.name, subject, err }, "failed to record brokered device (connection still granted)");
      }

      // 5. Return the connection coordinates for the gateway `connect` handshake;
      //    trusted-proxy auth happens at the ingress, so no token is handed back.
      res.status(200).json({
        gatewayUrl: pairing.gatewayUrl,
        tenant: tenant.name,
        ingressHost: tenant.ingressHost,
      });
    }
    catch (err)
    {
      next(err);
    }
  });

  /**
   * Self-serve "sign out my other sessions" — the per-user half of the CONN.5
   * kill-switch. Cuts only the caller's own brokered connections (subject-scoped),
   * so it revokes the caller's device tokens/pairings at the gateway and marks
   * their registry rows cut **without** deleting the shared per-tenant pod (which
   * would sign out everyone). The target tenant is resolved from the session's
   * IdP-verified email exactly as `/pod-token` — no request-supplied tenant input.
   *
   * **This route is mounted before `___AuthMiddleware`** (the whole auth router is
   * public), so it enforces the session check inline.
   */
  router.post("/pod-token/cut", async function _podTokenCut(req, res, next)
  {
    try
    {
      // 1. Require an established OIDC browser session.
      const authUser = req.session?.authUser;
      if (!authUser)
      {
        res.status(401).json({ error: "Authentication required", code: "UNAUTHORIZED" });
        return;
      }

      // 2. Resolve the caller's tenant by their verified email (one pod per user),
      //    failing closed on a missing or ambiguous mapping — never cut another
      //    user's connections.
      const email = typeof authUser.email === "string" ? authUser.email.toLowerCase() : "";
      if (!email)
      {
        res.status(403).json({ error: "Session has no email claim; cannot resolve a tenant", code: "FORBIDDEN" });
        return;
      }

      const matches = await prisma.tenant.findMany({
        where: { email: { equals: email, mode: "insensitive" } },
        select: { name: true },
      });

      if (matches.length === 0)
      {
        res.status(403).json({ error: "No OpenClaw is provisioned for this account", code: "NO_TENANT" });
        return;
      }

      if (matches.length > 1)
      {
        res.status(409).json({ error: "Multiple OpenClaw pods match this account; contact your administrator", code: "AMBIGUOUS_TENANT" });
        return;
      }

      // 3. Cut only this subject's connections — subject-scoped, so the pod is not
      //    force-deleted (see `_CutTenant`).
      const subject = authUser.sub.length > 0 ? authUser.sub : email;
      const result = await _CutTenant(coreApi, prisma, gatewayAdmin, { tenant: matches[0].name, namespace, subject, reason: "self-serve sign-out" });

      res.status(200).json({ status: "cut", ...result });
    }
    catch (err)
    {
      next(err);
    }
  });

  // --------------------------------------------------------------------------
  // OIDC browser flow
  // --------------------------------------------------------------------------

  /** Start the browser-based OIDC login flow. */
  router.get("/login", async function _login(req, res, next)
  {
    try
    {
      if (!authService.isEnabled())
      {
        res.status(503).json({ error: "OIDC is not configured for this control-plane instance" });
        return;
      }

      const returnTo = typeof req.query.returnTo === "string" ? req.query.returnTo : "/";

      // 1. Discover the provider and store the PKCE replay-protection values.
      const loginUrl = await authService.buildLoginUrl(req, returnTo);

      // 2. Redirect the browser to the external identity provider.
      res.redirect(302, loginUrl);
    }
    catch (err)
    {
      next(err);
    }
  });

  /** Complete the OIDC callback and redirect back into the SPA. */
  router.get("/callback", async function _callback(req, res, next)
  {
    try
    {
      if (!authService.isEnabled())
      {
        res.status(503).json({ error: "OIDC is not configured for this control-plane instance" });
        return;
      }

      // 1. Validate the authorization response and establish the local session.
      const returnTo = await authService.completeLogin(req);

      // 2. Redirect the user back into the control-plane UI.
      res.redirect(302, returnTo);
    }
    catch (err)
    {
      next(err);
    }
  });

  /** Destroy the local session without requiring a provider-specific logout endpoint. */
  router.post("/logout", async function _logout(req, res, next)
  {
    try
    {
      await authService.logout(req);
      res.status(204).send();
    }
    catch (err)
    {
      next(err);
    }
  });

  // --------------------------------------------------------------------------
  // Device authorization grant (CLI login — RFC 8628-style)
  // --------------------------------------------------------------------------

  /**
   * Step 1 — CLI initiates: create a device grant and return the codes.
   *
   * The CLI uses the returned deviceCode for polling and opens verificationUri
   * in the operator's browser so they can authenticate and approve the grant.
   */
  router.post("/device", function _deviceRequest(req, res)
  {
    // 1. Allocate a new pending grant with a 5-minute TTL.
    const grant = _CreateDeviceGrant();

    // 2. Build the browser URL the CLI will print for the user to open.
    const verificationUri = `/api/v1/auth/device/activate?userCode=${encodeURIComponent(grant.userCode)}`;

    // 3. Return codes and metadata so the CLI can start polling.
    res.status(200).json({
      deviceCode: grant.deviceCode,
      userCode: grant.userCode,
      verificationUri,
      expiresIn: 300,
      interval: 5,
    });
  });

  /**
   * Step 2 — Browser activates: the user opens this URL in a browser after OIDC login.
   *
   * If the user has no OIDC session yet, this endpoint redirects to the login flow
   * with a `returnTo` pointing back here — `_sanitizeReturnTo` in the OIDC service
   * allows relative paths, so the redirect-back survives the callback intact.
   */
  router.get("/device/activate", async function _deviceActivate(req, res, next)
  {
    try
    {
      const userCode = typeof req.query.userCode === "string" ? req.query.userCode.trim() : "";

      // 1. Redirect to OIDC login when the operator has no active session.
      if (!req.session?.authUser)
      {
        if (!authService.isEnabled())
        {
          res.status(503).json({ error: "OIDC is not configured — cannot activate device grant" });
          return;
        }

        const returnTo = `/api/v1/auth/device/activate?userCode=${encodeURIComponent(userCode)}`;
        const loginUrl = await authService.buildLoginUrl(req, returnTo);
        res.redirect(302, loginUrl);
        return;
      }

      // 2. Look up the grant; reject unknown or expired user codes immediately.
      const grant = _FindGrantByUserCode(userCode);
      if (!grant)
      {
        res.status(404).json({ error: "Device code not found or expired. Run `oc auth login` again." });
        return;
      }

      // 3. Create a named access token in the database on behalf of the authenticated user.
      const plainText = `ocp_${randomBytes(24).toString("hex")}`;
      const tokenHash = createHash("sha256").update(plainText).digest("hex");
      const owner = (req.session.authUser as { sub?: string; email?: string }).sub
        ?? (req.session.authUser as { sub?: string; email?: string }).email
        ?? "unknown";

      await prisma.accessToken.create({
        data: {
          name: `cli-device-${grant.userCode}`,
          owner,
          tokenHash,
          expiresAt: null,
        },
      });

      // 4. Mark the in-memory grant as authorized so the polling CLI can collect the token.
      _AuthorizeDeviceGrant(grant.deviceCode, plainText);

      // 5. Return a plain success page — the CLI picks up the token via polling.
      res.status(200).send(
        "<!DOCTYPE html><html><body><h1>Login successful</h1>"
        + "<p>You may close this tab. The CLI has been authenticated.</p>"
        + "</body></html>",
      );
    }
    catch (err)
    {
      next(err);
    }
  });

  /**
   * Step 3 — CLI polls: returns the token once the operator has activated in the browser.
   *
   * Returns one of three states:
   *   - pending   → the operator has not yet opened the activation URL
   *   - authorized → token is present; the CLI stores it and stops polling
   *   - expired   → the grant timed out; the CLI must restart the login flow
   *
   * The token is delivered exactly once: after "authorized" is returned the
   * grant is deleted from the store.
   */
  router.get("/device/token", function _deviceToken(req, res)
  {
    const deviceCode = typeof req.query.deviceCode === "string" ? req.query.deviceCode.trim() : "";

    const result = _PollDeviceGrant(deviceCode);

    if (result.status === "authorized")
    {
      res.status(200).json({ status: "authorized", token: result.accessToken });
      return;
    }

    if (result.status === "expired")
    {
      res.status(410).json({ status: "expired", error: "Grant expired. Run `oc auth login` again." });
      return;
    }

    res.status(202).json({ status: "pending" });
  });

  return router;
}
