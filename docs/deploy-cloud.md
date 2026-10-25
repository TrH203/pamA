# Running a pamA cloud server

A cloud server hosts many owners: anyone can sign up with an email and gets a separate workspace.
Owners install only the `pama` command and connect it with `pama login` (remote mode, spec 004):
their machines draft digests locally, and review, Ask Links and the inbox live on this server.
Raw transcripts never reach it.

This guide extends [self-host](self-host.md); the server image is the same. Target:
reachable over HTTPS with sign-up working in **under 30 minutes**.

## What you need

- A Linux VM with 2 GB RAM and a static IP. The reference setup is **AWS Lightsail 2 GB**
  (`small_3_0`, Ubuntu 24.04): Postgres runs in a container on the same VM and embeddings come
  from an API, so nothing else is needed. Open ports 22 (your IP only), 80 and 443.
- Two host names pointing at the VM: one for the console and API (`PAMA_DOMAIN`, e.g.
  `app.example.com`) and one for the landing page (`PAMA_LANDING_DOMAIN`, e.g. `example.com`,
  served from [`landing/`](../landing)). No domain yet? Use [sslip.io](https://sslip.io) names
  built from the static IP: for `13.212.5.9`, `app.13-212-5-9.sslip.io` and `13-212-5-9.sslip.io`.
  Caddy gets real certificates for them; switch to your own domain later by changing the two
  variables and `PAMA_BASE_URL` follows.
- A working SMTP account: sign-up and sign-in are email links (required in cloud mode).
  Amazon SES works; verify the sending domain (SPF, DKIM) and leave the SES sandbox.
- Answering models for all workspaces (owners may bring their own chat model, see below).
- An embeddings API that returns **1024-dimension** vectors. The default is `BAAI/bge-m3` on an
  OpenAI-compatible endpoint (the same model local servers run through Ollama). The server
  checks the size at start-up (`pama doctor` reports a mismatch).
- Optional: an S3 bucket for backups and an IAM user that can only put objects into it.

Files: [`deploy/cloud/`](../deploy/cloud) holds the compose file (db, server, Caddy), the
Caddyfile, `.env.example`, `bootstrap.sh` and `backup.sh`.

## 1. Prepare the VM

```bash
# On the VM, once:
curl -fsSL https://raw.githubusercontent.com/TrH203/pamA/main/deploy/cloud/bootstrap.sh | bash
# Installs Docker and the AWS CLI, adds 2 GB swap, clones to /opt/pama, schedules backups.
```

Log out and in again, then fill in `/opt/pama/deploy/cloud/.env`:

```bash
openssl rand -base64 36   # run 4 times: PAMA_SECRET, PAMA_OWNER_TOKEN, POSTGRES_PASSWORD, PAMA_DB_PASSWORD
$EDITOR /opt/pama/deploy/cloud/.env
```

Required: `PAMA_DOMAIN`, `PAMA_LANDING_DOMAIN`, the four secrets, `SMTP_URL`, `SMTP_FROM`, `PAMA_CHAT_API_KEY`,
`PAMA_EMBED_API_KEY`. Leave `PAMA_OWNER_EMAIL` unset (commented out; an empty value fails validation): in cloud mode every email can sign up.
`PAMA_OWNER_TOKEN` is the operator credential: it changes the server-wide models and acts in the
default workspace. Keep it out of owners' hands.

Models (`PAMA_CHAT_*`, `PAMA_SMALL_MODEL`, `PAMA_EMBED_*`) are the operator defaults for every
workspace. Embeddings and the small model are always operator-wide; one vector index serves all
workspaces, isolated by workspace in the data layer.

## 2. Start

```bash
cd /opt/pama
docker compose -f deploy/cloud/docker-compose.yml up -d
curl -s https://app.example.com/v1/health
# {"status":"ok","mode":"cloud",…,"capabilities":["branch_lists","device_login","drafts","changes"]}
```

Caddy gets the TLS certificate on the first request once DNS points at the VM. The server has no
published port; only Caddy reaches it, which also keeps `X-Forwarded-For` (used for Ask Link
lockouts) trustworthy.

`PAMA_IMAGE` selects the server image (`ghcr.io/trh203/pama/server:<tag>`, built by the release
workflow; make the package public or `docker login ghcr.io` on the VM). If the image cannot be
pulled, compose builds it from the checkout; on 2 GB this is slow and relies on the swap file.

## 3. Owners connect

On a machine with only `pama` installed:

```bash
pama login --server https://pama.example.com     # opens the browser; sign in by email, approve the code
cd ~/code/my-project && pama init --sync          # capture + send drafts of this project
echo "$KEY" | pama model --device set chat --provider anthropic --model claude-haiku-5-5 --key-stdin --yes
pama doctor
```

The drafting model is the owner's choice on their machine (Ollama keeps everything local; a
cloud provider receives redacted session text). Over SSH, add `--no-browser` and open the printed
link anywhere.

## 4. Bring-your-own answering model (optional, per workspace)

An owner can answer their Ask Links with their own provider instead of the operator's:

```bash
echo "$KEY" | pama model set chat --provider anthropic --model claude-sonnet-5-5 --key-stdin --yes
pama model revert chat    # back to the server's model
```

Keys are encrypted with `PAMA_SECRET` and never shown again. Only public `https://` endpoints are
accepted (no IP literals, loopback or private ranges), so tenants cannot make the server call
into your network. Owners cannot change embedding or small models.

## Backups and upgrades

`bootstrap.sh` schedules `deploy/cloud/backup.sh` nightly at 03:30: `pg_dump` into
`deploy/cloud/backups/`, a copy to `BACKUP_S3_URI`, and local dumps older than
`BACKUP_KEEP_DAYS` removed. Turn on Lightsail automatic snapshots as a second layer. Test a
restore once:

```bash
docker compose -f deploy/cloud/docker-compose.yml exec -T db \
  pg_restore -U postgres -d pama --clean --if-exists < deploy/cloud/backups/pama-2026-10-25T0330.dump
```

Upgrade: run a backup, set `PAMA_IMAGE` to the new tag, `docker compose -f
deploy/cloud/docker-compose.yml pull && … up -d`. Migrations run at start-up, so roll back by
restoring the backup and setting the previous tag.

Back up `deploy/cloud/.env` too: without `PAMA_SECRET`, stored model keys cannot be decrypted.

## Security notes

- Workspaces are isolated in every query by workspace id; Ask Link retrieval additionally runs
  under row-level security (see [security model](security-model.md)).
- Device tokens act as the owner of their workspace. Owners see and revoke them in the console;
  `pama logout` revokes the current one.
- Drafts arrive already redacted by the device; Layer 2 (rules + classifier) runs again at ingest.
- Turning sync off on a machine deletes that project's drafts and digests here.
