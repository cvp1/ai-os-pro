---
name: ask-model
description: Ask a hosted LLM (OpenRouter, Gemini, or DeepSeek) using an API key stored in the secret-broker — the key is injected by the broker and never appears in this chat. Use when you want a second opinion from a specific hosted model, or to route a task to a cheaper/stronger model than the current one.
---

# /ask-model — call a hosted model with a keyring-stored key

This is an example of building your own authenticated capability on top of the
**secret-broker** (`~/ai-os/bin/secret`). The provider API key lives under a handle
(`secret://openrouter`, `secret://gemini`, `secret://deepseek`); I never see it —
the broker injects it and returns only the model's response.

**Prerequisite:** the key is stored once (see the secret-broker component). Check
with `~/ai-os/bin/secret list`. If a provider's handle is missing, guide the user
to store it: `~/ai-os/bin/secret set secret://openrouter` (no echo).

## How I call each provider

I write the request body to a temp file, then hand the broker the endpoint + how
to inject the key. I parse the outcome; the key never touches my context.

**OpenRouter** (handle `secret://openrouter`, `Authorization: Bearer`):
```sh
echo '{"model":"MODEL_SLUG","messages":[{"role":"user","content":"PROMPT"}]}' > /tmp/req.json
~/ai-os/bin/secret fetch secret://openrouter \
  --url https://openrouter.ai/api/v1/chat/completions \
  --inject bearer --method POST --data-file /tmp/req.json
# response: .choices[0].message.content
```

**DeepSeek** (handle `secret://deepseek`, `Authorization: Bearer`, OpenAI-shaped):
```sh
echo '{"model":"deepseek-chat","messages":[{"role":"user","content":"PROMPT"}]}' > /tmp/req.json
~/ai-os/bin/secret fetch secret://deepseek \
  --url https://api.deepseek.com/chat/completions \
  --inject bearer --method POST --data-file /tmp/req.json
# response: .choices[0].message.content
```

**Gemini** (handle `secret://gemini`, `x-goog-api-key` header — cleaner than `?key=`):
```sh
echo '{"contents":[{"role":"user","parts":[{"text":"PROMPT"}]}]}' > /tmp/req.json
~/ai-os/bin/secret fetch secret://gemini \
  --url "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent" \
  --inject header:x-goog-api-key --method POST --data-file /tmp/req.json
# response: .candidates[0].content.parts[0].text
```

## Rules

- Always route the key through the broker — never read a `secret://` value, never
  put a key in a URL query, a file I write, or this conversation.
- Clean up the temp request file after (it holds only the prompt, never the key).
- A model call is an outbound write; I propose it and act on your go (Ask mode).
- Every call is logged metadata-only by the broker (handle · host · ok/failed).
