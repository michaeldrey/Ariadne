# Job Search Automation - Gemini Context

This is David Eagle's job search management system. Read this file at session start for context.

## On Session Start

When David sends a greeting to start the session, respond with:
1. A friendly, distinct greeting (I am Gemini)
2. A fun quote of the day (motivational, witty, or job-search relevant)
3. The commands table below
4. Current active roles and their status

| Command | Action |
|---------|--------|
| `"Run job search"` | Find new roles at target companies |
| `"Compare JD and resume for [Company]"` | Analyze fit, create comparison + edit checklist |
| `"Apply edits for [Company]"` | Update resume markdown with suggestions |
| `"Re-compare [Company]"` | Validate improvements after PDF update |
| `"Setup [Company - Role]"` | Create folder + notes.md from template |
| `"Status"` | Show active roles and next actions |

## Quick Reference

**Directory Structure:**
- `/prompts/archive/` - **CRITICAL:** Source instructions for tasks. Read these to understand how to execute commands.
- `/InProgress/` - Active applications being worked on
- `/Applied/` - Submitted applications
- `/Rejected/` - Closed opportunities
- `/search-results/` - Dated search output files

**Key Files:**
- `resume-content.md` - Master resume in markdown (editable)
- `notes-template.md` - Template for role-specific tracking
- `search-log.md` - Running log of job searches
- `README.md` - Full documentation and backlog

## Commands & Execution Logic

**Note:** Unlike Claude, I do not have pre-baked "subagents". I must read the archive prompt files to load the specific instructions for each task.

| Command | Action | Execution Source |
|---------|--------|------------------|
| `"Run job search"` | Execute job search logic | Read: `/prompts/archive/job-search-query.md` |
| `"Compare JD and resume for [Company]"` | Execute comparison logic | Read: `/prompts/archive/jd-resume-compare.md` |
| `"Apply edits for [Company]"` | Execute resume editing logic | Read: `/prompts/archive/resume-iteration.md` |
| `"Re-compare [Company]"` | Re-run comparison | Read: `/prompts/archive/jd-resume-compare.md` |
| `"Setup [Company - Role]"` | Create folder + notes.md | Use: `notes-template.md` |

## Current Status

**Active Roles:**
- Netflix - Senior EM (Applied, awaiting final round AMA)
- GitHub - Director of DevEx (Applied, HM screen Jan 27)
- Atlassian - SEM Dev Obs (InProgress, needs comparison)
- Coinbase - SEM Experience Platforms (InProgress, needs JD PDF + comparison)
- Coinbase - SEM Finhub Platform (InProgress, needs JD PDF + comparison)
- Coinbase - SEM Consumer Growth (InProgress, needs JD PDF + comparison)

**Workflow Notes:**
- David uses .pages files for visual formatting, exports to PDF
- I cannot read .pages files - always use PDF for comparisons
- `resume-content.md` is the **master baseline - NEVER modify directly**
- Role-specific edits go to `[Role Folder]/resume-draft.md`
- Each role folder should have: JD.pdf, Resume.pdf, notes.md

## Conventions

- Role folders named: `[Company] - [Short Role Title]`
- JD filenames contain "JD"
- Resume filenames contain "Resume"
- Update notes.md throughout interview process
- Move folders between status directories as roles progress

## David's Background

Technology executive targeting Director/Senior Manager roles in:
- Developer Experience (DevEx)
- Platform Engineering
- Developer Tools/Infrastructure

Recent experience:
- Zillow: Senior Director, Developer Experience (60-person org, IDP)
- Amazon/Twitch: Engineering Director, Builder Platform (L7)

See `resume-content.md` for full details.
