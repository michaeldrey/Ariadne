//! Detection + one-shot install of `claude-code-acp` globally.
//!
//! The ACP runtime prefers a globally-installed binary over `npx -y @latest`
//! because npx checks the npm registry for the latest tag on every launch,
//! which adds ~1–30s to every cold app start. A global install sidesteps
//! that entirely.

use serde::Serialize;
use tokio::process::Command;

const PKG: &str = "@zed-industries/claude-code-acp";
const BIN: &str = "claude-code-acp";

#[derive(Debug, Clone, Serialize)]
pub struct InstallStatus {
    pub installed: bool,
    /// Absolute path to the binary if found on PATH.
    pub path: Option<String>,
    /// Resolved version string if a binary was found and responded to
    /// `--version`. None means either not installed or install is too old
    /// to support `--version`.
    pub version: Option<String>,
    /// Whether `npm` itself is on PATH. If false, the install button
    /// can't do anything — user needs to install Node.js first.
    pub npm_available: bool,
}

#[tauri::command]
pub async fn detect_acp_install() -> Result<InstallStatus, String> {
    let npm_available = Command::new("npm")
        .arg("--version")
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false);

    let which = Command::new("which")
        .arg(BIN)
        .output()
        .await
        .map_err(|e| format!("which: {}", e))?;

    if !which.status.success() {
        return Ok(InstallStatus {
            installed: false,
            path: None,
            version: None,
            npm_available,
        });
    }

    let path = String::from_utf8_lossy(&which.stdout).trim().to_string();

    let version = Command::new(&path)
        .arg("--version")
        .output()
        .await
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());

    Ok(InstallStatus {
        installed: !path.is_empty(),
        path: if path.is_empty() { None } else { Some(path) },
        version,
        npm_available,
    })
}

/// Detect whether the user has the Claude Code CLI (`claude` binary) on
/// PATH — needed for Claude Pro/Max subscription auth. Doesn't verify login
/// state; that lives in the macOS Keychain and isn't cheap to check from
/// Rust. If the subprocess spawn later fails, the error bubbles up clearly.
#[tauri::command]
pub async fn detect_claude_cli() -> Result<InstallStatus, String> {
    let which = Command::new("which")
        .arg("claude")
        .output()
        .await
        .map_err(|e| format!("which: {}", e))?;

    if !which.status.success() {
        return Ok(InstallStatus {
            installed: false,
            path: None,
            version: None,
            npm_available: true, // irrelevant for this check
        });
    }

    let path = String::from_utf8_lossy(&which.stdout).trim().to_string();
    let version = Command::new(&path)
        .arg("--version")
        .output()
        .await
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());

    Ok(InstallStatus {
        installed: !path.is_empty(),
        path: if path.is_empty() { None } else { Some(path) },
        version,
        npm_available: true,
    })
}

/// Install `@zed-industries/claude-code-acp` globally. Returns combined
/// stdout+stderr on success so the UI can display the install log.
#[tauri::command]
pub async fn install_acp() -> Result<String, String> {
    let output = Command::new("npm")
        .args(["install", "-g", PKG])
        .output()
        .await
        .map_err(|e| format!("spawning npm: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{}\n{}", stdout, stderr);

    if output.status.success() {
        Ok(combined)
    } else {
        Err(format!(
            "npm install -g {} failed ({}): {}",
            PKG, output.status, combined
        ))
    }
}
