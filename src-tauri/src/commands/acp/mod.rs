//! Agent Client Protocol (ACP) integration.
//!
//! Ariadne acts as an ACP **client**, spawning an external agent binary
//! (default: `claude-agent-acp`) as a subprocess over stdio. Our own tools
//! (update_stage, save_artifact, etc.) are exposed to the agent via an
//! in-process HTTP MCP server bound to 127.0.0.1 — the agent is told about
//! it at `session/new` through `NewSessionRequest.mcp_servers`.
//!
//! Build order (see docs/ACP-MIGRATION.md):
//!   1. Crates + stub (this commit)
//!   2. Port tools to rmcp #[tool] macros
//!   3. Spawn agent subprocess + first-run install detection
//!   4. Parallel `run_turn_for_conversation_acp` behind a setting
//!   5. Settings UI toggle for backend
//!   6. Cache-hit logging
//!   7. Delete direct-API path (2 weeks dogfood soak first)

pub mod client;
pub mod tools;
