FROM node:22-bookworm-slim

# Slim image — Node runtime only, no OpenClaw baked in.
# OpenClaw is installed into the per-tenant GCS bucket on first boot.

COPY apps/tenant/deploy/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Create mount points for volumes
RUN mkdir -p /data/openclaw /data/secrets /shared-skills /config /etc/openclaw

ENV OPENCLAW_STATE_DIR=/data/openclaw
ENV OPENCLAW_SECRETS_DIR=/data/secrets
ENV OPENCLAW_ENCRYPTION_KEY_PATH=/etc/openclaw/encryption-key/key

EXPOSE 18789

ENTRYPOINT ["/entrypoint.sh"]
