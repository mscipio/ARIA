# ARIA repository

This repo is the ARIA OpenCode v2 plugin plus its manager. Keep it small.

- Plugin: `src/*.ts(x)` (loaded directly by OpenCode/Bun; imports use `.ts` extensions; no build step). Prompts in `prompts/`, skills in `skills/`.
- Manager: `src/manager/` (Node >= 22.18, type stripping). `bin/aria.mjs` only launches it. The CLI (`cli.ts`) and the TUI (`ui.ts`) are thin: every mutation lives once in `install.ts`, `models.ts` or `deps.ts`, and every dependency once in `manifest.ts`.
- Mutations must offer a dry run that returns the exact changes, edit config only through `config.ts` (targeted JSONC edits, atomic, ownership-tracked), and never touch external installations.
- All filesystem access under `.aria/` goes through `src/safe-fs.ts`.
- Permission rules: read-only roles start from `deny("*")`; coding roles from `codingRules()`. Every non-built-in tool is covered by the tool gate.
- Check changes with `npm run typecheck` and `npm run lint`. Verify behaviour with disposable fixtures outside the repo (set `HOME`, `XDG_CONFIG_HOME`, `ARIA_HOME` to temporary directories).
- Do not create or modify automated tests, commit, push, publish, or install software unless asked.
- Keep `.aria/plans/aria2-implementation-map.md` truthful: a task is verified only with recorded evidence.
