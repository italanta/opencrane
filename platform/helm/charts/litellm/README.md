# LiteLLM Chart

Local subchart used by OpenCrane Phase II to deploy an in-cluster LiteLLM service.

## Values

- `image.repository`, `image.tag`, `image.pullPolicy`
- `service.port`
- `masterKey` or `existingSecret` + `secretKey`
- `databaseUrl` or `existingDatabaseSecret` + `databaseSecretKey`
- `resources`
