//! rmcp-backed tool implementations exposed to the ACP agent.
//!
//! Step 2 will port the 9 existing tools (update_stage, update_notes,
//! update_next_action, update_fit_score, save_artifact, create_task,
//! save_work_stories, update_search_criteria, update_profile_about) here
//! using `#[tool_router]` / `#[tool]` / `#[tool_handler]` macros.
//!
//! The server will be exposed over HTTP on 127.0.0.1 with a per-run bearer
//! token for local-only trust.
