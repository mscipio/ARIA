---
name: aria-investigate
description: Efficiently understand a repository or subsystem before changing it. Read-only method for locating the files that matter, conventions, tests, and the real behaviour, without scanning large data directories.
---

# Investigating a codebase

1. **Instructions first.** Read the README and any contributing or convention notes that apply to the area.
2. **Shape.** `glob` the top levels and the manifest files (package.json, pyproject.toml, environment.yml, *.m entry points, CMake/Makefile) to learn language, build, and test commands.
3. **Locate.** `grep` for the symbol, string, or behaviour; follow definitions and callers by reading, not guessing. Prefer a few full reads over many partial ones.
4. **Behaviour over names.** Confirm what code actually does; comments and names lie. Check how it is called and what the tests exercise.
5. **Conventions.** Note naming, error handling, typing, logging, and formatting used nearby, so changes match them.
6. **Tests and checks.** Find existing tests, linters, and type-checkers relevant to the area and how to run them.
7. **Large scientific repositories.** Do not glob or grep into data, output, or cache directories (images, volumes, .mat/.nii/.dcm/.npy, build trees). Identify them from the layout and `.gitignore`, then search source directories only. Treat datasets as read-only inputs.
8. **Report** what you found with `path:line`, what you did not check, and what remains uncertain. Absence in a partial search is not proof of absence.
