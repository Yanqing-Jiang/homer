# Homer Azure Proxy

A lightweight Express proxy that runs on Azure Container Apps and fronts the Cloudflare Tunnel that points at the Homer daemon, so client traffic only ever sees Azure domains.

## Architecture

```
Browser → Azure Blob Storage (static UI)
        → Azure Container Apps (this proxy)
        → Cloudflare Tunnel
        → Homer daemon (your origin)
```

A restrictive network sees `*.web.core.windows.net` → `*.azurecontainerapps.io` and never sees the origin domain.

## Routes

| Route | Target | Purpose |
|-------|--------|---------|
| `/api/*` | `$HOMER_API_URL/api/*` | Homer daemon API |
| `/supabase/*` | `$SUPABASE_URL/*` | Supabase auth (origin hidden from client) |
| `/health` | (local) | Azure health checks |

Both `HOMER_API_URL` and `SUPABASE_URL` are **required** — the proxy refuses to start if either is missing.

## Local Development

```bash
npm install
HOMER_API_URL=https://your-tunnel.example.com \
SUPABASE_URL=https://your-project.supabase.co \
npm run dev
```

## Deploy to Azure Container Apps

### 1. Build and push container

```bash
az acr login --name <your-registry>
docker build -t <your-registry>.azurecr.io/homer-proxy:latest .
docker push <your-registry>.azurecr.io/homer-proxy:latest
```

### 2. Create Container App

```bash
az containerapp create \
  --name homer-proxy \
  --resource-group homer-rg \
  --environment homer-env \
  --image <your-registry>.azurecr.io/homer-proxy:latest \
  --target-port 8080 \
  --ingress external \
  --env-vars HOMER_API_URL=https://your-tunnel.example.com SUPABASE_URL=https://your-project.supabase.co
```

### 3. Update Web UI config

Point the SvelteKit UI at the Container App URL:

```env
VITE_API_BASE=https://<container-app-name>.<region>.azurecontainerapps.io
VITE_SUPABASE_URL=https://<container-app-name>.<region>.azurecontainerapps.io/supabase
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No (default 8080) | Server port |
| `HOMER_API_URL` | Yes | Homer daemon origin URL (your Cloudflare Tunnel hostname) |
| `SUPABASE_URL` | Yes | Supabase project URL |

## Security Notes

- CORS is configured to only allow Azure Blob Storage and Static Web Apps domains
- All traffic is proxied over HTTPS
- Health endpoint for container orchestration
