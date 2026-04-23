use crate::db::Database;
use crate::models::*;
use rusqlite::params;
use std::process::Stdio;
use std::time::Duration;
use tauri::State;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

const CLAUDE_MODEL: &str = "claude-sonnet-4-6";
const HAIKU_MODEL: &str = "claude-haiku-4-5-20251001";
const API_URL: &str = "https://api.anthropic.com/v1/messages";
const FETCH_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_HTML_BYTES: usize = 400_000;

/// Which model the one-shot caller wants. Translates to Anthropic model IDs
/// (for API-key mode) or CLI model aliases (for subscription mode).
#[derive(Debug, Clone, Copy)]
pub enum ModelTier {
    Fast,    // Haiku
    Standard, // Sonnet
}

/// Run a one-shot prompt against Claude using the best available auth:
///   - If the user has an Anthropic API key saved, use it (pay-per-token).
///   - Otherwise, shell out to the Claude Code CLI (`claude -p`) using the
///     user's Pro/Max subscription credentials.
///
/// Returns just the assistant's text response, trimmed.
pub async fn claude_oneshot(
    db: &Database,
    prompt: String,
    tier: ModelTier,
    max_tokens: u32,
) -> Result<String, String> {
    // API key wins if present.
    let api_key = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        conn.query_row("SELECT anthropic_api_key FROM settings WHERE id = 1", [], |r| {
            r.get::<_, Option<String>>(0)
        })
        .map_err(|e| e.to_string())?
        .filter(|k| !k.trim().is_empty())
    };

    if let Some(key) = api_key {
        return call_anthropic_api(&key, prompt, tier, max_tokens).await;
    }

    // Fall back to Claude Code CLI for subscription auth.
    call_claude_cli(prompt, tier).await
}

async fn call_anthropic_api(
    api_key: &str,
    prompt: String,
    tier: ModelTier,
    max_tokens: u32,
) -> Result<String, String> {
    let model = match tier {
        ModelTier::Fast => HAIKU_MODEL,
        ModelTier::Standard => CLAUDE_MODEL,
    };
    let body = serde_json::json!({
        "model": model,
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": prompt}]
    });
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(API_URL)
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("API request failed: {}", e))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Claude API error ({}): {}", status, text));
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    json["content"][0]["text"]
        .as_str()
        .ok_or_else(|| "Unexpected API response format".to_string())
        .map(|s| s.trim().to_string())
}

async fn call_claude_cli(prompt: String, tier: ModelTier) -> Result<String, String> {
    // Resolve absolute path — bundled macOS apps have a minimal PATH so
    // `claude` isn't findable via a naive PATH lookup. The resolver falls
    // back to Homebrew / npm-global / Volta prefixes.
    let path = crate::commands::acp::install::resolve_cli("claude")
        .await
        .ok_or_else(|| {
            "No API key configured and the Claude Code CLI (`claude`) isn't on PATH. Set an API key in Settings or install the Claude Code CLI."
                .to_string()
        })?;

    let model_alias = match tier {
        ModelTier::Fast => "haiku",
        ModelTier::Standard => "sonnet",
    };

    let mut child = Command::new(&path)
        .args(["-p", "--model", model_alias])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn claude: {}", e))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(prompt.as_bytes())
            .await
            .map_err(|e| format!("write stdin: {}", e))?;
        drop(stdin); // signal EOF
    }

    let output = child
        .wait_with_output()
        .await
        .map_err(|e| format!("wait claude: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "Claude CLI failed ({}): {}. Run `claude /login` in a terminal if credentials are missing.",
            output.status, stderr.trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Generate a 4-7 word chat-thread title from the user's first message.
/// Haiku-backed — cheap and fast so the picker updates within a second
/// or two of sending. Returns a plain string with no quotes or trailing
/// punctuation.
#[tauri::command]
pub async fn summarize_for_title(
    db: State<'_, Database>,
    text: String,
) -> Result<String, String> {
    let prompt = format!(
        "Write a 4-7 word title for a chat thread that starts with this message. \
         No quotes, no trailing period, Title Case. Reply with ONLY the title text.\n\n{}",
        text
    );
    let title = claude_oneshot(&db, prompt, ModelTier::Fast, 30)
        .await?
        .trim_matches('"')
        .trim_end_matches('.')
        .trim()
        .to_string();

    if title.is_empty() {
        return Err("Claude returned an empty title".to_string());
    }
    Ok(title)
}

/// Fetch a job posting URL and use Claude to extract just the JD text,
/// discarding nav/footer/cookies/etc. Best-effort — works well on static
/// ATSes (Greenhouse, Lever, Ashby) and plain company career pages; fails
/// on JS-rendered SPAs (Workday, LinkedIn, Indeed) where the initial HTML
/// has no content to begin with.
#[tauri::command]
pub async fn fetch_jd_from_url(
    db: State<'_, Database>,
    url: String,
) -> Result<String, String> {
    // Polite-but-realistic UA; some boards 403 clearly-bot requests.
    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .user_agent("Mozilla/5.0 (Macintosh; Ariadne Job Tracker) AppleWebKit/605.1.15")
        .build()
        .map_err(|e| format!("build client: {}", e))?;

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("fetch failed: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!(
            "URL returned {}. This job board may require login or JavaScript.",
            resp.status()
        ));
    }
    let html = resp
        .text()
        .await
        .map_err(|e| format!("read body: {}", e))?;

    // Strip tags to keep the Claude prompt small. Regex is imprecise but fine
    // for extraction — Claude is robust to messy text.
    let cleaned = strip_html(&html);
    if cleaned.trim().len() < 200 {
        return Err(
            "Fetched page has almost no text. Likely a JavaScript-rendered board (Workday, LinkedIn, Indeed). Paste the JD manually.".to_string(),
        );
    }
    let cleaned = truncate_chars(&cleaned, MAX_HTML_BYTES);

    let prompt = format!(
        r#"You are extracting a job description from a webpage. The page may contain a lot of navigation, cookie notices, and boilerplate around the actual JD.

Return ONLY the job description text, in clean markdown:
- Role title as an H2 heading if it's clearly identifiable
- Preserve bullet lists for requirements / responsibilities
- Drop: navigation links, "About the company" boilerplate that's not specific to the role, cookie/privacy banners, footers, application form fields
- If the page doesn't appear to be a job posting at all, reply with exactly: NOT_A_JOB_POSTING

## Page content
{cleaned}
"#
    );

    let text = claude_oneshot(&db, prompt, ModelTier::Standard, 4096).await?;
    if text == "NOT_A_JOB_POSTING" {
        return Err("This page doesn't look like a job posting. Check the URL.".to_string());
    }
    Ok(text)
}

fn strip_html(html: &str) -> String {
    // Drop <script> and <style> blocks wholesale, then every remaining tag.
    let mut s = html.to_string();
    for tag in ["script", "style", "noscript", "svg"] {
        let open = format!("<{}", tag);
        while let Some(start) = s.to_ascii_lowercase().find(&open) {
            let close = format!("</{}>", tag);
            if let Some(end_rel) = s[start..].to_ascii_lowercase().find(&close) {
                let end = start + end_rel + close.len();
                s.replace_range(start..end, "");
            } else {
                break;
            }
        }
    }
    // Remove all remaining tags.
    let without_tags: String = {
        let mut out = String::with_capacity(s.len());
        let mut in_tag = false;
        for ch in s.chars() {
            match ch {
                '<' => in_tag = true,
                '>' => in_tag = false,
                _ if !in_tag => out.push(ch),
                _ => {}
            }
        }
        out
    };
    // Collapse whitespace.
    without_tags
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        let mut end = max;
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        s[..end].to_string()
    }
}

#[tauri::command]
pub async fn tailor_resume(db: State<'_, Database>, role_id: String) -> Result<TailorResult, String> {
    let (resume_content, work_stories, jd_content, company, title) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let resume: Option<String> = conn
            .query_row("SELECT resume_content FROM settings WHERE id = 1", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        let stories: Option<String> = conn
            .query_row("SELECT work_stories FROM settings WHERE id = 1", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        let (jd, comp, ttl): (Option<String>, String, String) = conn
            .query_row(
                "SELECT jd_content, company, title FROM roles WHERE id = ?1",
                params![role_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(|e| e.to_string())?;
        (resume, stories, jd, comp, ttl)
    };

    let resume = resume_content.ok_or("No resume content. Add your resume in Settings.")?;
    let jd = jd_content.ok_or("No JD content for this role. Add the job description first.")?;

    let stories_section = work_stories
        .map(|s| format!("\n\n## Work Stories / STAR Examples\n{}", s))
        .unwrap_or_default();

    let prompt = format!(
        r#"You are a resume tailoring expert. Given a job description and a candidate's resume, produce:
1. A tailored resume in markdown (reorder bullets, inject keywords, optimize for ATS)
2. A fit analysis with scores

## Job Description ({company} - {title})
{jd}

## Candidate Resume
{resume}{stories_section}

---

Respond in EXACTLY this format:

---RESUME---
(the tailored resume in markdown)
---ANALYSIS---
(fit analysis with these sections:)
## Fit Scores
- Strategic Fit: X/100
- Technical Fit: X/100
- Leadership Fit: X/100
- ATS Compatibility: X/100
- **Overall: X/100**

## Strengths
(bullet points)

## Gaps / Risks
(bullet points)

## Changes Made
(bullet list of what was modified and why)

## Interview Prep Notes
(likely questions based on gaps)"#
    );

    let text = claude_oneshot(&db, prompt, ModelTier::Standard, 4096).await?;

    // Parse response
    let (resume_draft, analysis) = if let Some(idx) = text.find("---ANALYSIS---") {
        let resume_part = text[..idx].replace("---RESUME---", "").trim().to_string();
        let analysis_part = text[idx..].replace("---ANALYSIS---", "").trim().to_string();
        (resume_part, analysis_part)
    } else {
        (text.clone(), String::new())
    };

    let fit_score = extract_overall_score(&analysis);

    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        conn.execute(
            "UPDATE roles SET resume_draft = ?1, comparison_analysis = ?2, fit_score = ?3, updated_date = ?4 WHERE id = ?5",
            params![resume_draft, analysis, fit_score, today, role_id],
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(TailorResult { resume_draft, analysis, fit_score })
}

#[tauri::command]
pub async fn generate_research(db: State<'_, Database>, role_id: String) -> Result<ResearchResult, String> {
    let (jd_content, company, title, notes) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let (jd, comp, ttl, n): (Option<String>, String, String, Option<String>) = conn
            .query_row(
                "SELECT jd_content, company, title, notes FROM roles WHERE id = ?1",
                params![role_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .map_err(|e| e.to_string())?;
        (jd, comp, ttl, n)
    };

    let jd = jd_content.ok_or("No JD content for this role.")?;

    let notes_section = notes
        .map(|n| format!("\n\nCandidate Notes:\n{}", n))
        .unwrap_or_default();

    let prompt = format!(
        r#"Generate a comprehensive interview research packet for this role:

Company: {company}
Role: {title}

Job Description:
{jd}{notes_section}

Please include:

## Company Overview
- Mission, products, recent news, funding/financials
- Engineering culture and tech blog highlights

## Role Analysis
- Key responsibilities and what they're really looking for
- Red flags or concerns from the JD

## Likely Interview Questions
### Technical
- 5-7 likely technical questions based on the JD

### Behavioral
- 5-7 behavioral/situational questions

### System Design
- 2-3 likely system design topics

## Questions to Ask
- 5-7 thoughtful questions for the interviewer

## Quick Reference Card
A condensed 10-line cheat sheet for interview day"#
    );

    let research_packet = claude_oneshot(&db, prompt, ModelTier::Standard, 4096).await?;

    // Save to database
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        conn.execute(
            "UPDATE roles SET research_packet = ?1, updated_date = ?2 WHERE id = ?3",
            params![research_packet, today, role_id],
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(ResearchResult { research_packet })
}

#[derive(Debug, serde::Serialize)]
pub struct GenerateStoriesResult {
    pub work_stories: String,
    pub count: i32,
}

#[tauri::command]
pub async fn generate_work_stories(
    db: State<'_, Database>,
) -> Result<GenerateStoriesResult, String> {
    let (resume_content, profile_name) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let resume: Option<String> = conn
            .query_row("SELECT resume_content FROM settings WHERE id = 1", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        let name: Option<String> = conn
            .query_row("SELECT profile_name FROM settings WHERE id = 1", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        (resume, name)
    };

    let resume = resume_content.ok_or("No master resume. Add it on the Profile page first.")?;

    let name_bit = profile_name
        .map(|n| format!("The candidate is {}.\n", n))
        .unwrap_or_default();

    let prompt = format!(
        r#"You are a senior interview coach. From the candidate's resume below, extract 6–10 distinct STAR-format interview stories covering a diverse range of situations (technical wins, leadership/influence, conflict, ambiguity, failure-and-learning, cross-functional collaboration). Pick the most concrete, high-impact moments.

{name_bit}
## Resume
{resume}

## Output
Respond with ONLY the stories, in this exact markdown format. No preamble, no commentary.

## Short Story Title 1

**Situation:** 2–3 sentences setting the scene. Company/context, scope, stakeholders.

**Task:** 1–2 sentences — what you were responsible for, the outcome you needed.

**Action:** 4–8 bullets — specific things YOU did. Use "I" not "we." Technical and non-technical actions.

**Result:** 2–4 bullets — quantified outcomes where possible. Promotions, adoption numbers, latency/cost wins, team growth.

## Short Story Title 2

...
"#
    );

    let work_stories = claude_oneshot(&db, prompt, ModelTier::Standard, 4096)
        .await?
        .trim()
        .to_string();

    // Count stories by `## ` headers.
    let count = work_stories
        .lines()
        .filter(|l| l.starts_with("## "))
        .count() as i32;

    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE settings SET work_stories = ?1, updated_at = datetime('now') WHERE id = 1",
            params![work_stories],
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(GenerateStoriesResult { work_stories, count })
}

fn extract_overall_score(analysis: &str) -> Option<i32> {
    // Look for "Overall: X/100" pattern
    for line in analysis.lines() {
        if line.contains("Overall") && line.contains("/100") {
            let parts: Vec<&str> = line.split(|c: char| !c.is_numeric()).collect();
            for part in parts {
                if let Ok(n) = part.parse::<i32>() {
                    if (0..=100).contains(&n) {
                        return Some(n);
                    }
                }
            }
        }
    }
    None
}
