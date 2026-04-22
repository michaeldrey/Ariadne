//! In-process HTTP MCP server (step 3 spike, part 2).
//!
//! Stands up an rmcp `StreamableHttpService` on `127.0.0.1:0` (random free
//! port), serving the 9 tools defined in [`super::tools::AriadneTools`].
//! The server is gated by a per-run bearer token and listens only on
//! loopback (`allowed_hosts = ["127.0.0.1", "localhost", "::1"]` — rmcp
//! enforces the `Host` check internally to prevent DNS rebinding).
//!
//! Usage for the spike (devtools console):
//!
//! ```js
//! const info = JSON.parse(await window.__TAURI__.core.invoke('acp_mcp_server_spike'));
//! // info = { url: "http://127.0.0.1:NNNNN/mcp", token: "..." }
//! ```
//!
//! Then from a terminal, list the tools:
//!
//! ```sh
//! curl -s -X POST "$URL" \
//!   -H "Authorization: Bearer $TOKEN" \
//!   -H "Content-Type: application/json" \
//!   -H "Accept: application/json, text/event-stream" \
//!   -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"0.1"}}}'
//! # grab the Mcp-Session-Id header from the response, then:
//! curl -s -X POST "$URL" \
//!   -H "Authorization: Bearer $TOKEN" \
//!   -H "Mcp-Session-Id: <id>" \
//!   -H "Content-Type: application/json" \
//!   -H "Accept: application/json, text/event-stream" \
//!   -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
//! ```

use crate::db::Database;
use axum::{
    extract::Request,
    http::{StatusCode, header::AUTHORIZATION},
    middleware::{self, Next},
    response::Response,
};
use rmcp::transport::streamable_http_server::{
    StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
};
use serde_json::json;
use std::sync::Arc;
use tauri::State;
use tokio_util::sync::CancellationToken;

use super::tools::{AriadneTools, Scope};

/// Stand up an MCP server for a single (scope, conversation_id) context.
/// Returns (url, bearer_token, cancel_token). Drop the cancel_token's guard
/// or call `.cancel()` to shut the server down.
pub async fn spawn_mcp_server(
    db: Database,
    scope: Scope,
    conversation_id: i64,
) -> Result<(String, String, CancellationToken), String> {
    let token = nanoid::nanoid!(32);
    let cancel = CancellationToken::new();

    let factory_db = db.clone();
    let factory_scope = scope.clone();
    let service = StreamableHttpService::new(
        move || Ok(AriadneTools::new(factory_db.clone(), factory_scope.clone(), conversation_id)),
        Arc::new(LocalSessionManager::default()),
        StreamableHttpServerConfig::default().with_cancellation_token(cancel.child_token()),
    );

    let router = axum::Router::new()
        .nest_service("/mcp", service)
        .layer(middleware::from_fn_with_state(
            Arc::new(token.clone()),
            bearer_auth,
        ));

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("bind failed: {}", e))?;
    let addr = listener.local_addr().map_err(|e| e.to_string())?;

    let serve_cancel = cancel.clone();
    tokio::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async move { serve_cancel.cancelled_owned().await })
            .await;
    });

    let url = format!("http://{}/mcp", addr);
    Ok((url, token, cancel))
}

async fn bearer_auth(
    axum::extract::State(expected): axum::extract::State<Arc<String>>,
    req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let header = req
        .headers()
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let presented = header
        .strip_prefix("Bearer ")
        .ok_or(StatusCode::UNAUTHORIZED)?;
    if presented != expected.as_str() {
        return Err(StatusCode::UNAUTHORIZED);
    }
    Ok(next.run(req).await)
}

/// Spike command: spawn an MCP server with Scope::Profile and return its URL
/// + bearer token as JSON. The server is never cancelled — it runs until the
/// app exits. OK for a one-off probe; real integration (step 4) will tie
/// lifetime to an ACP session.
#[tauri::command]
pub async fn acp_mcp_server_spike(db: State<'_, Database>) -> Result<String, String> {
    let (url, token, _cancel) = spawn_mcp_server((*db).clone(), Scope::Profile, 0).await?;
    // Intentionally drop (leak) the cancel token so the server keeps running.
    std::mem::forget(_cancel);
    Ok(json!({ "url": url, "token": token }).to_string())
}
