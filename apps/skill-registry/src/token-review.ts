import * as k8s from "@kubernetes/client-node";

/**
 * Result of a token review — either a validated tenant identity or a rejection.
 */
export type TokenReviewResult =
  | { ok: true; tenantName: string; namespace: string }
  | { ok: false; reason: string };

/**
 * Validate a Kubernetes projected ServiceAccount token and extract the tenant name.
 *
 * Projected tokens used by tenant pods carry the subject:
 *   system:serviceaccount:<namespace>:<tenant-name>
 *
 * The audience is expected to be "skill-registry" — tokens not bound to that
 * audience are rejected so pods cannot use tokens intended for other planes.
 *
 * @param authApi - Kubernetes Authentication V1 API client.
 * @param token   - Raw bearer token from the Authorization header.
 * @returns Validated tenant name and namespace, or a rejection reason.
 */
export async function _ReviewToken(authApi: k8s.AuthenticationV1Api, token: string): Promise<TokenReviewResult>
{
  let response: k8s.V1TokenReview;
  try
  {
    const review = new k8s.V1TokenReview();
    review.spec = new k8s.V1TokenReviewSpec();
    review.spec.token = token;
    review.spec.audiences = ["skill-registry"];

    const result = await authApi.createTokenReview({ body: review });
    response = result;
  }
  catch (err)
  {
    const message = err instanceof Error ? err.message : "unknown error";
    return { ok: false, reason: `TokenReview API call failed: ${message}` };
  }

  if (!response.status?.authenticated)
  {
    return { ok: false, reason: response.status?.error ?? "token not authenticated" };
  }

  // Subject format: system:serviceaccount:<namespace>:<name>
  const subject = response.status.user?.username ?? "";
  const parts = subject.split(":");
  if (parts.length !== 4 || parts[0] !== "system" || parts[1] !== "serviceaccount")
  {
    return { ok: false, reason: `unexpected token subject format: ${subject}` };
  }

  const namespace = parts[2];
  const tenantName = parts[3];

  return { ok: true, tenantName, namespace };
}
