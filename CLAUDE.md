# Job Search Automation - Claude Code Context

A Claude Code-powered job search management system. Read this file and `data/profile.md` at session start for context.

**Note:** User-specific data (name, background, resume) lives in `data/profile.md` which is gitignored. The public repo is called "Ariadne".

## On Session Start

When the user sends a greeting to start the session:

1. Check if `data/profile.md` exists
2. **If MISSING** → run the First-Run Setup Flow below
3. **If EXISTS** → run the Normal Session Start

### Normal Session Start

1. Read `data/config.json` and check `notion.autoSync`
2. **If `autoSync` is `true`:** kick off `node scripts/notion-sync.js` via Bash with `run_in_background: true` — don't wait for it
3. Respond with:
   - A friendly, cute greeting in return
   - A fun quote of the day (motivational, witty, or job-search relevant)
   - The commands table below
   - Current active roles and their status (read from `data/tracker.json`)
4. After displaying the greeting, check the background sync result:
   - If it finished, show a one-line summary (e.g., "Notion sync: 2 pulled, 3 pushed, 40 unchanged")
   - If it's still running, note "Notion sync running in background..." — no need to block
   - If it errored, show the error briefly (e.g., "Notion sync failed: auth error")

### First-Run Setup Flow

This flow triggers when `data/profile.md` is missing, indicating a new user. Guide them through onboarding.

**Step 0 — Dependency Check**

Run `which` checks for required tools and report status:

| Tool | Check | Required For | Install |
|------|-------|-------------|---------|
| node | `which node` | Dashboard build | nodejs.org |
| npm | `which npm` | Package install | comes with node |
| pandoc | `which pandoc` | Resume PDF generation | `brew install pandoc` |
| weasyprint | `which weasyprint` | Resume PDF generation | `brew install weasyprint` |
| wrangler | `which wrangler` | Dashboard deploy | `npm install -g wrangler` |
| gemini | `which gemini` | Job search fallback | `npm install -g @google/gemini-cli` |

Display results as a checklist:
```
Checking dependencies...
  [x] node (v22.1.0)
  [x] npm (v10.8.0)
  [ ] pandoc — needed for PDF generation (brew install pandoc)
  [ ] weasyprint — needed for PDF generation (brew install weasyprint)
  [x] wrangler (v3.78.0)
```

- Missing tools: show install command, note which features won't work without them
- Do NOT block setup — continue regardless, user can install later
- If `npm` found but `node_modules/` missing in the project root, run `npm install` (the `marked` package is needed for dashboard builds)

**Step 1 — Resume Collection**

Ask the user using AskUserQuestion:
- **Paste resume text** — save to scratchpad dir as `resume-input.txt`
- **Provide file path** — validate it exists (handle PDF, DOCX, MD)
- **Skip** — proceed without resume analysis

**Step 2 — Launch Background Agent**

If user provided a resume (text or file path):
- Spawn the `resume-analyzer` agent via Task tool with `run_in_background: true`
- Pass resume content or file path in the prompt
- Continue immediately to Step 3 (don't wait)

If user skipped, set a flag to skip pre-filling in Steps 5-6.

**Step 3 — Identity (while agent runs)**

Collect from the user:
- **Full name** — used in profile.md and resume PDF filename
- **Resume PDF filename** — suggest `[Name] Resume.pdf`, let them customize

These are quick and don't depend on resume analysis.

**Step 4 — Read Agent Results**

If a background agent was launched in Step 2:
- Check background agent output via TaskOutput (block briefly)
- If not ready, wait and check again (up to ~30 seconds)
- Parse the JSON from the agent's response
- If timeout or failure, proceed with empty suggestions (manual entry)

**Step 5 — Profile (pre-filled from agent)**

Present the agent's inferred values and ask the user to accept, edit, or replace:
- **Target roles** — e.g., "Developer Experience", "Platform Engineering"
- **Background summary** — 2-3 sentence career arc
- **Recent experience** — company, title, highlights

If no agent results, ask the user to fill these in manually.

Write `data/profile.md` using the template from `data.example/profile.md`, populated with collected values.

**Step 6 — Search Criteria (pre-filled from agent)**

Present the agent's inferred values section by section:
- **Companies** (3 tiers) — user reviews and adjusts
- **Role levels** — e.g., Senior, Staff, Director
- **Location** — preference + keywords
- **Compensation target** — range and notes
- **Technical domains** — best fit + adjacent
- **Background summary for criteria** — strengths and gaps

If no agent results, ask the user to fill these in manually or accept the template defaults.

Write `data/search-criteria.md` using the template from `data.example/search-criteria.md`, populated with collected values.

**Step 7 — Job Search Backend Config**

1. Ask using AskUserQuestion: "Do you have JobBot API credentials (endpoint + API key)?"
   - If yes → collect endpoint URL + API key, set `searchBackend: "jobbot"` in config.json
2. If no/skip → check if `gemini` CLI was found in Step 0
   - If found → ask: "Gemini CLI is installed. Want to use it as your search backend?"
   - If yes → set `searchBackend: "gemini"` in config.json
3. If neither → set `searchBackend: null`, note that job search can be configured later

Write `data/config.json` with the appropriate values.

**Step 8 — Initialize data/ directory**

Create the directory structure and write files:

```bash
mkdir -p data/InProgress data/Applied data/Rejected data/search-results
```

Write populated files from collected answers + accepted pre-fills:
- `data/profile.md` (from Step 5)
- `data/search-criteria.md` (from Step 6)
- `data/config.json` (from Step 7)
- `data/resume-content.md` — if user provided resume text, use it; otherwise copy template from `data.example/`

Copy templates for files user will populate later:
- `data/tracker.json` — empty structure: `{"active": [], "skipped": [], "closed": []}`
- `data/network.json` — empty structure: `{"contacts": []}`
- `data/tasks.json` — empty structure: `{"tasks": []}`
- `data/work-stories.md` — copy template from `data.example/`

**Important:** If `data/` already exists but `profile.md` is missing (partial setup), preserve any existing tracker.json, network.json, and tasks.json — only write files that don't already exist.

**Step 9 — Welcome + Optional Enhancements**

- Confirm setup complete, list all created files
- If any dependencies were missing in Step 0, remind the user with install commands
- Show the normal commands table (from the table below)
- Show a fun quote of the day
- Note: `work-stories.md` is a template — user populates with their interview stories later
- Show brief "Optional Enhancements" section:
  ```
  Optional enhancements you can set up later:
  - Chrome Extension — Extract job descriptions directly from open browser tabs
  - Firecrawl MCP — Fetch and parse job posting URLs automatically
  - Cloudflare Pages — Deploy your status dashboard for access from any device
  - Notion Sync — Bidirectional sync of jobs, contacts, and tasks to Notion (see docs/notion-sync.md)
  ```

**Edge cases:**
- `data/` exists but `profile.md` missing → partial setup, preserve existing tracker/network/tasks
- Resume analyzer timeout → proceed with manual entry, no pre-fills
- Invalid file path → offer to paste text instead

| Command | Action |
|---------|--------|
| `"Run job search"` | Call JobBot API, save to jobbot-results.json, display roles |
| `"Setup #N"` or `"Setup [Company - Role]"` | Create folder + notes.md + add to data/tracker.json (collects JD URL) |
| `"Skip #N"` or `"Skip #N, #M"` | Add to data/tracker.json skipped array |
| `"Move [Company] to [Status]"` | Update data/tracker.json + move folder (e.g., "Move Stripe to Applied") |
| `"Compare JD and resume for [Company]"` | Cross-reference work-stories.md + resume, produce tailored resume-draft.md + analysis |
| `"Generate PDF for [Company]"` | Generate PDF from resume-draft.md |
| `"Re-compare [Company]"` | Validate improvements against new PDF |
| `"Status"` | Read data/tracker.json and display formatted status |
| `"Reconcile"` | Compare data/tracker.json to folders, report/fix drift |
| `"Open dashboard"` | Build and open status dashboard locally |
| `"Deploy dashboard"` | Build and deploy status page to Cloudflare Pages |
| `"Add contact [Name] at [Company]"` | Add new contact to data/network.json |
| `"Log interaction with [Name]"` | Record interaction (call, email, meeting) with contact |
| `"Add task [description]"` | Create task in tasks.json (optionally link to job/contact) |
| `"Complete task #N"` | Mark task as completed |
| `"Tasks"` | Display pending tasks from tasks.json |
| `"Contacts"` | Display contacts from network.json |
| `"Research packet for [Company]"` | Generate interview research packet (hiring manager, company, culture, story map) |
| `"Sync to Notion"` | Bidirectional incremental sync of jobs, contacts, and tasks to Notion (optional) |

## Quick Reference

**Directory Structure:**
- `/prompts/` - Prompt templates and archived search prompts
- `data/InProgress/` - Active applications being worked on
- `data/Applied/` - Submitted applications
- `data/Rejected/` - Closed opportunities
- `data/search-results/` - Search outputs (jobbot-results.json)
- `/status-page/` - Cloudflare Pages dashboard (build.js, dist/)
- `/.claude/agents/` - Subagent configuration files (`jd-resume-compare.md`, `interview-research.md`, `resume-analyzer.md`)

**Key Files:**
- `data/tracker.json` - Job tracker (source of truth for job status) — see schema below
- `data/network.json` - Contacts and interaction history — see schema below
- `data/tasks.json` - All tasks (networking, prep, research) — see schema below
- `data/resume-content.md` - Master resume in markdown (NEVER modify directly)
- `data/work-stories.md` - Interview stories indexed by theme/keyword (cross-reference during JD comparison)
- `resume.css` - Stylesheet for PDF generation (pandoc + weasyprint)
- `notes-template.md` - Template for role-specific tracking
- `data/config.json` - JobBot API endpoint and key (gitignored)
- `data/.notion-sync-map.json` - Notion sync state (gitignored, auto-generated)
- `data/search-results/jobbot-results.json` - Latest job search output
- `README.md` - Full documentation

## data/tracker.json Schema

**Source of truth** for all role status. Commands maintain this file; Status reads it.

```json
{
  "active": [
    {
      "company": "Stripe",
      "role": "DevEx Lead",
      "stage": "Phone Screen",
      "next": "Prep behavioral stories",
      "url": "https://stripe.com/jobs/123",
      "added": "2026-01-20",
      "updated": "2026-01-24",
      "folder": "data/InProgress/Stripe - DevEx Lead"
    }
  ],
  "skipped": [
    {
      "company": "Meta",
      "role": "IC6 Infra",
      "reason": "IC role, want management",
      "url": "https://meta.com/jobs/789",
      "added": "2026-01-22"
    }
  ],
  "closed": [
    {
      "company": "Databricks",
      "role": "DevEx Manager",
      "outcome": "Rejected",
      "stage": "Onsite",
      "url": "https://databricks.com/jobs/012",
      "added": "2026-01-05",
      "closed": "2026-01-21",
      "folder": "data/Rejected/Databricks - DevEx Manager"
    }
  ]
}
```

**Field definitions:**

| Field | Required | Description |
|-------|----------|-------------|
| company | Yes | Company name (normalize aliases — see Error Handling) |
| role | Yes | Role title |
| stage | Active only | Current stage: Sourced, Applied, Phone Screen, Technical, Onsite, Offer, Negotiating |
| next | Active only | Next action (brief, for dashboard) |
| url | Yes | Job posting URL |
| added | Yes | Date added (YYYY-MM-DD) |
| updated | Active only | Last status change (YYYY-MM-DD) |
| folder | Active/Closed | Path to artifact folder |
| reason | Skipped only | Why skipped |
| outcome | Closed only | How it ended: Rejected, Withdrew, Accepted, Expired |
| closed | Closed only | Date closed (YYYY-MM-DD) |
| stage | Closed (optional) | Furthest stage reached before closing (for metrics) |

## network.json Schema

**Source of truth** for contacts and networking activity.

```json
{
  "contacts": [
    {
      "id": "cole-chandler",
      "name": "Cole Chandler",
      "company": "Oracle",
      "title": "Engineering Manager",
      "email": "cole@example.com",
      "linkedin": "https://linkedin.com/in/colechandler",
      "source": "Former coworker at Zillow",
      "introducedBy": null,
      "added": "2026-01-26",
      "interactions": [
        {
          "date": "2026-01-26",
          "type": "email",
          "summary": "Sent resume for Health AI and OCI roles",
          "linkedJobs": ["Oracle - Sr Director Health AI Platform"]
        }
      ]
    }
  ]
}
```

**Field definitions:**

| Field | Required | Description |
|-------|----------|-------------|
| id | Yes | Kebab-case unique identifier (e.g., "cole-chandler") |
| name | Yes | Display name |
| company | No | Current company (can be null for independent contacts) |
| title | No | Job title |
| email | No | Email address |
| linkedin | No | LinkedIn profile URL |
| source | No | How you know them (e.g., "Former coworker", "Conference") |
| introducedBy | No | Contact ID of person who introduced you |
| added | Yes | Date added (YYYY-MM-DD) |
| interactions | Yes | Array of interaction records |

**Interaction fields:**

| Field | Required | Description |
|-------|----------|-------------|
| date | Yes | Date of interaction (YYYY-MM-DD) |
| type | Yes | One of: `email`, `call`, `message`, `meeting`, `linkedin`, `coffee` |
| summary | Yes | Brief description of the interaction |
| linkedJobs | No | Array of job references (format: "Company - Role") |

## tasks.json Schema

**Source of truth** for all actionable tasks (networking, interview prep, research, applications).

```json
{
  "tasks": [
    {
      "id": "task-001",
      "task": "Follow up with Cole on referral status",
      "due": "2026-01-28",
      "linkedContacts": ["cole-chandler"],
      "linkedJobs": ["Oracle - Sr Director Health AI Platform"],
      "status": "pending",
      "created": "2026-01-26"
    }
  ]
}
```

**Field definitions:**

| Field | Required | Description |
|-------|----------|-------------|
| id | Yes | Unique identifier (e.g., "task-001") |
| task | Yes | Task description (action-oriented) |
| due | No | Due date (YYYY-MM-DD), null if no deadline |
| linkedContacts | No | Array of contact IDs from network.json |
| linkedJobs | No | Array of job references (format: "Company - Role") |
| status | Yes | One of: `pending`, `completed` |
| created | Yes | Date created (YYYY-MM-DD) |
| completed | No | Date completed (YYYY-MM-DD), null if pending |

**Note:** The `next` field in data/tracker.json remains as a quick status indicator for each job. Tasks in tasks.json are granular action items with optional due dates.

## Commands

### Job Search

When user says `"Run job search"`:

**Step 0: Determine search backend**

Read `data/config.json` and check the `searchBackend` field:
- `"jobbot"` (or has jobbot credentials with valid endpoint/apiKey) → use JobBot API (Steps 1-6 below)
- `"gemini"` → use Gemini CLI (see Gemini Search Flow below)
- `null` or missing → tell user: "Job search not configured. Run setup or edit `data/config.json`."

**Step 1: Load search criteria and config**

Read these files:
- `data/search-criteria.md` — Extract target companies, role level keywords, and location keywords
- `data/config.json` — Get JobBot endpoint URL and API key
- `data/tracker.json` — Collect all URLs to exclude (active, skipped, closed)

**Step 2: Build exclusion list**

From `data/tracker.json`, collect URLs from all arrays:
```javascript
excludeUrls = [
  ...tracker.active.map(j => j.url),
  ...tracker.skipped.map(j => j.url),
  ...tracker.closed.map(j => j.url)
]
```

**Step 3: Call JobBot API**

```bash
curl -X POST "${config.jobbot.endpoint}" \
  -H "Content-Type: application/json" \
  -H "x-api-key: ${config.jobbot.apiKey}" \
  -d '{
    "companies": [from search-criteria.md Target Companies],
    "roleLevels": [from search-criteria.md Role Levels],
    "locations": [from search-criteria.md Location Keywords],
    "maxAgeDays": 14,
    "excludeUrls": [from tracker.json all arrays]
  }'
```

**Note:** All search parameters (`companies`, `roleLevels`, `locations`) are extracted from `data/search-criteria.md`. The user's actual criteria file is the single source of truth — do not hardcode values.

**Step 4: Handle response**

The API returns:
```json
{
  "jobs": [
    {
      "id": "greenhouse-anthropic-123",
      "title": "Staff Software Engineer, Infrastructure",
      "company": "Anthropic",
      "location": "SF / NYC / Seattle",
      "url": "https://...",
      "description": "...",
      "postedDate": "2026-01-25",
      "department": "Infrastructure",
      "source": "greenhouse"
    }
  ],
  "meta": {
    "companiesSearched": ["Anthropic", "Stripe"],
    "companiesNotSupported": ["SomeCompany"],
    "totalCollected": 50,
    "afterPreFilter": 20,
    "afterExclusion": 18,
    "afterLocation": 15,
    "errors": []
  }
}
```

**Step 5: Display results**

Show jobs in numbered table format:

| # | Company | Role | Location | Posted | Link |
|---|---------|------|----------|--------|------|
| 1 | Anthropic | Staff Software Engineer, Infrastructure | SF / NYC / Seattle | Jan 25 | [Apply](url) |

Show only NEW roles not found in data/tracker.json. For each result, indicate:
- **NEW** — not in tracker
- **TRACKING** — in active array (show stage)
- **APPLIED** — in active array with stage >= Applied
- **SKIPPED** — in skipped array
- **CLOSED** — in closed array

Include meta summary:
- Searched: X companies
- Not supported: [list if any]
- Found: Y jobs (after filtering)

After displaying, remind user: **Setup #N** to pursue, **Skip #N** to filter out.

**Step 6: Save results**

Write raw API response to `data/search-results/jobbot-results.json` for reference.

**Fallback:** If JobBot API fails (network error, auth failure):
1. Log the error
2. Check if `gemini` CLI is available (`which gemini`)
3. If available, offer: retry JobBot, or fall back to Gemini CLI
4. If not available, offer: retry, or use direct ATS API calls via Bash

**Why JobBot?** It scrapes real ATS APIs (Greenhouse, Lever, Ashby, Workday) directly — no hallucinated job postings. URLs are guaranteed to exist.

#### Gemini Search Flow

When `searchBackend` is `"gemini"` or when falling back from JobBot:

1. Read `prompts/gemini-search-prompt.md`
2. Read `data/search-criteria.md` for current criteria
3. Replace `{{SEARCH_CRITERIA}}` in the prompt template with the search criteria content
4. Run via Gemini CLI:
   ```bash
   echo "$PROMPT" | gemini
   ```
5. Save the output to `data/search-results/gemini-results.md`
6. Parse and display results in the same numbered table format as JobBot
7. After displaying, remind user: **Setup #N** to pursue, **Skip #N** to filter out

**Note:** Gemini results are LLM-generated and may include stale or inaccurate URLs. Always verify links before applying.

### Setup Command

When user says `"Setup #N"` or `"Setup [Company - Role]"`:

**1. Check data/tracker.json for duplicates (BEFORE creating):**
   - Search all arrays (active, skipped, closed) for matching Company + Role
   - Match fuzzy (e.g., "Dropbox AI Platform" matches "Dropbox - SEM Core AI Platform")
   - **If found:** Alert user and ask whether to use existing or create new
   - **If not found:** Proceed to step 2

**2. Collect JD URL:**
   - First, check Chrome plugin (`mcp__claude-in-chrome__tabs_context_mcp`) for an open job posting tab
   - If found, use that URL and extract JD content from the page
   - If Chrome unavailable or no job tab found, try Firecrawl as fallback
   - If neither works, prompt user: "What's the URL for this job posting?"

**3. Create folder structure:**
   - Sanitize folder name: strip invalid characters (`: / ? * " < > |`)
   - Create folder in `data/InProgress/` named `[Company] - [Short Role Title]`
   - Copy `notes-template.md` → `notes.md`
   - Populate **Job URL** field in notes.md with the collected URL

**4. Save JD content:**
   - If JD accessible via Chrome plugin or Firecrawl, save as `JD.md` in the role folder
   - If user provides a PDF, they'll add it manually as `JD.pdf`

**5. Add entry to data/tracker.json:**
   - Read entire tracker.json
   - Append to `active` array with stage: "Sourced", added: today, updated: today
   - Write entire file back (validates JSON before saving)

**6. Confirm setup** with folder path and next steps (e.g., "Compare JD and resume")

### Skip Command

When user says `"Skip #N"` or `"Skip #N, #M"`:

1. Read data/tracker.json
2. Append to `skipped` array:
   ```json
   {
     "company": "...",
     "role": "...",
     "reason": "User skipped from search results",
     "url": "...",
     "added": "YYYY-MM-DD"
   }
   ```
3. Write entire file back
4. Confirm skipped

### Stage Changes — CRITICAL RULE

**ANY time a role's `stage` changes — regardless of how the user phrases it (e.g., "update to applied", "applied", "Move X to Y") — you MUST:**
1. Update `stage` and `updated` fields in data/tracker.json
2. Move the physical folder to the correct directory (`InProgress/` → `Applied/`, or `Applied/` → `Rejected/`, etc.)
3. Update the `folder` field in data/tracker.json to match the new path

**Directory mapping:**
- `Sourced` → `data/InProgress/`
- `Applied`, `Phone Screen`, `Technical`, `Onsite`, `Offer`, `Negotiating` → `data/Applied/`
- Any closed outcome (`Rejected`, `Withdrew`, `Accepted`, `Expired`) → `data/Rejected/`

This rule applies even if the user doesn't use the formal "Move" command syntax.

### Move Command

When user says `"Move [Company] to [Status]"` (e.g., "Move Stripe to Applied"):

**Valid target statuses:**
- `Applied` — submitted application (stays in active, stage changes)
- `Phone Screen`, `Technical`, `Onsite`, `Offer`, `Negotiating` — stage progression (stays in active)
- `Closed` — terminal state (moves from active to closed array, requires outcome)
- `Rejected`, `Withdrew`, `Accepted`, `Expired` — shortcuts for Closed with outcome

**Steps:**

1. Read data/tracker.json
2. Find role in `active` array by company name (fuzzy match)
3. **If not found:** Error — suggest Reconcile if folder exists
4. **If moving to a stage** (Applied, Phone Screen, etc.):
   - Update `stage` and `updated` fields
   - Move physical folder if status directory changes (e.g., InProgress → Applied)
   - Update `folder` field
5. **If closing** (Rejected, Withdrew, etc.):
   - Remove from `active` array
   - Add to `closed` array with `outcome` and `closed` date
   - Move physical folder to `data/Rejected/`
   - Update `folder` field
6. Write entire data/tracker.json back
7. Confirm move with new status

### Reconcile Command

When user says `"Reconcile"`:

Compare data/tracker.json against actual folder structure and report discrepancies.

**Checks:**
1. **Orphaned folders:** Folders in data/InProgress/data/Applied/Rejected not in data/tracker.json
2. **Missing folders:** Entries in data/tracker.json where folder doesn't exist
3. **Location mismatch:** Tracker says InProgress but folder is in Applied
4. **Stale entries:** Active roles with `updated` > 30 days ago

**Output:**
```
Reconcile Report:

Orphaned folders (not in tracker):
- data/InProgress/Acme - Engineer (folder exists, no tracker entry)

Missing folders (in tracker, no folder):
- Stripe - DevEx Lead (tracker says data/InProgress/Stripe - DevEx Lead)

Location mismatch:
- Vercel - Platform Lead: tracker says InProgress, folder in Applied

Stale (no update in 30+ days):
- Databricks - Manager (last updated: 2025-12-15)

Fix these issues? [y/n]
```

If user confirms, apply fixes:
- Orphaned folders: Add to data/tracker.json active array with stage "Sourced"
- Missing folders: Remove from data/tracker.json (or prompt to recreate)
- Location mismatch: Update data/tracker.json folder field to match reality

### Status Command

When user says `"Status"`:

**Read data/tracker.json only** — no folder scanning.

**Default (compact) format** — optimized for speed. Use `"Status full"` for the complete view.

**Display format:**

```
## Interviews (2)

| Company | Role | Stage | Next Action | Updated |
|---------|------|-------|-------------|---------|
| GitHub | Director of DevEx | Phone Screen | Awaiting loop decision (~Feb 6) | Jan 30 |
| Coinbase | SEM Finhub Platform | Phone Screen | Recruiter screen Feb 2 | Jan 30 |

## Applied (5)

Airbnb · Databricks (×2) · Dropbox · Oracle · Atlassian · NVIDIA (×2)

## Sourced (15)

Discord · Cloudflare · Upstart · LocalStack · Adobe · Patreon · Yahoo · +8 more

## Closed: 20 · Skipped: 13
```

**Rules:**
- **Interviews** (Phone Screen and above): full detail table — these are highest priority
- **Applied**: compact one-liner listing company names, group duplicates with (×N)
- **Sourced**: compact one-liner, show most recent first, truncate with "+N more" if >7
- **Closed/Skipped**: counts only

**`"Status full"`** — shows the complete expanded view with all tables (Applied detail, Sourced detail, Closed table, Skipped list). Use the old full-table format for all sections.

### Compare Command

When user says `"Compare JD and resume for [Company]"`:

**PREREQUISITE CHECK — Do this BEFORE spawning the subagent:**

1. Find role in data/tracker.json, get folder path
2. Check for JD file: `JD.md`, `JD.pdf`, or any file with "JD" in the name
3. **If JD file is missing or empty, DO NOT spawn the subagent.** Instead, respond:
   ```
   Cannot run comparison — JD file not found in [folder path]

   Found files: [list files]

   Options:
   1. Open the job posting in Chrome and I'll extract it
   2. Provide the JD URL and I'll fetch it
   3. Add JD.pdf manually to the folder
   ```

4. **If JD file exists**, spawn the `jd-resume-compare` agent

### Resume Tailoring Workflow

1. **Compare** → (after prerequisite check passes) `jd-resume-compare` agent analyzes JD, produces:
   - `resume-draft.md` — tailored resume (reordered, optimized, keywords injected)
   - `comparison-analysis.md` — fit scores (0-100), changelog, removed bullets, interview risks

2. **Generate PDF** → Convert markdown to PDF:
```bash
cd "[Role Folder]"
pandoc resume-draft.md -o resume.html --css="../../../resume.css" --embed-resources --standalone
weasyprint resume.html "[Name] Resume.pdf"  # Name from data/profile.md
```

3. **Re-compare** (optional) → Validate improvements against new PDF

**Output Files (in role folder):**
- `resume-draft.md` — Tailored resume markdown (source of truth for this role)
- `comparison-analysis.md` — Analysis, changelog, flagged items
- `[Name] Resume.pdf` — Final PDF (filename configured in `data/profile.md`)

### Command Reference

| Command | Action |
|---------|--------|
| `"Run job search"` | Call JobBot API → save to jobbot-results.json → dedupe against data/tracker.json → display |
| `"Setup #N"` or `"Setup [Company - Role]"` | Check tracker → collect JD (Chrome/Firecrawl) → create folder → add to data/tracker.json |
| `"Skip #N"` or `"Skip #N, #M"` | Add role(s) to data/tracker.json skipped array |
| `"Move [Company] to [Status]"` | Update data/tracker.json stage/status + move folder if needed |
| `"Compare JD and resume for [Company]"` | Prerequisite check → `jd-resume-compare` agent → resume-draft.md + analysis |
| `"Generate PDF for [Company]"` | Convert `resume-draft.md` → PDF via pandoc + weasyprint |
| `"Re-compare [Company]"` | Re-run comparison to validate improvements |
| `"Status"` | Read data/tracker.json → display formatted status |
| `"Reconcile"` | Compare data/tracker.json to folders → report/fix drift |
| `"Open dashboard"` | Build and open status dashboard locally |
| `"Deploy dashboard"` | Build status page → deploy to Cloudflare Pages |
| `"Add contact [Name] at [Company]"` | Create contact in network.json |
| `"Log interaction with [Name]"` | Record interaction + optional follow-up task |
| `"Add task [description]"` | Create task in tasks.json with optional links |
| `"Complete task #N"` | Mark task completed |
| `"Tasks"` | Display pending tasks |
| `"Contacts"` | Display contacts with recent interactions |
| `"Research packet for [Company]"` | Prerequisite check → `interview-research` agent → research-packet.md |
| `"Sync to Notion"` | Bidirectional incremental sync → pull then push → local wins conflicts |

### Notion Sync Command (Optional)

When user says `"Sync to Notion"`:

**Prerequisite:** Requires `notion` config in `data/config.json` with `apiKey` and `databases` (jobs, contacts, tasks). See `docs/notion-sync.md` for setup.

If config is missing or incomplete, tell the user: "Notion sync is not configured. See docs/notion-sync.md for setup instructions."

If configured, run:

```bash
node scripts/notion-sync.js
```

**Available flags (pass through when user specifies):**
- `--dry-run` — preview changes only
- `--pull-only` — only pull Notion → local
- `--push-only` — only push local → Notion
- `--full` — ignore hashes/timestamps, sync everything
- `--apply-deletes` — archive Notion pages for locally-deleted items

**How it works:**
1. Ensures database schemas (creates missing properties)
2. **Pull:** Queries Notion for pages changed since last sync, applies to local JSON files
3. **Push:** Hashes each local item, skips unchanged, creates/updates in Notion
4. Local wins on conflicts (both sides changed same item)
5. First run is baseline mode — records mappings without overwriting local data

**Sync map:** State is stored in `data/.notion-sync-map.json` (auto-generated, gitignored). Tracks Notion page IDs, content hashes, and timestamps for incremental sync. Auto-migrates from Phase 1 flat format.

### Research Packet Command

When user says `"Research packet for [Company]"` or `"Prep research for [Company]"`:

**PREREQUISITE CHECK — Do this BEFORE spawning the subagent:**

1. Find role in data/tracker.json, get folder path
2. Check for JD file: `JD.md`, `JD.pdf`, or any file with "JD" in the name
3. Check for `notes.md` with recruiter screen content
4. **If JD or notes.md is missing or empty, DO NOT spawn the subagent.** Instead, respond:
   ```
   Cannot generate research packet — [missing file] not found in [folder path]

   Found files: [list files]

   Options:
   1. Open the job posting in Chrome and I'll extract it
   2. Provide the JD URL and I'll fetch it
   3. Add the file manually to the folder
   ```

5. **If both exist**, spawn the `interview-research` agent

**Output:** `research-packet.md` in the role folder containing:
- Hiring manager profile (career, management style, public talks)
- Company context and recent events
- Engineering org structure and culture
- Observability stack and incident history
- Role analysis with predicted question categories
- Story map linking work-stories.md to likely questions
- Technology discussion prep
- Prioritized reading/watching list with URLs
- Questions to ask the interviewer
- Printable quick reference card

### Open Dashboard Command

When user says `"Open dashboard"`:

```bash
cd status-page && node build.js && open dist/index.html
```

Always rebuilds before opening (build is fast). Uses `open` on macOS, `xdg-open` on Linux.

### Deploy Dashboard Command

When user says `"Deploy dashboard"`:

```bash
cd status-page && node build.js && wrangler pages deploy dist --project-name=job-search-dashboard
```

**Output:** Confirm deployment with URL: `https://job-search-dashboard.pages.dev`

**Status Page Features:**
- KPI cards: Active roles, Applied, Updated this week, Days active
- Pipeline funnel with clickable stage filters
- Sortable active roles table
- Collapsible Closed/Skipped sections
- Tasks tab with pending/completed tasks
- Networking tab with contacts and recent interactions
- Password protected via Cloudflare Access

### Add Contact Command

When user says `"Add contact [Name] at [Company]"`:

1. Generate ID from name (kebab-case, e.g., "Cole Chandler" → "cole-chandler")
2. Check network.json for duplicate ID
3. **If found:** Alert user, ask whether to update existing or create new with suffix
4. **If not found:** Create new contact entry:
   ```json
   {
     "id": "generated-id",
     "name": "Name",
     "company": "Company",
     "title": null,
     "email": null,
     "linkedin": null,
     "source": null,
     "introducedBy": null,
     "added": "YYYY-MM-DD",
     "interactions": []
   }
   ```
5. Prompt for optional fields: title, email, linkedin, source, introducedBy
6. Write data/network.json
7. Confirm with contact summary

### Log Interaction Command

When user says `"Log interaction with [Name]"`:

1. Find contact in network.json by name (fuzzy match)
2. **If not found:** Offer to create new contact
3. **If found:** Prompt for interaction details:
   - Type: email, call, message, meeting, linkedin, coffee
   - Summary: brief description
   - Linked jobs (optional): suggest from active jobs in data/tracker.json
4. Append to contact's `interactions` array:
   ```json
   {
     "date": "YYYY-MM-DD",
     "type": "...",
     "summary": "...",
     "linkedJobs": []
   }
   ```
5. Write data/network.json
6. Offer to create follow-up task

### Add Task Command

When user says `"Add task [description]"`:

1. Generate next task ID (task-XXX, incrementing)
2. Parse description for context clues:
   - Contact names → suggest linkedContacts
   - Company names → suggest linkedJobs from data/tracker.json
3. Prompt for optional fields:
   - Due date (or null)
   - Linked contacts
   - Linked jobs
4. Create task entry:
   ```json
   {
     "id": "task-XXX",
     "task": "description",
     "due": "YYYY-MM-DD",
     "linkedContacts": [],
     "linkedJobs": [],
     "status": "pending",
     "created": "YYYY-MM-DD"
   }
   ```
5. Write data/tasks.json
6. Confirm task created

### Complete Task Command

When user says `"Complete task #N"` or `"Complete task [description snippet]"`:

1. Find task in tasks.json by ID or fuzzy match on description
2. **If not found:** List pending tasks for user to select
3. **If found:** Update status to "completed"
4. Write data/tasks.json
5. Confirm completion

### Tasks Command

When user says `"Tasks"`:

**Read tasks.json** and display:

```
## Pending Tasks (3)

| # | Task | Due | Linked To |
|---|------|-----|-----------|
| 1 | Follow up with Clint on referral | Jan 27 | Clint, Airbnb |
| 2 | Prep for HM screen with Merav | — | Merav, GitHub |
| 3 | Research Coinbase Custody product | — | Coinbase |

## Recently Completed (2)
- Sent resume to Cole (Jan 26)
- Applied to NVIDIA SM role (Jan 23)
```

### Contacts Command

When user says `"Contacts"`:

**Read network.json** and display:

```
## Contacts (3)

| Name | Company | Last Contact | Linked Jobs |
|------|---------|--------------|-------------|
| Cole Chandler | Oracle | Jan 26 (email) | 2 roles |
| Clint | Airbnb | Jan 23 (message) | 1 role |
| Merav Feiler | GitHub | Jan 25 (call) | 1 role |

Total interactions: 5
```

## Error Handling

### JSON Safety
- **Always read entire data/tracker.json before writing**
- **Rewrite entire file** (don't append/patch in place)
- **Validate JSON parses** before saving
- If data/tracker.json missing or corrupt, initialize with empty structure:
  ```json
  {"active": [], "skipped": [], "closed": []}
  ```

### Folder Names
- Strip invalid path characters: `: / ? * " < > |`
- Replace with `-` or omit
- Example: "Company: The Role" → "Company - The Role"

### Before Setup
- Check data/tracker.json for existing company+role (fuzzy match across all arrays)
- If found: alert user, ask whether to use existing or create new

### Before Move
- Verify role exists in data/tracker.json active array
- Verify folder exists at expected path
- If mismatch: suggest Reconcile

### Company Aliases
Treat these as equivalent when matching:
- Meta / Facebook / Meta Platforms
- Google / Alphabet / Google Cloud
- Amazon / AWS / Amazon Web Services
- Microsoft / Azure / LinkedIn (for LinkedIn roles)

Add others as encountered.

### Valid Stages (active roles)
Only these values allowed for `stage`:
- `Sourced` — found, not yet applied
- `Applied` — submitted application
- `Phone Screen` — recruiter/hiring manager call
- `Technical` — technical interview stage
- `Onsite` — final round
- `Offer` — received offer
- `Negotiating` — working terms

### Valid Outcomes (closed roles)
Only these values allowed for `outcome`:
- `Rejected` — company declined
- `Withdrew` — user declined to continue
- `Accepted` — offer accepted
- `Expired` — posting closed/filled

## Conventions

- Role folders named: `[Company] - [Short Role Title]`
- JD filename: contains "JD" (e.g., `JD.pdf`, `JD.md`)
- Resume filename: configured in `data/profile.md` (generated from `resume-draft.md`)
- Update data/tracker.json via Move command as roles progress
- Folders hold artifacts; data/tracker.json holds status
- notes.md for role-specific working notes (interview prep, contacts, research)

## User Profile

User-specific information (name, background, target roles, resume filename) is stored in `data/profile.md`. Read this file at session start to personalize responses and use the correct resume filename for PDF generation.

See also `data/resume-content.md` for full career details and `data/work-stories.md` for interview stories.

## Preferences

- Project alias: Ariadne (public repo name)
- Session greeting style: friendly, includes quote of the day
