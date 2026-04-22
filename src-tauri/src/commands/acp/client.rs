//! ACP client spike (step 3, part 1).
//!
//! Minimal probe that spawns the Zed-maintained `claude-code-acp` adapter
//! (`npx -y @zed-industries/claude-code-acp@latest`), performs the ACP
//! `initialize` handshake, and returns the agent's advertised capabilities
//! as JSON. No session creation, no MCP server wiring — that's the next
//! spike once we've confirmed which MCP transports the agent accepts.
//!
//! The capability we care about most is `agent_capabilities.mcp_capabilities`
//! — it tells us whether the agent will accept `http`, `sse`, or only
//! `stdio` MCP servers. All agents MUST support stdio per spec; http/sse
//! are gated on this advertisement.

use agent_client_protocol::{
    Client,
    schema::{InitializeRequest, ProtocolVersion},
};
use agent_client_protocol_tokio::AcpAgent;
use serde_json::json;

/// Spawn `claude-code-acp`, initialize, and return its capabilities as a
/// JSON string. Called from the dev console via `invoke('acp_spike_probe')`.
/// The subprocess is killed when this function returns.
#[tauri::command]
pub async fn acp_spike_probe() -> Result<String, String> {
    let agent = AcpAgent::zed_claude_code().with_debug(|line, direction| {
        eprintln!("[acp {:?}] {}", direction, line);
    });

    let result = Client
        .builder()
        .name("ariadne-spike")
        .connect_with(agent, async |connection| {
            let init = connection
                .send_request(InitializeRequest::new(ProtocolVersion::V1))
                .block_task()
                .await?;

            let payload = json!({
                "protocol_version": format!("{:?}", init.protocol_version),
                "agent_info": format!("{:?}", init.agent_info),
                "agent_capabilities": {
                    "load_session": init.agent_capabilities.load_session,
                    "prompt_capabilities": format!("{:?}", init.agent_capabilities.prompt_capabilities),
                    "mcp_capabilities": format!("{:?}", init.agent_capabilities.mcp_capabilities),
                    "session_capabilities": format!("{:?}", init.agent_capabilities.session_capabilities),
                },
            });

            Ok(payload.to_string())
        })
        .await
        .map_err(|e| format!("acp probe failed: {}", e))?;

    Ok(result)
}
