# ChatGPT — recipe guide

ChatGPT is browser-based and can't reach into your filesystem, so the flow is
straight copy-paste: paste the recipe, paste the inputs it asks for, then
paste the output back into your terminal.

## Recommended flow

**For `author-contribution.md`:**

1. Open a new ChatGPT conversation. Any capable model will do (GPT-4-class or
   newer recommended).
2. Copy the contents of [`recipes/author-contribution.md`](../author-contribution.md)
   and paste it into the chat.
3. When it asks (or in the same message), paste:
   - Your rough note, in place of `<PASTE YOUR ROUGH NOTE HERE>`.
   - The full contents of `.teamctx/context/shared.md`, in place of
     `<PASTE .teamctx/context/shared.md HERE>`.
4. Read the output. If ChatGPT asks a clarifying question, answer it before
   letting it write the final contribution.
5. Copy the final contribution into your terminal:
   ```
   teamctx contribute "<paste the shaped contribution here>"
   ```
   Add `--decision` if the recipe flagged it as a decision.

**For `cleanup-context.md`:**

Same pattern:

1. Paste [`recipes/cleanup-context.md`](../cleanup-context.md) into the chat.
2. Paste the current `.teamctx/context/shared.md` and optionally a focus area.
3. Copy the rewritten tree into a scratch file, `diff` it against your real
   `.teamctx/context/shared.md`, and apply the changes you want by hand.

## Tips

- For teams that use ChatGPT a lot, save each recipe as a **Custom GPT** with
  the recipe as its system prompt. Then contributors just paste their rough
  note and the current context — no need to paste the recipe every time.
- If your `shared.md` is large, ChatGPT may truncate. Split the cleanup into
  workstream-sized passes rather than one full-tree pass.
- ChatGPT can't run `teamctx` for you — always copy the final output back into
  your terminal to actually record the contribution.
