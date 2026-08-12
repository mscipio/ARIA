# Wiki Format Specification

## Page Structure

Every wiki page must include:
- YAML frontmatter with `title`, `last_compiled`, `sources`
- Structured headings: `# Title`, `## Section`, `### Subsection`
- Obsidian-style wiki links: `[[page_name]]` or `[[page_name|Display Text]]`
- Cross-links to at least 3-5 related pages

## Frontmatter Example

```yaml
---
title: Page Title
last_compiled: YYYY-MM-DD
sources:
  - raw/filename_of_source.md
---
```

## Linking Rules

- Every page MUST link to at least one other page (no orphans)
- Target 3-5 meaningful links per page
- Use `[[page_name]]` for internal links
- Use `[[page_name|Display Text]]` for custom link text
- **No filler links**: Only link to pages with a direct topical relationship. Don't link to infrastructure pages (like the archiver or compiler) from content pages just because they're part of the wiki.
- **Infrastructure links stay in infrastructure**: Wiki infrastructure pages (archiver, compiler, workflow) link to each other, but content pages only link to other content pages they directly relate to.

## Content Rules

- Capture ALL substantive content: numbers, decisions, configurations, measured values, bug details, file paths
- Don't summarize when you can include specifics
- Preserve existing content when updating (add, don't delete)
- Never modify `raw/` files — they're immutable source documents
