# Ariadne

A Claude Code-powered job search assistant that helps you find opportunities, tailor resumes, track applications, and manage your professional network — all through natural conversation.

## What is Ariadne?

Job searching is overwhelming. You're juggling dozens of applications, customizing resumes for each role, tracking where you are in various interview processes, following up with contacts, and trying not to let anything slip through the cracks.

Ariadne is your AI-powered job search co-pilot. It uses [Claude Code](https://docs.anthropic.com/en/docs/claude-code) to understand natural language commands and automate the tedious parts of job hunting while keeping you in control of the important decisions.

**Named after the Greek mythological figure who gave Theseus a thread to navigate the labyrinth**, Ariadne helps you find your way through the maze of modern job searching.

---

## The Job Search Pipeline

Ariadne follows your journey from discovering opportunities to landing offers. Here's how it works at each stage:

### 1. Finding Opportunities

Start your search with a simple command:

```
"Run job search"
```

Ariadne executes a targeted search using your criteria (role types, companies, location preferences) and returns fresh results. It automatically filters out roles you've already seen, skipped, or applied to — so you only see what's new.

Results appear in a numbered list. From there:
- **`"Setup #3"`** — Start tracking a role you're interested in
- **`"Skip #1, #5"`** — Filter out roles that aren't a fit (won't appear again)

> **Why JobBot?** It scrapes real ATS APIs (Greenhouse, Lever, Ashby, Workday) directly — no hallucinated job postings. URLs are guaranteed to exist.

### 2. Setting Up a Role

When you find a promising opportunity:

```
"Setup Stripe - Platform Lead"
```

Ariadne will:
1. Check if you're already tracking this role (prevents duplicates)
2. Grab the job description from your browser or ask for the URL
3. Create a dedicated folder with tracking notes
4. Add it to your pipeline as "Sourced"

Each role gets its own folder containing the JD, your tailored resume, interview notes, and any other artifacts.

### 3. Preparing for Interviews

Before tailoring your resume or prepping for an interview, generate a research packet:

```
"Research packet for Stripe"
```

Ariadne's research agent:
- Researches the hiring manager (career path, management style, public talks)
- Investigates the company's engineering org, culture, and recent events
- Maps their tech stack and observability practices to your experience
- Analyzes the JD and recruiter notes to predict interview question categories
- Maps your work stories to likely questions with specific beats to hit
- Curates a prioritized reading/watching list (blog posts, talks, podcasts)
- Drafts high-signal questions to ask your interviewer

You get `research-packet.md` in the role folder — including a printable quick reference card for interview day.

### 4. Tailoring Your Resume

This is where Ariadne shines. Instead of manually tweaking your resume for each application:

```
"Compare JD and resume for Stripe"
```

Ariadne's resume comparison agent:
- Analyzes the job description for key requirements
- Cross-references your master resume and interview stories
- Evaluates fit across multiple dimensions (strategic, technical, leadership, etc.)
- Produces a **tailored resume** with bullets reordered by relevance
- Flags anything uncertain with `[REVIEW]` — it never fabricates

You get two outputs:
- `resume-draft.md` — Your customized resume for this role
- `comparison-analysis.md` — Detailed reasoning, fit scores, and interview risk areas

### 5. Generating Your PDF

Once you're happy with the draft:

```
"Generate PDF for Stripe"
```

Ariadne converts your markdown resume to a professionally formatted PDF using your configured stylesheet.

### 6. Tracking Progress

As you move through the interview process:

```
"Move Stripe to Applied"
"Move Stripe to Phone Screen"
"Move Stripe to Onsite"
```

Valid stages: `Sourced` → `Applied` → `Phone Screen` → `Technical` → `Onsite` → `Offer` → `Negotiating`

When a process ends:
```
"Move Stripe to Rejected"    # They passed
"Move Stripe to Withdrew"    # You passed
"Move Stripe to Accepted"    # 🎉
```

### 7. Staying Organized

Check your pipeline anytime:

```
"Status"
```

See all active roles grouped by stage, recent closures, and how long since each was updated. Stale applications (no update in 30+ days) get flagged.

```
"Reconcile"
```

Compares your tracker against actual folders — finds orphaned folders, missing entries, and location mismatches. Keeps everything in sync.

---

## Networking & Tasks

Job searching isn't just applications — it's relationships and follow-ups.

### Managing Contacts

```
"Add contact Sarah Chen at Stripe"
"Log interaction with Sarah"
"Contacts"
```

Track your professional network: who you know at target companies, how you met, and every interaction (emails, calls, coffee chats). Link contacts to specific job opportunities.

### Task Management

```
"Add task Follow up with Sarah about referral"
"Tasks"
"Complete task #1"
```

Create tasks linked to jobs and contacts. Never forget a follow-up or interview prep item.

---

## Status Dashboard

```
"Deploy dashboard"
```

Generates a web-based dashboard showing your pipeline funnel, active roles, tasks, and networking activity. Deploys to Cloudflare Pages for easy access from any device.

---

## Getting Started

### Requirements

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)
- Optional: [pandoc](https://pandoc.org/) + [weasyprint](https://weasyprint.org/) for PDF generation
- Optional: JobBot API credentials or [Gemini CLI](https://github.com/google/gemini-cli) for job search
- Optional: [Notion API key](https://notion.so/my-integrations) for bidirectional sync

### Installation

1. Clone this repository
2. Start Claude Code in the project directory
3. Say hello — Ariadne will detect first run and walk you through setup

The interactive setup will:
- Check your system for required dependencies
- Analyze your resume to pre-fill profile and search criteria
- Collect your preferences and configure your search backend
- Initialize all data files automatically

Your `data/` directory is gitignored — your personal information stays private.

**Alternative:** For a non-interactive setup, run `./init.sh` and manually edit the template files in `data/`.

### First Session

On first run, Ariadne walks you through onboarding. On subsequent sessions, it greets you with available commands and your current pipeline status.

```
> Good morning

Good morning! Here's your job search status...

## Active Roles (5)
| Company | Role | Stage | Next Action |
...
```

---

## Command Reference

| Command | What it does |
|---------|--------------|
| `"Run job search"` | Find new opportunities matching your criteria |
| `"Setup #N"` or `"Setup [Company - Role]"` | Start tracking a role |
| `"Skip #N"` | Filter out a role from future searches |
| `"Research packet for [Company]"` | Generate interview research packet |
| `"Compare JD and resume for [Company]"` | Generate tailored resume + fit analysis |
| `"Generate PDF for [Company]"` | Create submission-ready PDF |
| `"Move [Company] to [Stage]"` | Update pipeline status |
| `"Status"` | View current pipeline |
| `"Reconcile"` | Sync tracker with folder structure |
| `"Add contact [Name] at [Company]"` | Add to your network |
| `"Log interaction with [Name]"` | Record a touchpoint |
| `"Contacts"` | View your network |
| `"Add task [description]"` | Create a to-do |
| `"Tasks"` | View pending tasks |
| `"Complete task #N"` | Mark done |
| `"Open dashboard"` | Build and open status dashboard locally |
| `"Deploy dashboard"` | Build and deploy status page |
| `"Sync to Notion"` | Bidirectional sync jobs, contacts, and tasks to Notion |

---

## Optional: Notion Sync

Ariadne can sync your jobs, contacts, and tasks to Notion for access from any device. This is fully optional — local files remain the source of truth.

```
"Sync to Notion"
```

**Features:**
- Bidirectional incremental sync (pull-then-push)
- Content hashing skips unchanged items (~6 API calls when nothing changed)
- Local wins on conflicts
- Append-only merge for contact interactions
- Auto-migrates from one-way sync format

**Auto-sync on session start:** Set `"autoSync": true` in your Notion config to sync automatically when you start a session. Runs in the background — doesn't delay your greeting.

```json
// data/config.json
{
  "notion": {
    "apiKey": "ntn_...",
    "databases": { "jobs": "...", "contacts": "...", "tasks": "..." },
    "autoSync": true
  }
}
```

**Flags (manual runs):** `--dry-run`, `--pull-only`, `--push-only`, `--full`, `--apply-deletes`

See [docs/notion-sync.md](docs/notion-sync.md) for setup and full documentation.

---

## Project Structure

```
ariadne/
├── CLAUDE.md                 # Claude Code instructions (the brain)
├── data/                     # Your personal data (gitignored)
│   ├── profile.md            # Name, background, preferences
│   ├── resume-content.md     # Master resume
│   ├── work-stories.md       # Interview stories
│   ├── tracker.json          # Pipeline state (source of truth)
│   ├── network.json          # Contacts and interactions
│   ├── tasks.json            # To-do items
│   ├── config.json           # API configuration (gitignored)
│   ├── InProgress/           # Active role folders
│   ├── Applied/              # Submitted applications
│   └── Rejected/             # Closed opportunities
├── data.example/             # Templates for new users
├── scripts/                  # Automation scripts
│   └── notion-sync.js        # Bidirectional Notion sync (optional)
├── docs/                     # Additional documentation
│   └── notion-sync.md        # Notion sync setup and usage
├── prompts/                  # Search and analysis prompts
├── status-page/              # Dashboard generator
├── resume.css                # PDF stylesheet
├── notes-template.md         # Per-role tracking template
└── init.sh                   # First-time setup
```

---

## How It Works

Ariadne is built on Claude Code's ability to read project context and execute multi-step workflows. The `CLAUDE.md` file contains detailed instructions for every command — schemas, validation rules, error handling, and behavioral guidelines.

When you say "Compare JD and resume for Stripe", Claude Code:
1. Reads the instruction from CLAUDE.md
2. Finds the role in tracker.json
3. Loads the JD, your resume, and work stories
4. Spawns a specialized comparison agent
5. Writes the tailored resume and analysis to the role folder

You stay in control — Ariadne asks before destructive actions and flags anything uncertain for your review.

---

## Contributing

Ariadne is open source. If you have ideas for improvements:
1. Fork the repository
2. Create a feature branch
3. Submit a pull request

The personal data structure (`data/`) is designed to be portable — you can use your own resume content with the framework.

---

## License

MIT License. Use it, modify it, make it yours.

---

*Finding your way through the labyrinth, one application at a time.*
