# @opencrane/contracts

The public SDK and API contract for the OpenCrane Control Plane. It contains a
typed TypeScript client (`openapi-fetch`) and DTOs generated from the Control
Plane OpenAPI 3.1 specification (`apps/control-plane/openapi.json`).

## Licensing

This package is licensed under **MIT** (see [`LICENSE`](./LICENSE)), unlike the
rest of the OpenCrane platform, which is AGPL-3.0-or-later. This is a deliberate
relicensing by the copyright owner so that external consumers — including
proprietary frontends — can use the generated client and types without
inheriting AGPL obligations.

The MIT grant covers only the contents of this `libs/contracts/` directory.

## Consuming the contract from an external project

You do **not** need to import this package to build a client. The Control Plane
publishes its OpenAPI spec two ways:

- At runtime: `GET /api/v1/openapi.json`
- As a **release asset** named `openapi.json` on each tagged OpenCrane release.

External (proprietary) frontends should pin a released `openapi.json` and run
`openapi-typescript` against it to generate their own client. That keeps a clean
process/network boundary and avoids linking against any AGPL code:

```bash
# Pin a specific OpenCrane release, then generate a typed client locally.
curl -fsSL -o openapi/opencrane.json \
  https://github.com/<org>/opencrane/releases/download/<tag>/openapi.json
pnpm exec openapi-typescript openapi/opencrane.json -o src/api/generated.ts
```
