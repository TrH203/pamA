# Self-hosting pamA

Run the pamA server on your own infrastructure so Ask Links stay up when your laptop is off and
data stays inside your company. Target: **under 15 minutes** on a clean Linux host (SC-009).

## What you need

- A Linux server with Docker and Docker Compose v2, 1 vCPU / 2 GB RAM is enough to start.
- A domain name pointing at it, and TLS in front (Caddy example below).
- Optional but recommended: an SMTP account (sign-in links, email codes, owner replies).
- A model provider: Anthropic API key, or your own vLLM/Ollama. Embeddings need Ollama (bge-m3)
  or an OpenAI-compatible endpoint.

## 1. Configure (3 minutes)

```bash
git clone https://github.com/TrH203/pama && cd pama
cp deploy/.env.example deploy/.env
openssl rand -base64 36   # run 4 times: PAMA_SECRET, PAMA_OWNER_TOKEN, POSTGRES_PASSWORD, PAMA_DB_PASSWORD
$EDITOR deploy/.env       # base URL, your email, secrets, SMTP, models
```

## 2. Start (5–8 minutes, mostly the image build)

```bash
docker compose -f deploy/docker-compose.yml up -d --build
curl -s http://127.0.0.1:7465/v1/health
# {"status":"ok","mode":"selfhost","db":"pg","version":"0.1.0","capabilities":["branch_lists"]}
```

The server listens on `127.0.0.1:7465` by default. Put a TLS reverse proxy in front.

## 3. TLS with Caddy (2 minutes)

```caddyfile
pama.example.com {
  reverse_proxy 127.0.0.1:7465
}
```

`sudo caddy run --config Caddyfile` obtains certificates automatically. Make sure
`PAMA_BASE_URL=https://pama.example.com` so links and sign-in emails use the right address.

## 4. Sign in and connect your machine (2 minutes)

1. Open `https://pama.example.com`, enter `PAMA_OWNER_EMAIL`, click the emailed link.
   Without SMTP: use the API with `Authorization: Bearer $PAMA_OWNER_TOKEN`.
2. With email set up, the quickest way is `pama login --server https://pama.example.com` on your
   machine (approve in the browser). It also lets the machine work in remote mode: only `pama`
   installed, review and links on this server (see [cloud server](deploy-cloud.md#3-owners-connect)).
   Otherwise create a pairing code (the console has no Devices page yet):
   `curl -X POST -H "Authorization: Bearer $PAMA_OWNER_TOKEN" https://pama.example.com/v1/devices/pairing-code`
3. On your machine: `pama pair <CODE> --server https://pama.example.com`
4. Choose what to share: `pama sync status`, then `pama sync enable --project <id>`.
   Only approved digests leave your machine; raw transcripts never do.

## Security notes

- The database is only reachable inside the compose network. The server connects as the
  non-superuser `pama_server`; answers read digest items as `pama_app` with row-level security.
- `PAMA_STRICT_OFFLINE=true` with `PAMA_DECLARED_HOSTS` blocks every other outbound connection.
- Turning sync off on a laptop deletes that source's copies here and takes its links down.

## Backups

```bash
docker compose -f deploy/docker-compose.yml exec db pg_dump -U postgres -Fc pama > pama-$(date +%F).dump
# restore into a fresh volume:
docker compose -f deploy/docker-compose.yml exec -T db pg_restore -U postgres -d pama --clean < pama-YYYY-MM-DD.dump
```

## Upgrades

```bash
git pull
docker compose -f deploy/docker-compose.yml up -d --build   # migrations run at start
```

**Upgrade the server before the devices that sync to it.** Newer devices send a session's branch
list (`source.git.branches`) only to servers that advertise `branch_lists` in `/v1/health`
(`"capabilities": ["branch_lists"]`); an older server keeps working but sees only the single branch
a session is filed under.

## pamA Cloud

The hosted service runs this same image with `PAMA_MODE=cloud`: each email that signs in gets its
own workspace. Everything else — the pipeline, safety layers and API — is identical.
