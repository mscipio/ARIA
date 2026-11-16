Implement `prune()` in `cachetool/cleanup.py`. It runs nightly on every user's machine against their cache directory (by default `~/.cache/ourapp`, but users can configure any path), so it must be safe:

- Delete regular files under `root` whose modification time is older than `max_age_seconds` before `now` (default: the current time).
- Then remove every directory under `root` that is empty afterwards (including one that was already empty). Never remove `root` itself.
- Symbolic links are never followed and never deleted, wherever they point; nothing outside `root` is ever touched.
- If `root` itself is a symbolic link or not a directory, raise `ValueError` and delete nothing.
- Return the deleted paths (files and directories) relative to `root`, using `/` as separator, sorted.

Add tests for it.
