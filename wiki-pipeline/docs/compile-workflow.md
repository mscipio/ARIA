# Wiki Compilation Protocol — Manual Workflow

This document describes how to compile raw opencode session files into structured wiki pages **without using an automatic compile script**. You read the raw files directly, generate the wiki content, and write it yourself.

---

## Overview

```
raw/session_foo.md ──→ [analyze + search wiki] ──→ [decide: create|update|skip] ──→ write wiki/page.md
raw/session_bar.md ──→ [analyze + search wiki] ──→ [decide: create|update|skip] ──→ write wiki/page.md
                                                                                            │
                                                                                            ├── update wiki/index.md
                                                                                            └── append to wiki/log.md
```

## LLM-Native Design Principle

This wiki is designed for **LLM-first consumption** — pages are retrieved individually via RAG and assembled into context. This drives three structural rules:

### 1. Atomic Pages

Domain concepts MUST be written as atomic pages — one focused concept per page. Do NOT combine distinct queryable concepts into one dense page. When in doubt, split.

**Examples:**
- ✅ Separate pages for each distinct algorithm, component, or configuration
- ✅ Workflow guides, case studies, and project meta-pages should remain self-contained narratives (loaded as complete context)
- ❌ One dense page combining unrelated topics

### 2. Dense Cross-Linking

Every page MUST link to ALL directly related pages. Target 3-5 meaningful `[[wiki_links]]` per page, minimum 1. Links are the relationship graph that guides RAG context assembly.

- Algorithm pages → link to the math/framework pages
- Hardware pages → link to firmware/software pages that control them
- Bug pages → link to component pages involved
- Configuration pages → link to hardware/software pages configured

**No filler links**: Only link to pages with a direct topical relationship. Don't link to infrastructure pages (like the session archiver, notes project, or SDD workflow) from content pages just because they're part of the wiki. Infrastructure links stay in infrastructure — wiki infrastructure pages link to each other, but content pages only link to other content pages they directly relate to.

### 3. Glossary for Subsidiary Terms

Use a shared glossary page for subsidiary domain terms:
- If a concept is mentioned but is secondary to the page's focus → link to `[[glossary|term]]`
- If a concept needs its own full treatment → create an atomic page, then link to it

## Core Principle: Capture Everything

**No raw file should ever need to be accessed after compilation.** All substantive information from raw sessions must be captured in wiki pages. The wiki is the knowledge base; raw files are immutable source documents that should never be consulted again.

This means:
- **Don't summarize — capture specifics.** Numbers, decisions, bug details, configuration values, file paths, error messages. If it's in the raw file and has lasting value, it goes in the wiki.
- **Don't skip sections because they're long.** Detailed content that spans many lines still needs to be captured across one or more atomic pages.
- **Don't assume "covered by project page" means "done."** A project-level summary that omits specific findings, bugs, or decisions is not complete.
- **Domain knowledge > workflow details.** Technical specifications, measured values, and engineering decisions are more valuable than chat logs about how to run a command.

**Verification test**: After writing a wiki page, ask yourself: "If someone reads only this wiki page, will they have everything they need from the raw file, or will they need to go back to `raw/`?" If the answer is "go back to raw," the page is incomplete.

## Phases

### Phase 1 — Analyze the Raw File

Read one raw file from `raw/`. Extract from its frontmatter and content:

- **Title** (from frontmatter `title:` or session title)
- **Agent** (which opencode agent ran this session)
- **Date** (when the session happened)
- **Key concepts** — extract 2-5 significant nouns/phrases from user messages and assistant responses. These are what you will search for in the wiki.
- **Key decisions, implementations, or discussions** — the substantive technical content worth preserving.

### Phase 2 — Search Existing Wiki Efficiently

**Goal**: Find existing wiki pages that might overlap with this raw file without loading every page into context.

**Strategy** (cheapest first):

| Step | Tool | Cost | What it finds |
|------|------|------|---------------|
| 1. Get page list | `ls wiki/*.md` | Free — filenames only | All page names |
| 2. Match filenames | Compare key concepts against filenames (strip `.md`, replace `_` with space) | Free — no reads | Direct title matches |
| 3. Grep content | `grep -ril "keyword1\|keyword2" wiki/*.md` | One grep call per batch of keywords | Pages containing any keyword |
| 4. Read matches | `read` only the files that matched | Targeted reads | Full content for comparison |

**Keyword extraction from the raw file**: Pull 3-5 significant terms from:
- The frontmatter title
- The session agent name
- Key nouns from user messages (tools, concepts, patterns mentioned)
- Avoid generic words (session, opencode, notes, project, file)

**Example**:
```
Raw file title: "Implement JWT auth middleware"
Key concepts: ["jwt", "authentication", "middleware", "token"]
Grep: grep -ril "jwt\|authentication\|middleware\|token" wiki/*.md
```

### Phase 3 — Decide: Create, Update, Skip, or Split

After searching, you have:
- **No matches** → Check how many distinct concepts the raw file covers. If 2+, create multiple atomic pages.
- **One or more matches** → Read the matching page(s) and compare against the raw file.

**Decision rules**:

| Situation | Action |
|-----------|--------|
| No existing page for the concept(s) | **Create** one or more atomic pages |
| Page exists, raw adds new info on a **new sub-concept** | **Create** a new atomic page + cross-link from existing |
| Page exists, raw adds new info for an **existing sub-concept** | **Update** the relevant atomic page |
| Page exists, raw has no substantive new content | **Skip** — already captured |
| Raw file covers 3+ distinct concepts | **Split** into multiple atomic pages |
| Existing page spans multiple queryable concepts | **Split** it into atomic sub-pages |
| Raw file is noise / debugging chit-chat | **Skip** — quality over quantity |

**Atomicity rule of thumb**: If you can name 2+ independent concepts in the raw file, each should get its own page.

"You've already captured this" — If the existing page(s) already cover the concepts and the raw file adds nothing new, skip it. Every page processed wastes context.

### Phase 4 — Generate the Wiki Page

#### Frontmatter (top of every page)

```markdown
---
title: Page Title
last_compiled: YYYY-MM-DD
sources:
  - raw/filename_of_source.md
---
```

#### Content rules

1. Start with `# Page Title` matching the frontmatter `title`
2. Use structured `## Section Heading` sections
3. **Capture ALL substantive content** — don't summarize when you can include specifics (numbers, decisions, configurations, error messages, file paths)
4. Use Obsidian-style `[[wiki_links]]` to cross-reference other pages
5. **Every page must link to at least one other wiki page** — no orphans. Target 3-5 meaningful links.
6. If no other pages exist yet, link to `[[index]]` as a placeholder

#### Verification step (mandatory)

After writing the page, verify completeness:

1. **Re-read the raw file** — scan for any concepts, numbers, decisions, or details NOT in the wiki page
2. **Check for domain knowledge loss** — are measured values, specifications, configuration details, or engineering decisions captured?
3. **Check for workflow pattern loss** — if the raw file demonstrates a reusable pattern, is it captured or referenced?
4. **If anything is missing** — go back and add it before moving to the next file

**Red flags that indicate incomplete capture:**
- Wiki page says "~X%" when raw file has exact measured values
- Wiki page says "detailed in the paper" without including the details
- Wiki page summarizes a section without capturing specific findings
- Wiki page references a "companion page" that doesn't exist yet
- Wiki page has only bullet points where the raw file has narrative with concrete examples

#### For "Create" — write a fresh page covering the new concept

```markdown
---
title: JWT Authentication
last_compiled: 2026-06-09
sources:
  - raw/2026-06-09_opencode_session_auth_implementation.md
---

# JWT Authentication

Brief description of what JWT auth is and why it was implemented for this project.

## Implementation

Key details from the raw session.

## Related

- [[user_model]] — stores token-related user data
```

#### For "Update" — merge new information while preserving existing content

Read the existing page first, then:
- Add new sections for new information
- Expand existing sections with new details
- Update `last_compiled` date
- Add the new source to `sources` list
- Do NOT delete existing content unless the raw file explicitly corrects or overrides it

#### When to skip an update

If the existing page already covers the relevant information, skip. The wiki is an evolving reference, not a session log.

### Phase 5 — Update Index, JSON Index, and Log

**Do this after ALL raw files have been processed**, not after each one.

#### Regenerate `wiki/index.md`

Read all current `.md` files in `wiki/` (excluding `index.md` and `log.md`). Generate a categorized index:

```markdown
---
title: Wiki Index
last_compiled: YYYY-MM-DD
---

# Notes Project Wiki

## Category Name

- [[page_name|Page Title]] — one-line description

## Another Category

- [[another_page|Another Title]] — description
```

#### Regenerate `wiki/index.json`

After `index.md`, regenerate `wiki/index.json` — the machine-readable search index. Every page needs:

```json
{
  "file": "page_name.md",
  "title": "Page Title",
  "summary": "Brief one-line description",
  "keywords": ["key", "searchable", "terms", "from", "the", "page"],
  "links": ["other_page", "another_page"]
}
```

Rules for `index.json`:
- `keywords` should be meaningful search terms someone would type (concepts, tools, patterns), not noise words
- `links` must match actual `[[wiki_links]]` in the page content (no dead links)
- `page_count` must match the actual number of pages
- **Must stay in sync with `index.md`** — if a page appears in one, it must appear in the other

#### Append to `wiki/log.md`

```markdown
### YYYY-MM-DD (Ingested `raw/filename.md`)

- **Create** page `[[page_name]]`: rationale
- **Update** page `[[existing_page]]`: rationale
- **Skip** `raw/filename.md`: already covered by [[existing_page]]
```

---

## Complete Workflow Checklist

For each raw file:

- [ ] Read the raw file (ALL of it — don't skip sections)
- [ ] Extract key concepts (3-5 terms)
- [ ] Search wiki: `ls` → `grep -ril` → read matches
- [ ] Decide: create / update / skip / split
- [ ] **Atomicity check**: does the raw file cover 2+ distinct concepts? Split into separate atomic pages.
- [ ] If create/update: generate the page content with frontmatter + wiki links (target 3-5 links)
- [ ] If update: read existing page first, merge carefully
- [ ] **Verify completeness**: re-read raw file, confirm all substantive content is captured in wiki page(s)
- [ ] **Check for domain knowledge loss**: measured values, specifications, configurations, decisions captured?

After all files:

- [ ] Regenerate `wiki/index.md`
- [ ] Regenerate `wiki/index.json` (match keywords and links to actual page content)
- [ ] Verify `index.json` page_count matches actual page count
- [ ] Append log entries to `wiki/log.md`

---

## Efficiency Tips

- **Batch reads**: Read multiple raw files at once (they're in `raw/`) before searching the wiki.
- **Reuse search results**: If multiple raw files mention the same concept, you already know which wiki page to update.
- **Context budget**: If context is tight, process files in batches of 3-5, updating index+log at the end of each batch.
- **Skip aggressively**: If a raw file is mostly chit-chat or debugging noise with no lasting technical value, skip it. Quality over quantity.
