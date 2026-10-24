# Running a pamA cloud server

A cloud server hosts many owners: anyone can sign up with an email and gets a separate workspace.
Owners install only the `pama` command and connect it with `pama login` (remote mode, spec 004):
their machines draft digests locally, and review, Ask Links and the inbox live on this server.
Raw transcripts never reach it.

This guide extends [self-host](self-host.md); the image and compose file are the same. Target:
reachable over HTTPS with sign-up working in **under 30 minutes**.

## What you need

- Everything in [self-host › What you need](self-host.md#what-you-need).
- A working SMTP account: sign-up and sign-in are email links (required in cloud mode).
- Answering models for all workspaces (owners may bring their own chat model, see below).

## 1. Configure

```bash
git clone https://github.com/TrH203/pama && cd pama
cp deploy/.env.example deploy/.env
openssl rand -base64 36   # run 4 times: PAMA_SECRET, PAMA_OWNER_TOKEN, POSTGRES_PASSWORD, PAMA_DB_PASSWORD
$EDITOR deploy/.env
```

In `deploy/.env`:

```bash
PAMA_MODE=cloud
PAMA_BASE_URL=https://pama.example.com
# Leave PAMA_OWNER_EMAIL empty: in cloud mode every email can sign up.
PAMA_OWNER_EMAIL=
# PAMA_OWNER_TOKEN is the operator credential: it changes the server-wide models and acts in
# the default workspace. Keep it out of owners' hands.
SMTP_URL=smtp://user:password@smtp.example.com:587
SMTP_FROM=pamA <pama@example.com>
PAMA_PUBLISH=127.0.0.1:7465
```

Models (`PAMA_CHAT_*`, `PAMA_SMALL_MODEL`, `PAMA_EMBED_*`) are the operator defaults for every
workspace. Embeddings and the small model are always operator-wide; one vector index serves all
workspaces, isolated by workspace in the data layer.

## 2. Start and put TLS in front

```bash
docker compose -f deploy/docker-compose.yml up -d --build
curl -s http://127.0.0.1:7465/v1/health
# {"status":"ok","mode":"cloud",…,"capabilities":["branch_lists","device_login","drafts","changes"]}
```

TLS with Caddy, as in [self-host › TLS](self-host.md#3-tls-with-caddy-2-minutes). Cookies are
marked `Secure` when `PAMA_BASE_URL` starts with `https://`.

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

```bash
# Nightly backup (keep several, store off-host)
docker compose -f deploy/docker-compose.yml exec -T db pg_dump -U postgres -Fc pama > pama-$(date +%F).dump
# Restore into an empty database
docker compose -f deploy/docker-compose.yml exec -T db pg_restore -U postgres -d pama --clean < pama-2026-10-25.dump

# Upgrade: pull, rebuild, restart. Migrations run at start-up.
git pull && docker compose -f deploy/docker-compose.yml up -d --build
```

Back up `deploy/.env` too: without `PAMA_SECRET`, stored model keys cannot be decrypted.

## Security notes

- Workspaces are isolated in every query by workspace id; Ask Link retrieval additionally runs
  under row-level security (see [security model](security-model.md)).
- Device tokens act as the owner of their workspace. Owners see and revoke them in the console;
  `pama logout` revokes the current one.
- Drafts arrive already redacted by the device; Layer 2 (rules + classifier) runs again at ingest.
- Turning sync off on a machine deletes that project's drafts and digests here.
