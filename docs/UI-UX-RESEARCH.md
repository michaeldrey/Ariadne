# Ariadne UI/UX Research — 2026-04-22

Concrete patterns from job-tracking competitors (Teal, Huntr, Simplify,
LinkedIn) and adjacent AI-native desktop apps (Linear, Raycast, Cursor,
Arc, Notion, Superhuman, Obsidian, Things). Structured by surface.

---

## 1. Sidebar Navigation — Icons, Order, Labels

- **Teal HQ**: top-to-bottom: Dashboard (home) → Job Tracker (briefcase) → Job Matcher (target) → Resume Builder (document) → Cover Letters (envelope) → Contacts (people). Settings lives as a gear at bottom-left, separate from a distinct profile avatar also at bottom.
- **Huntr**: top navbar rather than sidebar — Boards, Jobs, Contacts, Documents, Metrics horizontally; settings behind avatar dropdown top-right.
- **Linear**: left sidebar, collapsible, text labels always visible when expanded, icon-only when collapsed (cmd-/). Settings NOT in the main sidebar — behind the workspace switcher at top-left, opens a fully separate settings "page mode" that replaces the sidebar. Avatar/account at bottom-left.
- **Notion**: sidebar has account switcher + workspace at top, then Search, Home, Inbox as fixed items, then user-created pages. Settings is "Settings & members" accessed via the workspace switcher at top — not a nav item.
- **Superhuman**: minimal left rail with inbox folders; Settings is cmd-, (keyboard-first) and appears as a modal overlay, not a route. Common pattern across keyboard-driven apps.
- **Raycast**: preferences window is entirely separate (cmd-,) — never part of the main surface.

**Recommendation**: Keep a left sidebar (Linear-style, collapsible, labels-when-expanded). Order: Dashboard → Roles → Tasks → Contacts → Chat → Profile, with Job Search and Interview Prep slotted after Roles once built. Put Settings at bottom-left as a gear icon, and put the user avatar/profile-identity also at the bottom (two items: Settings is app config, Profile is career data — they're genuinely different objects here). Use briefcase for Roles, checklist for Tasks, people for Contacts, chat-bubble for Chat, document-person for Profile.

---

## 2. Dashboard / Home View

- **Teal HQ**: large "Job Application Tracker" weekly goal tile (applications this week with a numeric goal the user sets), then "Bookmarked Jobs" carousel, then "Recent Activity," then a "Top Matched Jobs" feed. Heavy emphasis on activity streak gamification.
- **Huntr**: no real dashboard — lands you on the Kanban board. Metrics view is a separate tab with funnel counts (Wishlist → Applied → Interview → Offer) and time-in-stage.
- **Simplify**: dashboard is a feed of "Jobs for you" from their sourcing engine plus an activity row — tracker is secondary. Heavily biased toward new-opportunity discovery because that's the monetization.
- **LinkedIn Jobs**: "Recommended for you" + "Jobs you've saved" + "Recent searches." No task/action surface — pure discovery.
- Redundancy observed: all show recent activity logs which users ignore. High-signal elements are the weekly-count tile (Teal) and funnel counts (Huntr).

**Recommendation**: Three horizontal bands — (1) "This week" action strip: tasks due today, stalled roles (>7 days no activity), upcoming interviews. (2) Pipeline snapshot: funnel counts by stage, clickable into Roles filtered. (3) Recent AI chat threads — unique to Ariadne's value prop and worth a band others don't have. Skip activity logs and skip a "recommended jobs" feed until Job Search ships.

---

## 3. Role / Application Detail Layout

- **Teal HQ**: single modal/drawer overlay, not a full page. Top section has job metadata, then tabs across the top: Job Description | Contacts | Notes | Tasks | Documents | Activity. Application stage is a pill-dropdown in the top-right header.
- **Huntr**: full page after clicking a card. Left column is stage/metadata/salary, right column is a scrollable single-column of sections (Description, Notes, Tasks, Files, Contacts) — not tabbed, all visible. Stage changes by dragging the card on the board or via dropdown on the detail page.
- **Linear issue detail**: split layout — main content left, metadata rail right with all controls (status, priority, assignee, labels). Status changed via dropdown in the right rail or via keyboard shortcut.
- **Notion database row**: opens as a modal with properties at top and page body below — tab-less, everything inline.
- Action buttons: Teal puts "AI Resume" and "Analyze" as prominent top-right buttons. Huntr has no AI actions surfaced. Linear puts assign/status/priority in the right rail, not a header.

**Recommendation**: Keep the tabs you already have (JD, Resume, Analysis, Research, Notes, Tasks) — six sections is too many for Huntr-style stacked scroll. Put stage as a pill-dropdown top-right (Teal pattern). Put AI action buttons (Chat, Tailor Resume, Research) as a button row directly under the header, always visible across tabs — this is where Ariadne's core value lives and should not be hidden inside a tab. Consider a Linear-style right metadata rail for salary/location/URL/date-added so they're visible on every tab.

---

## 4. Chat / AI Integration Patterns

- **Cursor**: chat is a right-side collapsible panel (cmd-L) within the editor; can also be detached. Context is the current file/selection. Each new chat is a thread in a list.
- **Raycast AI**: AI chat is a full-window mode (cmd-space → tab), not a panel. Threads listed in left rail, conversation on right. No object-context concept.
- **Arc** (Max): AI is invoked per-tab via a command bar overlay — ephemeral, tied to page context, not a persistent panel.
- **Notion AI**: inline-in-document for edits, plus a standalone "AI chat" in the sidebar for Q&A. Two separate surfaces for two jobs: in-context edits vs conversational research.
- Per-object chat precedent: **Granola** and **Mem** both attach conversations to notes/meetings; surface is an inline panel below the content. **ChatGPT Projects** attach threads to a project scope and list them in the sidebar under the project.

**Recommendation**: Two surfaces. (1) A persistent Chat nav item for profile-scoped / general conversation, Raycast-style with thread list + conversation. (2) A right-side collapsible chat panel inside a Role detail page, Cursor-style, where the role is auto-context and threads are filtered to that role. Do not build a floating window — it conflicts with Tauri window management and doesn't match desktop conventions.

---

## 5. Settings Organization

- **Linear**: two-pane — left nav grouped as Account (Profile, Preferences, Notifications, Security) | Workspace (General, Members, Billing) | My preferences (Appearance, Keyboard shortcuts) | Integrations (dedicated section) | API (separate from integrations).
- **Raycast**: tabs across top — General, Extensions, AI, Account, Organizations, Cloud Sync, Advanced. API/model config lives under AI.
- **Superhuman**: grouped as Account, Preferences, Shortcuts, Team, Billing.
- **Notion**: My Account, My Settings, My Notifications, My Connections (integrations), then Workspace-level below.
- Pattern: "Account" (identity/billing) always separated from "Preferences" (how the app behaves). Integrations/API are usually their own top-level section, not buried under preferences.

**Recommendation**: Four groups in a left-nav settings page — (1) General (theme, startup), (2) AI & Backends (Claude API keys, ACP config, model selection — Ariadne's Raycast-AI equivalent, deserves top billing), (3) Integrations & Import (resume import, future job-board APIs), (4) Account (empty/placeholder now, populated when cloud login arrives). Keep Profile (career data) completely out of Settings — it's a first-class domain object in this app, not a pref.

---

## 6. Data Density and List Views

- **Teal HQ tracker table**: default columns Status, Company, Role, Location, Salary, Date Saved, Excitement (1-5 stars). Match score in the Job Matcher tab, not the tracker. Rows ~40px, one-line.
- **Huntr list view**: Company, Position, Status, Deadline, Date Applied, Salary, Location. Fit score not shown.
- **Linear issue list**: ID, Title, Status, Priority, Assignee, Labels, Updated. Rows 32px. Inline edit on hover for status/priority. Density toggle (compact/comfortable).
- **LinkedIn saved jobs**: logo, title, company, location, posted-date, easy-apply badge. Rows ~72px — much roomier than work apps.
- Match/fit score: Teal uses a percentage number with a colored bar (green 80+, yellow 60-79, red <60). LinkedIn uses "Top applicant" / "Good match" text badges. Huntr doesn't show fit.

**Recommendation**: Default columns Company, Role, Stage, Fit %, Next Action, Last Updated — six is the sweet spot. Render fit as a number + colored bar (Teal pattern, more scannable than a badge). 36-40px rows, Linear-style density. Hidden behind expand: salary, location, URL, date-added. Add a density toggle later; don't ship two modes on v1.

---

## 7. Auth / Login Surfaces

- **Obsidian** (local-first): app works fully offline with no account. Sync is a paid opt-in; login prompt appears only when the user clicks "Enable Sync" in settings. No login wall ever.
- **Raycast**: same pattern — local usage free, cloud sync/Pro requires account, login is under Settings → Account, not on launch.
- **Things 3**: local-only historically; Things Cloud added as opt-in sync, lives under Preferences → Things Cloud with a "Sign in" button.
- **Cursor**: local editor but account-gated for AI features. Login is a modal on first AI use, not on app launch.

**Recommendation**: Obsidian/Things model. Never gate app launch on login. When cloud sync ships, add "Account & Sync" as a Settings section with a sign-in button; on sign-in, offer to upload current local DB as the initial sync state. If any AI features later require Ariadne-hosted inference (vs user-supplied Claude key), gate only that feature behind login — Cursor-style — not the whole app.

---

## Top 5 Changes Worth Making Soon

1. **Add a persistent AI-action button row to Role detail header (Chat, Tailor Resume, Research)** — tabs hide the app's core value; Teal surfaces these top-right and they're the most-clicked controls. Low effort, high signal.
2. **Restructure Dashboard into three bands: This Week / Pipeline Snapshot / Recent Chats** — the "Recent Chats" band is your differentiator vs Teal/Huntr. Medium effort, defines the product's identity.
3. **Move Settings to bottom-left gear, keep Profile as a top-level nav item** — these are genuinely different objects in Ariadne and conflating them (as most apps do) wastes your strongest surface. Low effort.
4. **Ship fit-score as number + colored bar in the Roles list, not a badge** — Teal's exact pattern is proven scannable at 50+ rows; badges don't scale. Low effort once scoring exists.
5. **Design Settings with an "Account & Sync" placeholder section now, even empty** — commits to the Obsidian/Things opt-in-login model structurally, so when cloud ships you're not retrofitting nav. Very low effort, saves a future migration.
