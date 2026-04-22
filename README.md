# Ariadne

A local-first desktop app for running a job search with an AI coach at your
shoulder. Tracks roles through your pipeline, generates tailored resumes,
scans job boards, helps you practice interviews, and keeps an organized
history of every chat you had while doing it.

Built with Tauri v2 (Rust backend, vanilla-JS frontend) and the
[Agent Client Protocol](https://agentclientprotocol.com/) for the AI layer.
Data lives in a local SQLite database; nothing is uploaded anywhere.

## Running it

```sh
git clone https://github.com/michaeldrey/Ariadne
cd Ariadne
cargo tauri dev
```

## Authentication

Ariadne needs access to an LLM. You need **one** of the following — it works
fine with either:

- **Claude Pro or Max subscription** — install the
  [Claude Code CLI](https://docs.claude.com/en/docs/claude-code/overview),
  run `claude /login` once, and leave the API key field empty in Ariadne's
  Settings. Flat monthly fee; no per-token charges. Only supported with the
  default Claude-backed chat agent.

- **Anthropic API key** — paste it into Settings → AI & Backends. Pay-per-
  token billing via `console.anthropic.com`. Required if you use the direct-
  API backend or any of the one-shot features (Tailor Resume, Fetch JD, etc.)
  without a Pro/Max subscription.

**Free tier:** there isn't one for Claude Code CLI. Pro/Max or API key is the
floor.

## Multi-vendor chat (experimental)

The chat layer speaks ACP, so you can swap in a different vendor's agent:

- **Claude** (default) — `@zed-industries/claude-code-acp`, full feature set
- **Gemini** — `@google/gemini-cli --experimental-acp`
- **Codex / GPT** — `@zed-industries/codex-acp`
- **Custom** — any command that speaks ACP on stdio

Change it in Settings → AI & Backends → ACP Agent.

**One caveat:** the one-shot features (Tailor Resume auto-run, Fetch JD from
URL, smart chat-title generation, auto-analyze on JD save, AI Search's
Set Up pipeline) are Anthropic-specific today — they hit the Anthropic API
directly or shell out to the Claude CLI. When you pick a non-Claude agent,
those UI affordances are hidden. Chat itself works with any vendor.

This will unify once the direct-API path is retired (dev plan in
[docs/ACP-MIGRATION.md](docs/ACP-MIGRATION.md)).

## Architecture

See [docs/ACP-MIGRATION.md](docs/ACP-MIGRATION.md) for the design doc
covering the Agent Client Protocol migration, and
[docs/UI-UX-RESEARCH.md](docs/UI-UX-RESEARCH.md) for the competitor
analysis that drives the UI choices.

## License

Open source. License file TBD.
