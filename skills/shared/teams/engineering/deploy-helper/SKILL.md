---
name: deploy-helper
description: Assists with deployment workflows and runbook execution
tags: [devops, deployment]
---

# Deployment Helper

When the user asks about deployments, follow this workflow:

## Pre-deploy Checklist
1. Verify all CI checks pass on the target branch
2. Confirm the changelog is up to date
3. Check for any active incidents that would block deployment

## Deploy Commands
- Staging: `kubectl rollout restart deployment/app -n staging`
- Production: requires explicit confirmation and links to the deploy runbook

## Post-deploy
1. Verify health checks pass
2. Check error rate dashboards for anomalies
3. Notify the team channel with deployment summary
