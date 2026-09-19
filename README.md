# GLM Chat Provider

Z.AI GLM models as a VS Code Language Model Chat Provider for the Coding Plan.

Supports both platforms of the GLM Coding Plan:

- **Z.AI (Global)** — `api.z.ai`
- **ZHIPU (China)** — `open.bigmodel.cn`

The platform is detected automatically (`auto`, default), and can also be
pinned in settings.

### General-purpose Models

| Model | Context | Output | Thinking | Tool Calling  Image Input |
|---|---|---|---|---|---|
| GLM-5.3 | 1M | 131K | Always on (low/high/max effort) | Yes  No |
| GLM-5.3-Flash | 1M | 131K | Always on (low/high/max effort) | Yes  Yes |
| GLM-5.3-FlashX | 1M | 131K | Always on (low/high/max effort) | Yes  Yes |
| GLM-5.2 | 1M | 131K | Auto / high / max / off | Yes  No |
| GLM-5.1 | 205K | 131K | Auto on/off | Yes  No |
| GLM-5 | 205K | 131K | Auto on/off | Yes  No |
| GLM-5-Turbo | 205K | 131K | Auto on/off | Yes  No |
| GLM-4.7 | 205K | 131K | Auto on/off | Yes  No |
| GLM-4.7 Flash | 205K | 131K | Auto on/off | Yes  No |
| GLM-4.7 FlashX | 205K | 131K | Auto on/off | Yes  No |
| GLM-4.6 | 205K | 131K | Auto on/off | Yes  No |
| GLM-4.5 | 131K | 98K | Always on | Yes  No |
| GLM-4.5 Flash | 131K | 98K | Always on | Yes  No |
| GLM-4.5 Air | 131K | 98K | Always on | Yes  No |

### Vision Models

| Model | Context | Output | Image Input | Thinking | Tool Calling |
|---|---|---|---|---|---|
| GLM-5V-Turbo | 205K | 131K | Yes | Auto on/off | Yes |
| GLM-4.6V | 131K | 33K | Yes | Auto on/off | Yes |
| GLM-4.5V | 64K | 16K | Yes | Always on | Yes |

## Features

### Coding Plan usage in the status bar

The status bar shows a **ZHIPU logo** with your plan quota percentage.
Hovering reveals a tooltip (Copilot-style) with:

- The platform your key was detected on
- 5-hour and weekly credit quotas with progress bars and reset times
- Session request count

Clicking the item refreshes the usage data. Usage refreshes periodically
(configurable) and after each completed chat request.

When you send a chat request, the token usage is also reported to VS Code so
the built-in chat **context window indicator** stays accurate.

### Multi-platform (region) support

`glm-chat-provider.apiRegion` setting:

- `auto` *(default)* — probe both platforms, China first; the first platform
  that recognizes your key wins and is remembered
- `china` — ZHIPU `open.bigmodel.cn` only
- `global` — Z.AI `api.z.ai` only

### Custom API provider (intranet / third-party gateway)

Set `glm-chat-provider.apiProvider` to `custom` to use your own server or a
third-party GLM gateway instead of the official platforms:

- `glm-chat-provider.customBaseUrl` — full base URL, used as-is (e.g.
  `https://gw.corp.local/glm/v4`)
- `glm-chat-provider.customApiProtocol` — wire protocol:
  - `chat-completions` — OpenAI Chat Completions compatible (default; most
    gateways)
  - `messages` — Anthropic Messages compatible
  - `responses` — OpenAI Responses compatible

Custom providers have no plan-quota monitor, so the status-bar usage indicator
is hidden automatically. Chat-completions remains the protocol used for the
official ZHIPU / Z.AI platforms.

Custom adapters preserve text/image blocks and tool-call history. Images are
serialized as Messages `image` blocks (base64 or URL) or Responses `input_image`
blocks. Streaming and non-streaming requests use the same request adapter.

| Protocol | Effort field | FlashX effort choices | Default |
|---|---|---|---|
| Chat Completions | `reasoning_effort` | low / high / max | max (server default) |
| Messages | `output_config.effort` | low / high / max | max |
| Responses | `reasoning.effort` | low / high | high |

The picker refreshes when the configured protocol changes. Responses has no
standard `max` effort value, so it is not offered; a saved `max` selection must
be changed explicitly, rather than silently becoming `high` or `xhigh`.
Messages maps enabled thinking to `thinking.type: adaptive`; the gateway must
support adaptive thinking and `output_config.effort` for its GLM backend.
Responses maps disabled thinking to `reasoning.effort: none`. Actual model
availability, sampling parameters and effort support depend on the gateway;
these wire adapters do not make an unsupported upstream model available.
System instructions and Responses assistant history are text-only; images in
those positions are rejected rather than discarded. Responses also rejects
unsupported stop sequences.

Protocol references: [Messages effort](https://platform.claude.com/docs/en/build-with-claude/effort),
[adaptive thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking#migrating-to-adaptive-thinking),
and [Messages images](https://platform.claude.com/docs/en/build-with-claude/vision).
Responses request shapes follow the installed OpenAI SDK definitions.

### Thinking modes

Per-model thinking control (also under `GLM: Set Thinking Effort`):

- **Auto** — let the model decide (GLM-4.7–5.2 series)
- **High / Max effort** — reasoning intensity control (GLM-5.2/5.3)
- **Low / High / Max** — always-on models with effort selection (GLM-5.3 / GLM-5.3-Flash / GLM-5.3-FlashX)
- **Enabled / Disabled** — simple on/off (GLM-4.5–5.1)

### Temperature presets

`GLM: Set Temperature` or the per-chat model picker: Balanced (0.7),
Precise (0.2), Creative (0.9), Max (1.0), or a custom value.

## Configuration

All settings live in the `@ext:DenizhanDaklr.glm-chat-provider` settings
section (no GLM commands in the Command Palette):

- **API provider / protocol / base URL** — set directly in settings
- **API key** — stored securely (masked, encrypted) in the chat model
  settings: model picker → ⚙️ / *Configure Models* → Z.AI GLM
- **Thinking mode & temperature** — per-model, via the gear entry next to
  the model name in the chat input box

## Settings

| Setting | Default | Description |
|---|---|---|
| `glm-chat-provider.apiProvider` | `zhipu` | API provider: `zhipu` / `zai` / `custom` |
| `glm-chat-provider.customBaseUrl` | — | Base URL for the custom provider (used as-is) |
| `glm-chat-provider.customApiProtocol` | `chat-completions` | Wire protocol for the custom provider |
| `glm-chat-provider.apiRegion` | `auto` | Official platform selection (deprecated; `apiProvider` takes precedence) |
| `glm-chat-provider.showPlanUsage` | `true` | Show plan usage in the status bar (official platforms only) |
| `glm-chat-provider.usageRefreshIntervalSeconds` | `300` | Usage refresh period (0 disables) |

## How to Use

1. Install this extension, then open the chat model picker → *Configure
   Models* → Z.AI GLM and enter your API key (from a GLM Coding Plan
   subscription on z.ai or open.bigmodel.cn). It is stored encrypted and
   displayed masked
2. Optionally adjust provider/protocol in the `@ext` settings section
3. Use the provider from VS Code's Language Model Chat UI and select
   **Z.AI GLM**
4. Watch your plan quota in the status bar (click to refresh)

---

## License

MIT (c) Denizhan Dakilir

## Development and packaging

Run `npm ci`, `npm test`, then `npm run package`. Tests cover model registration,
picker settings, all three protocol request bodies, multimodal/tool history,
and streaming/non-streaming dispatch without a live API key.
The VSIX packager is pinned in the lockfile. Packaging preserves the version in `package.json` and `package-lock.json`.
Bump the version explicitly in a separate release change when needed.

Before publishing 0.8.17, install the generated VSIX in VS Code 1.116 or newer
and check FlashX selection, low/high/max effort, an image prompt and a tool call
against an authorized account. Confirm model availability separately on each
official platform. CI packages VSIX artifacts; it does not publish to Marketplace.
