# GLM Chat Provider

Z.AI GLM models as a VS Code Language Model Chat Provider for the Coding Plan.

Supports both platforms of the GLM Coding Plan:

- **Z.AI (Global)** — `api.z.ai`
- **ZHIPU (China)** — `open.bigmodel.cn`

The platform is detected automatically (`auto`, default), and can also be
pinned in settings.

### Text Models

| Model | Context | Output | Thinking | Tool Calling |
|---|---|---|---|---|
| GLM-5.3 | 1M | 131K | Always on (low/high/max effort) | Yes |
| GLM-5.3-Flash | 1M | 131K | Always on (low/high/max effort) | Yes |
| GLM-5.2 | 1M | 131K | Auto / high / max / off | Yes |
| GLM-5.1 | 205K | 131K | Auto on/off | Yes |
| GLM-5 | 205K | 131K | Auto on/off | Yes |
| GLM-5-Turbo | 205K | 131K | Auto on/off | Yes |
| GLM-4.7 | 205K | 131K | Auto on/off | Yes |
| GLM-4.7 Flash | 205K | 131K | Auto on/off | Yes |
| GLM-4.7 FlashX | 205K | 131K | Auto on/off | Yes |
| GLM-4.6 | 205K | 131K | Auto on/off | Yes |
| GLM-4.5 | 131K | 98K | Always on | Yes |
| GLM-4.5 Flash | 131K | 98K | Always on | Yes |
| GLM-4.5 Air | 131K | 98K | Always on | Yes |

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

### Thinking modes

Per-model thinking control (also under `GLM: Set Thinking Effort`):

- **Auto** — let the model decide (GLM-4.7–5.2 series)
- **High / Max effort** — reasoning intensity control (GLM-5.2/5.3)
- **Low / High / Max** — always-on models with effort selection (GLM-5.3)
- **Enabled / Disabled** — simple on/off (GLM-4.5–5.1)

### Temperature presets

`GLM: Set Temperature` or the per-chat model picker: Balanced (0.7),
Precise (0.2), Creative (0.9), Max (1.0), or a custom value.

## Commands

- `GLM: Set API Key` — Store your API key in VS Code secrets
- `GLM: Clear API Key` — Remove the stored API key
- `GLM: Manage Provider` — Open provider management options
- `GLM: Set Thinking Effort` — Choose the global default thinking mode
- `GLM: Set Temperature` — Choose a temperature preset or custom value
- `GLM: Refresh Plan Usage` — Refresh the Coding Plan quota now
- `GLM: Show Usage Diagnostics` — Print raw usage-monitor API responses
  (both platforms × both auth schemes) to the Output channel, for
  troubleshooting

## Settings

| Setting | Default | Description |
|---|---|---|
| `glm-chat-provider.apiProvider` | `zhipu` | API provider: `zhipu` / `zai` / `custom` |
| `glm-chat-provider.customBaseUrl` | — | Base URL for the custom provider (used as-is) |
| `glm-chat-provider.customApiProtocol` | `chat-completions` | Wire protocol for the custom provider |
| `glm-chat-provider.apiRegion` | `auto` | Official platform selection (deprecated; `apiProvider` takes precedence) |
| `glm-chat-provider.defaultThinkingMode` | `auto` | Global thinking mode default |
| `glm-chat-provider.temperature` | `0.7` | Temperature for the "Custom" preset |
| `glm-chat-provider.showPlanUsage` | `true` | Show plan usage in the status bar (official platforms only) |
| `glm-chat-provider.usageRefreshIntervalSeconds` | `300` | Usage refresh period (0 disables) |

## How to Use

1. Open the Command Palette and run `GLM: Set API Key` to configure your API
   key (from a GLM Coding Plan subscription on z.ai or open.bigmodel.cn)
2. Use the provider from VS Code's Language Model Chat UI and select
   **Z.AI GLM**
3. Watch your plan quota in the status bar

---

## License

MIT (c) Denizhan Dakilir
