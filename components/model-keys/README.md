# model-keys — call hosted LLMs with keyring-stored keys

An example native-component skill (`/ask-model`) that uses the
[secret-broker](../secret-broker/) to call **OpenRouter**, **Gemini**, or
**DeepSeek** — the API key stays in your keyring (or the fscrypt file store), the
AI never sees it.

This is the showcase for the broker: *build your own authenticated capability
without a credential ever touching the model's context.* A hosted-model second
opinion is just the first thing you can wire this way.

## Install

```sh
../../install.sh model-keys          # or, from repo root: ./install.sh model-keys
```

Registers `/ask-model` at `~/.claude/skills/ask-model/SKILL.md`. Requires the
secret-broker component and the provider keys you want stored:

```sh
~/ai-os/bin/secret set secret://openrouter    # Authorization: Bearer
~/ai-os/bin/secret set secret://gemini        # x-goog-api-key header
~/ai-os/bin/secret set secret://deepseek      # Authorization: Bearer
```

Start a fresh Claude Code session so `/ask-model` registers.

## Providers

| Handle | Endpoint | Key injection |
|---|---|---|
| `secret://openrouter` | `openrouter.ai/api/v1/chat/completions` | `--inject bearer` |
| `secret://deepseek` | `api.deepseek.com/chat/completions` | `--inject bearer` |
| `secret://gemini` | `…/v1beta/models/<model>:generateContent` | `--inject header:x-goog-api-key` |

See `skill/SKILL.md` for the exact request bodies and response paths.
