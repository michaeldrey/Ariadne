//! In-process HTTP MCP server.
//!
//! Stands up an rmcp `StreamableHttpService` on `127.0.0.1:0` (random free
//! port), serving the 9 tools defined in [`super::tools::AriadneTools`].
//! Each conversation gets its own bound server scoped to that conversation's
//! `(scope, conversation_id)`, so tool calls mutate the right row.
//!
//! The server is gated by a per-run bearer token and listens only on
//! loopback (`allowed_hosts = ["127.0.0.1", "localhost", "::1"]` — rmcp
//! enforces the `Host` check internally to prevent DNS rebinding).

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
use std::sync::Arc;
use tauri::AppHandle;
use tokio_util::sync::CancellationToken;

use super::tools::{AriadneTools, Scope};

/// Stand up an MCP server for a single (scope, conversation_id) context.
/// Returns (url, bearer_token, cancel_token). Drop the cancel_token or call
/// `.cancel()` to shut the server down.
pub async fn spawn_mcp_server(
    db: Database,
    scope: Scope,
    conversation_id: i64,
    app: AppHandle,
) -> Result<(String, String, CancellationToken), String> {
    let token = nanoid::nanoid!(32);
    let cancel = CancellationToken::new();

    let factory_db = db.clone();
    let factory_scope = scope.clone();
    let factory_app = app.clone();
    let service = StreamableHttpService::new(
        move || Ok(AriadneTools::new(factory_db.clone(), factory_scope.clone(), conversation_id, factory_app.clone())),
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
