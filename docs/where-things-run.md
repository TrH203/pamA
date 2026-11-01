# Where things run

pamA is one codebase with three deployment modes. Some parts must stay on your machine; the
rest can move. The console shows the live answer under **Settings → Where things run**
(`GET /v1/settings/topology`), computed from the server's configuration.

| Component | Local | Self-host | pamA Cloud | Movable? |
| --- | --- | --- | --- | --- |
| Capture, redaction, raw transcripts (`pama`) | device | device | device | No: the privacy boundary |
| CLI, tray app, global hotkey | device | device | device | No: they need your files and keychain |
| Digest drafting | local server | device (`pama connect`) | device (`pama connect`) | Yes |
| Small model (classifier, judge, suggestions) | your choice | your choice | operator's | Yes |
| Answering model | your choice | your choice | operator's, or your own key | Yes |
| Embeddings | your choice | your choice | operator's | Yes (re-indexes) |
| Digest storage | embedded PGlite | your Postgres | hosted Postgres | Yes |
| Review console | 127.0.0.1 | your server | hosted | Yes |
| Ask Links | LAN or tunnel only | your domain | public | Yes |
| Email (sign-in) | not needed | SMTP | SMTP | n/a |

"Your choice" for a model means local (Ollama, vLLM, LM Studio: nothing leaves) or cloud
(OpenAI, Anthropic, OpenRouter, DeepInfra, any OpenAI-compatible API). Cloud models receive
approved digest content and questions, never raw transcripts.

## Connecting and switching home

`home` is where this machine's work lives: `local` (the embedded server) or a server URL.

```bash
pama connect https://pama.example.com     # browser approval; registers the server and makes it home
pama connect https://pama.example.com --code ABCD-1234   # pairing code instead of a browser
pama server list                          # connected servers, which one is default
pama server use https://other.example.com # change the default without logging in again
pama server forget https://old.example.com
pama use local                            # preview what changes, then switch (--yes to skip asking)
```

`pama login` and `pama pair` still work but print a hint to use `pama connect`. The default sync
target (`sync.default_target`) and the list of servers (`remote.servers`) are kept consistent:
pairing registers the server too, forgetting the default moves it to another connected server (or clears it), and a default missing from the list is repaired on the next command. The desktop app follows
`home`: in remote mode its background loop drafts on the device, delivers to the server and
pulls review decisions, and the project sync switch edits the device's per-project list.

## Models: which one is in effect

Provider ids, default endpoints, roles, whether a key is needed and whether a provider runs
locally come from one file, `packages/types/providers.json`, read by the server and the CLI.
Ids such as `lmstudio`, `vllm`, `openai` and `deepinfra` are presets of the OpenAI-compatible
protocol with a default endpoint; settings are stored under the protocol id, so older servers and
devices keep reading them.

Saved settings win over environment variables, which win over built-in defaults.
`GET /v1/models/effective` returns each role with `origin` (`saved`, `env`, `default`) and never a
key; `pama model show` prints it, plus, in remote mode, the device's drafting model as a separate
`device` row. `pama model setup --preset offline|openrouter|openai|anthropic-deepinfra` starts the
guided setup from a preset.

## Keys

```bash
pama keys list                  # which providers have a key and where it is stored (never the value)
pama keys set openrouter        # reads the key from stdin
pama keys test openrouter       # lists models with the key, through the egress guard
pama keys remove openrouter
```

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
