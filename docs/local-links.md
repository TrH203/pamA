# Sharing Ask Links from local mode

In local mode the server runs on your machine and listens on **127.0.0.1 only**. Ask Links work
for people who can reach your machine, and only while it is on. Pick one option:

| Option | Who can open the link | TLS ends at | Notes |
|---|---|---|---|
| Same machine | you | — | Default; good for testing |
| LAN (`pama server start --lan`) | people on your network | — (plain HTTP) | Use only on trusted networks; PIN or email access recommended |
| Tailscale Funnel | anyone with the URL | **your machine** | Recommended: traffic stays encrypted until it reaches you |
| Cloudflare Tunnel | anyone with the URL | **Cloudflare** | Cloudflare can see question and answer traffic in clear |
| Self-host / pamA Cloud | anyone with the URL, always on | your server | Enable sync per project or bundle (`pama sync enable`) |

## Tailscale Funnel

```bash
pama server status                 # note the port, e.g. 7465
tailscale funnel 7465
```

Set `PAMA_BASE_URL` (or start the desktop app with it) to the Funnel URL so new links print the
right address.

## When the machine sleeps

Askers who already have the page open see "the owner's agent is offline"; new visitors cannot load
the page at all. For always-on links, sync the sources to a self-hosted server.

## Strict offline mode and local models

`pama config set strict_offline true` blocks every outbound connection pamA makes except to
declared hosts (`pama config set declared_hosts localhost,ollama.lan:11434`) and logs each attempt
(`pama` desktop › Settings › Network log, or `GET /v1/network-log`). The guard covers pamA's own
processes only: Ollama, vLLM or a tunnel client are separate programs and are not restricted by it.
