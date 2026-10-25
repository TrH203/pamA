# Where things run

pamA is one codebase with three deployment modes. Some parts must stay on your machine; the
rest can move. The console shows the live answer under **Settings → Where things run**
(`GET /v1/settings/topology`), computed from the server's configuration.

| Component | Local | Self-host | pamA Cloud | Movable? |
| --- | --- | --- | --- | --- |
| Capture, redaction, raw transcripts (`pama`) | device | device | device | No: the privacy boundary |
| CLI, tray app, global hotkey | device | device | device | No: they need your files and keychain |
| Digest drafting | local server | device (`pama login`) | device (`pama login`) | Yes |
| Small model (classifier, judge, suggestions) | your choice | your choice | operator's | Yes |
| Answering model | your choice | your choice | operator's, or your own key | Yes |
| Embeddings | your choice | your choice | operator's | Yes (re-indexes) |
| Digest storage | embedded PGlite | your Postgres | hosted Postgres | Yes |
| Review console | 127.0.0.1 | your server | hosted | Yes |
| Ask Links | LAN or tunnel only | your domain | public | Yes |
| Email (sign-in) | not needed | SMTP | SMTP | n/a |

"Your choice" for a model means local (Ollama, vLLM, LM Studio: nothing leaves) or cloud
(Anthropic, OpenRouter, any OpenAI-compatible API). Cloud models receive approved digest content
and questions, never raw transcripts.

## OpenRouter

Pick **OpenRouter** under Settings → Models, or from the CLI:

```bash
pama model switch chat cloud --provider openrouter --model anthropic/claude-sonnet-4.5 --key-stdin
pama config set provider.openrouter.key -   # device-side drafting
```

Defaults to `https://openrouter.ai/api/v1`; model ids look like `vendor/model`. The key is stored
encrypted on the server (or in the OS keychain on a device) and is never shown again. In
strict offline mode, declare `openrouter.ai`. On pamA Cloud a workspace owner can use OpenRouter
as their own answering model; the endpoint is public HTTPS only.
