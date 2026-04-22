use crate::db::Database;
use crate::models::*;
use rusqlite::params;
use tauri::State;

const CLAUDE_MODEL: &str = "claude-sonnet-4-20250514";
const API_URL: &str = "https://api.anthropic.com/v1/messages";

#[tauri::command]
pub async fn tailor_resume(db: State<'_, Database>, role_id: String) -> Result<TailorResult, String> {
    let (api_key, resume_content, work_stories, jd_content, company, title) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let key: Option<String> = conn
            .query_row("SELECT anthropic_api_key FROM settings WHERE id = 1", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
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
        (key, resume, stories, jd, comp, ttl)
    };

    let api_key = api_key.ok_or("No Anthropic API key configured. Add one in Settings.")?;
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

    let body = serde_json::json!({
        "model": CLAUDE_MODEL,
        "max_tokens": 4096,
        "messages": [{"role": "user", "content": prompt}]
    });

    let client = reqwest::Client::new();
    let resp = client
        .post(API_URL)
        .header("x-api-key", &api_key)
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
    let text = json["content"][0]["text"]
        .as_str()
        .ok_or("Unexpected API response format")?
        .to_string();

    // Parse response
    let (resume_draft, analysis) = if let Some(idx) = text.find("---ANALYSIS---") {
        let resume_part = text[..idx].replace("---RESUME---", "").trim().to_string();
        let analysis_part = text[idx..].replace("---ANALYSIS---", "").trim().to_string();
        (resume_part, analysis_part)
    } else {
        (text.clone(), String::new())
    };

    // Extract fit score
    let fit_score = extract_overall_score(&analysis);

    // Save to database
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        conn.execute(
            "UPDATE roles SET resume_draft = ?1, comparison_analysis = ?2, fit_score = ?3, updated_date = ?4 WHERE id = ?5",
            params![resume_draft, analysis, fit_score, today, role_id],
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(TailorResult {
        resume_draft,
        analysis,
        fit_score,
    })
}

#[tauri::command]
pub async fn generate_research(db: State<'_, Database>, role_id: String) -> Result<ResearchResult, String> {
    let (api_key, jd_content, company, title, notes) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let key: Option<String> = conn
            .query_row("SELECT anthropic_api_key FROM settings WHERE id = 1", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        let (jd, comp, ttl, n): (Option<String>, String, String, Option<String>) = conn
            .query_row(
                "SELECT jd_content, company, title, notes FROM roles WHERE id = ?1",
                params![role_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .map_err(|e| e.to_string())?;
        (key, jd, comp, ttl, n)
    };

    let api_key = api_key.ok_or("No Anthropic API key configured. Add one in Settings.")?;
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

    let body = serde_json::json!({
        "model": CLAUDE_MODEL,
        "max_tokens": 4096,
        "messages": [{"role": "user", "content": prompt}]
    });

    let client = reqwest::Client::new();
    let resp = client
        .post(API_URL)
        .header("x-api-key", &api_key)
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
    let research_packet = json["content"][0]["text"]
        .as_str()
        .ok_or("Unexpected API response format")?
        .to_string();

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
