/**
 * `@opencrane/infra-api` — shared Kubernetes API plumbing used by both the
 * fleet-manager and the clustertenant-manager: CRD identity constants and the
 * normalisation helpers for @kubernetes/client-node error shapes.
 */
export * from "./crd-constants.js";
export * from "./k8s-errors.js";
