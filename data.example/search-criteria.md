# Job Search Criteria

This file configures your job search parameters. The "Target Companies" section is used by JobBot's ATS scrapers.

## Target Companies

These companies will be searched via JobBot's direct ATS API integrations (Greenhouse, Lever, Ashby, Workday).

### Tier 1 (Always Search)
- Anthropic
- OpenAI
- Stripe
- Netflix
- Figma
- Discord
- Coinbase
- Cloudflare
- Datadog

### Tier 2 (Growth Stage)
- Ramp
- Vercel
- Linear
- Mercury
- Retool
- Supabase
- Replit

### Tier 3 (Enterprise / Big Tech)
- Databricks
- Snowflake
- MongoDB
- HashiCorp
- Atlassian
- GitHub
- GitLab

> **Note:** See JobBot's `companyATS.ts` for the full list of 100+ supported companies.

---

## Target Role

- **Level:** [e.g., Senior, Staff, Principal, Director]
- **Functions:** [e.g., Platform Engineering, Developer Experience, Infrastructure]
- **Scope:** [e.g., IC with broad impact, Tech Lead, Multi-team]

## Role Levels to Include

These keywords are passed to JobBot's filter and must appear in job titles:
- Senior
- Staff
- Principal
- Lead

## Location

- **Preference:** [e.g., Remote US required, Hybrid OK, On-site in Seattle]
- **Hard constraints:** [e.g., No relocation, No SF-only roles]

### Location Keywords

These keywords are passed to JobBot's location filter. Jobs must contain at least one:
- Remote
- USA
- United States
- US

## Compensation Target

- **Total Comp:** [e.g., $400k - $600k+]
- **Notes:** [e.g., Open to high-equity pre-IPO if base is reasonable]

## Technical Domains (Best Fit)

- Internal Developer Platforms (IDP)
- Cloud Infrastructure
- CI/CD / Deployment
- Observability / Telemetry
- AI/ML Infrastructure

## Adjacent Domains (Weaker Fit but Open)

- ML Platform (infrastructure side)
- Data Platform (if infrastructure-focused)
- Security Infrastructure

## Red Flags to Filter Out

- IC roles below Senior level
- Hybrid-required without remote flexibility
- Generic postings without team specificity
- Contractor/consulting positions

## Background Summary

[Brief summary of your experience to help calibrate role matching]

- **Recent role:** [e.g., Senior Director at Company X]
- **Strengths:** [e.g., Platform strategy, Kubernetes, AWS, CI/CD]
- **Gaps:** [e.g., Areas where you're less experienced]
