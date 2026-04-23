//! Detection + one-shot install of `claude-code-acp` globally.
//!
//! The ACP runtime prefers a globally-installed binary over `npx -y @latest`
//! because npx checks the npm registry for the latest tag on every launch,
//! which adds ~1–30s to every cold app start. A global install sidesteps
//! that entirely.

use serde::Serialize;
use std::path::PathBuf;
use tokio::process::Command;

const PKG: &str = "@zed-industries/claude-code-acp";
const BIN: &str = "claude-code-acp";

/// Resolve a CLI binary by name. Bundled macOS apps (.app) launch with a
/// stripped PATH (often just /usr/bin:/bin), so tools installed in the
/// user's normal Homebrew / npm-global locations aren't found by a plain
/// \`which\`. Tries common install prefixes explicitly as a fallback.
pub(crate) async fn resolve_cli(name: &str) -> Option<String> {
    // First: augmented PATH so `which` can find things in the usual places.
    let augmented = extended_path();
    if let Ok(output) = Command::new("/usr/bin/which")
        .arg(name)
        .env("PATH", &augmented)
        .output()
        .await
    {
        if output.status.success() {
            let p = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !p.is_empty() { return Some(p); }
        }
    }
    // Fallback: probe the usual install prefixes directly.
    for prefix in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        let candidate = PathBuf::from(prefix).join(name);
        if candidate.exists() {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }
    // Also check npm-global under $HOME.
    if let Ok(home) = std::env::var("HOME") {
        for rel in [".npm-global/bin", ".volta/bin"] {
            let candidate = PathBuf::from(&home).join(rel).join(name);
            if candidate.exists() {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
    }
    None
}

/// PATH to use when shelling out from a bundled app. Includes Homebrew (ARM
/// and Intel), /usr/local/bin, /usr/bin, /bin, and the user's npm-global +
/// Volta bins under $HOME. Safe to pass as env PATH for subprocess spawns.
pub(crate) fn extended_path() -> String {
    let mut parts = vec![
        "/opt/homebrew/bin".to_string(),
        "/opt/homebrew/sbin".to_string(),
        "/usr/local/bin".to_string(),
        "/usr/local/sbin".to_string(),
        "/usr/bin".to_string(),
        "/bin".to_string(),
        "/usr/sbin".to_string(),
        "/sbin".to_string(),
    ];
    if let Ok(home) = std::env::var("HOME") {
        parts.push(format!("{}/.npm-global/bin", home));
        parts.push(format!("{}/.volta/bin", home));
        parts.push(format!("{}/.local/bin", home));
    }
    if let Ok(existing) = std::env::var("PATH") {
        parts.push(existing);
    }
    parts.join(":")
}

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
    let npm_available = resolve_cli("npm").await.is_some();
    let path = resolve_cli(BIN).await;

    if path.is_none() {
        return Ok(InstallStatus {
            installed: false,
            path: None,
            version: None,
            npm_available,
        });
    }
    let path = path.unwrap();

    let version = Command::new(&path)
        .arg("--version")
        .env("PATH", extended_path())
        .output()
        .await
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());

    Ok(InstallStatus {
        installed: true,
        path: Some(path),
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
    let path = resolve_cli("claude").await;
    if path.is_none() {
        return Ok(InstallStatus {
            installed: false,
            path: None,
            version: None,
            npm_available: true,
        });
    }
    let path = path.unwrap();
    let version = Command::new(&path)
        .arg("--version")
        .env("PATH", extended_path())
        .output()
        .await
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    Ok(InstallStatus {
        installed: true,
        path: Some(path),
        version,
        npm_available: true,
    })
}

/// Install `@zed-industries/claude-code-acp` globally. Returns combined
/// stdout+stderr on success so the UI can display the install log.
#[tauri::command]
pub async fn install_acp() -> Result<String, String> {
    let npm = resolve_cli("npm")
        .await
        .ok_or_else(|| "npm isn't on PATH. Install Node.js and try again.".to_string())?;
    let output = Command::new(&npm)
        .args(["install", "-g", PKG])
        .env("PATH", extended_path())
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
