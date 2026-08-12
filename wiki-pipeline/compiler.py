import os
import re
import json
import sqlite3
import hashlib
import datetime
import sys


class WikiCompiler:
    def __init__(self, workspace_dir=None):
        """
        Initialize the Wiki Compiler.

        Requires WIKI_DIR to be set (via env or explicit argument).
        Fails clearly before creating any file or directory when WIKI_DIR is absent.

        Directories (raw/, wiki/, .state/) are created lazily by each
        operation — only when needed by the requested command.  Archive
        operations only create raw/ and .state/; compilation/promotion
        create wiki/ on demand.

        Parameters
        ----------
        workspace_dir : str or None
            Absolute path to the wiki project. Defaults to WIKI_DIR env var.
        """
        if workspace_dir is None:
            workspace_dir = os.environ.get("WIKI_DIR")
        if not workspace_dir:
            raise ValueError(
                "WIKI_DIR is not set.\n"
                "Set the WIKI_DIR environment variable to the wiki project root, "
                "or pass workspace_dir explicitly."
            )

        self.workspace_dir = workspace_dir

        # Primary paths — inside the wiki workspace
        self.raw_dir = os.path.join(workspace_dir, "raw")
        self.wiki_dir = os.path.join(workspace_dir, "wiki")

        # State directory for archive trackers and primer
        self.data_dir = os.path.join(workspace_dir, ".state")

    # ------------------------------------------------------------------ #
    #  Internal helpers
    # ------------------------------------------------------------------ #
    def _get_existing_wiki_files(self):
        """Return sorted list of .md files in wiki/ (excluding index & log)."""
        files = []
        if not os.path.isdir(self.wiki_dir):
            return files
        for f in os.listdir(self.wiki_dir):
            if f.endswith(".md") and f not in ("index.md", "log.md"):
                files.append(f)
        return sorted(files)

    # ------------------------------------------------------------------ #
    #  MD5 and frontmatter helpers
    # ------------------------------------------------------------------ #
    @staticmethod
    def _compute_md5(filepath):
        """Compute MD5 hex digest of a file's contents."""
        if not os.path.exists(filepath):
            return None
        hasher = hashlib.md5()
        with open(filepath, "rb") as f:
            for chunk in iter(lambda: f.read(8192), b""):
                hasher.update(chunk)
        return hasher.hexdigest()

    @staticmethod
    def _parse_frontmatter(content):
        """
        Parse YAML frontmatter from markdown content (delimited by ---).

        Returns (dict, body_string) where dict has parsed keys.
        Returns ({}, content) if no frontmatter.
        """
        if not content.startswith("---"):
            return {}, content

        parts = content.split("---", 2)
        if len(parts) < 3:
            return {}, content

        frontmatter_text = parts[1].strip()
        body = parts[2]

        fm = {}
        for line in frontmatter_text.split("\n"):
            line = line.strip()
            if ":" in line:
                key, _, value = line.partition(":")
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                fm[key] = value

        return fm, body

    # ------------------------------------------------------------------ #
    #  Linter
    # ------------------------------------------------------------------ #
    def lint(self):
        """Check for broken links and orphan pages."""
        existing_pages = self._get_existing_wiki_files()
        existing_names = [p[:-3] for p in existing_pages]

        broken = {}
        incoming = {name: [] for name in existing_names}

        for page in existing_pages:
            name = page[:-3]
            path = os.path.join(self.wiki_dir, page)
            with open(path, "r", encoding="utf-8") as f:
                content = f.read()
            links = re.findall(r'\[\[([a-zA-Z0-9_\-\s|]+)\]\]', content)
            for link in links:
                target = link.split('|')[0].strip().lower().replace(" ", "_")
                if target in ("index", "log", "instructions"):
                    continue
                if target not in existing_names:
                    broken.setdefault(name, []).append(target)
                else:
                    incoming[target].append(name)

        orphans = [n for n, sources in incoming.items() if not sources]

        # Print report
        print("\n🔧 Wiki Linter Report:")
        print("=====================")

        has_issues = bool(broken or orphans)
        if not has_issues:
            print("💚 All files linked perfectly! No broken links or orphans.")
        else:
            if broken:
                print("❌ Broken Links:")
                for page, targets in broken.items():
                    print(f"  - In [[{page}]] → missing: "
                          f"{', '.join(f'[[{t}]]' for t in targets)}")
            if orphans:
                print("⚠️ Orphans (no pages link to these):")
                for o in orphans:
                    print(f"  - `[[{o}]]`")

        return {
            "broken_links": broken,
            "orphans": orphans,
            "healthy": not has_issues,
        }

    # ------------------------------------------------------------------ #
    #  Context primer (for sub-agent invocation)
    # ------------------------------------------------------------------ #
    def generate_context_primer(
        self,
        output_path=None,
        max_mocs=200,
        log_tail_lines=20,
    ):
        """
        Generate wiki/.state/context-primer.md — a single-file context
        document for sub-agents. The primer contains the structural
        metadata of the wiki (MOC index, format cheatsheet, workflow
        state) so the agent does not have to read dozens of files or
        call expensive discovery tools to learn the wiki's shape.

        Returns the output path. Never raises to caller.
        """
        from pathlib import Path

        if output_path is None:
            output_path = os.path.join(self.data_dir, "context-primer.md")

        # Ensure .state/ exists (lazy — only created when primer runs)
        os.makedirs(self.data_dir, exist_ok=True)

        try:
            sections = []
            sections.append(self._primer_header())
            sections.append(self._primer_moc_index(max_mocs=max_mocs))
            sections.append(self._primer_format_cheatsheet())
            sections.append(self._primer_workflow_state(log_tail_lines=log_tail_lines))
            content = "\n\n".join(s for s in sections if s)
            Path(output_path).write_text(content, encoding="utf-8")
            return output_path
        except Exception as e:
            print(f"  ⚠ generate_context_primer failed: {e}")
            return output_path

    def _primer_header(self):
        """Header with last_generated timestamp and last compile date from log."""
        now = datetime.datetime.now().isoformat(timespec="seconds")
        log_path = os.path.join(self.wiki_dir, "log.md")
        last_compile = ""
        if os.path.exists(log_path):
            try:
                with open(log_path, encoding="utf-8") as f:
                    log_content = f.read()
                # Find dates from `### YYYY-MM-DD` headings.
                # The log is append-only at the bottom, so the MOST RECENT date
                # is the LAST match, not the first.
                date_pattern = re.compile(r"^###\s+(\d{4}-\d{2}-\d{2})", re.MULTILINE)
                dates = date_pattern.findall(log_content)
                if dates:
                    last_compile = dates[-1]
            except OSError:
                pass
        lines = [
            "# Wiki Context Primer",
            "",
            f"last_generated: {now}",
            f"last_compile: {last_compile or '(none recorded)'}",
        ]
        return "\n".join(lines)

    def _primer_moc_index(self, max_mocs=200):
        """MOC index: every wiki/moc_*.md, parsed for frontmatter + scope."""
        if not os.path.isdir(self.wiki_dir):
            return "## MOC Index\n\n(wiki directory not found)"
        moc_files = sorted(
            f for f in os.listdir(self.wiki_dir)
            if f.startswith("moc_") and f.endswith(".md")
        )[:max_mocs]
        hubs = []
        subs = []
        for fname in moc_files:
            fpath = os.path.join(self.wiki_dir, fname)
            try:
                with open(fpath, encoding="utf-8") as f:
                    content = f.read()
            except OSError:
                continue
            fm = self._safe_yaml(content)
            if not fm:
                continue
            name = fname[:-3]  # strip .md
            title = fm.get("title", name).strip("'\"")
            level = fm.get("level", "?")
            parent = fm.get("parent", "")
            parent_coll = fm.get("parent_collection", "")
            # First non-empty line of ## Scope
            scope_line = ""
            m = re.search(r"^##\s+Scope\s*\n+(.+?)$", content, re.MULTILINE)
            if m:
                scope_line = m.group(1).strip()[:120]
            try:
                size_kb = os.path.getsize(fpath) // 1024
            except OSError:
                size_kb = 0
            entry = {
                "name": name,
                "title": title,
                "scope": scope_line,
                "size_kb": size_kb,
                "parent": parent,
                "parent_coll": parent_coll,
            }
            if level == "hub":
                hubs.append(entry)
            else:
                subs.append(entry)
        lines = [
            f"## MOC Index ({len(mocs := hubs + subs)} total: {len(hubs)} hubs, {len(subs)} subs)",
            "",
        ]
        if hubs:
            lines.append("### Hub MOCs")
            lines.append("")
            for h in hubs:
                coll_part = f" — collection: `{h['parent_coll']}`" if h["parent_coll"] else ""
                lines.append(f"- **{h['name']}** — {h['title']}{coll_part} ({h['size_kb']} KB)")
                if h["scope"]:
                    lines.append(f"  - {h['scope']}")
            lines.append("")
        if subs:
            lines.append("### Sub MOCs")
            lines.append("")
            for s in subs:
                parent_part = f" — sub of `{s['parent']}`" if s["parent"] else ""
                lines.append(f"- **{s['name']}** — {s['title']}{parent_part} ({s['size_kb']} KB)")
                if s["scope"]:
                    lines.append(f"  - {s['scope']}")
            lines.append("")
        return "\n".join(lines)

    def _primer_format_cheatsheet(self):
        """Format cheatsheet extracted from real MOC files (not invented)."""
        lines = ["## Format Cheatsheet", ""]
        # Extract from 3 most-recently-edited MOCs
        moc_examples = self._extract_format_examples(
            directory=self.wiki_dir,
            pattern="moc_*.md",
            n=3,
        )
        if moc_examples:
            lines.append("### MOC frontmatter (extracted from existing files)")
            lines.append("")
            lines.append("```yaml")
            lines.append(moc_examples)
            lines.append("```")
            lines.append("")
        if not moc_examples:
            lines.append("(no examples found; primer incomplete)")
        return "\n".join(lines)

    def _primer_workflow_state(self, log_tail_lines=20):
        """Workflow state: tracker file sizes + log tail."""
        lines = ["## Workflow State", ""]
        # Tracker files
        if os.path.isdir(self.data_dir):
            lines.append("### Tracker files")
            lines.append("")
            for f in sorted(os.listdir(self.data_dir)):
                if f.endswith(".json"):
                    fpath = os.path.join(self.data_dir, f)
                    try:
                        size = os.path.getsize(fpath)
                        lines.append(f"- `.state/{f}` — {size} bytes")
                    except OSError:
                        pass
            lines.append("")
        # Log tail
        log_path = os.path.join(self.wiki_dir, "log.md")
        if os.path.exists(log_path):
            try:
                with open(log_path, encoding="utf-8") as f:
                    log_content = f.read().splitlines()
                tail = log_content[-log_tail_lines:] if log_tail_lines > 0 else []
                lines.append(f"### Recent log.md tail (last {len(tail)} lines)")
                lines.append("")
                lines.append("```")
                lines.extend(tail)
                lines.append("```")
            except OSError:
                lines.append("### Recent log.md tail")
                lines.append("")
                lines.append("(could not read log.md)")
        return "\n".join(lines)

    # ------------------------------------------------------------------ #
    #  Primer helpers (internal)
    # ------------------------------------------------------------------ #
    def _safe_yaml(self, content):
        """Parse YAML frontmatter. Returns dict (possibly empty) or None on error."""
        if not content.startswith("---"):
            return {}
        parts = content.split("---", 2)
        if len(parts) < 3:
            return {}
        fm_text = parts[1].strip()
        # Simple parser (matches _parse_frontmatter)
        fm = {}
        for line in fm_text.split("\n"):
            line = line.strip()
            if ":" in line and not line.startswith("-"):
                key, _, value = line.partition(":")
                fm[key.strip()] = value.strip().strip("'\"").strip()
        return fm

    def _extract_format_examples(self, directory, pattern, n=3):
        """Extract YAML frontmatter examples from N most-recently-edited files."""
        if not os.path.isdir(directory):
            return ""
        try:
            all_files = [
                f for f in os.listdir(directory)
                if f.endswith(".md") and self._fnmatch(f, pattern)
            ]
        except OSError:
            return ""
        if not all_files:
            return ""
        # Sort by mtime
        try:
            with_mtime = [
                (f, os.path.getmtime(os.path.join(directory, f)))
                for f in all_files
            ]
            with_mtime.sort(key=lambda x: x[1], reverse=True)
            recent = [f for f, _ in with_mtime[:n]]
        except OSError:
            recent = all_files[:n]
        # Aggregate keys
        all_keys = {}  # key -> count
        examples = {}
        for fname in recent:
            fpath = os.path.join(directory, fname)
            try:
                with open(fpath, encoding="utf-8") as f:
                    content = f.read()
            except OSError:
                continue
            fm = self._safe_yaml(content)
            if not fm:
                continue
            for k in fm:
                all_keys[k] = all_keys.get(k, 0) + 1
            examples[fname] = fm
        # Keep only keys present in >=50% of files
        threshold = max(1, len(recent) // 2)
        common_keys = [k for k, c in all_keys.items() if c >= threshold]
        if not common_keys:
            return ""
        # Build example from first available file
        first_fname = recent[0]
        first_fm = examples.get(first_fname, {})
        lines = []
        for key in common_keys:
            value = first_fm.get(key, "")
            if isinstance(value, str):
                # Quote if needed
                if any(ch in value for ch in [":", "#", "&", "*", "[", "]", "{", "}", "\"", "'"]):
                    value = f'"{value}"'
            lines.append(f"{key}: {value}")
        return "\n".join(lines)

    @staticmethod
    def _fnmatch(name, pattern):
        """Minimal fnmatch implementation (avoid importing fnmatch for a single check)."""
        import fnmatch
        return fnmatch.fnmatch(name, pattern)

    # ------------------------------------------------------------------ #
    #  Archive OpenCode agent sessions into the wiki
    # ------------------------------------------------------------------ #
    def archive_opencode(self, db_path=None, limit=None):
        """
        Connect to the OpenCode SQLite database, discover ALL sessions
        (no project filter), format each as structured Markdown,
        write to raw/, and track already-archived sessions so repeated
        runs only pick up new ones.

        Archived session IDs are tracked in .state/archived_sessions.json.

        Compilation into wiki pages is handled separately by the
        archivist specialist, which reads from raw/, plans and
        compiles pages, and writes to wiki/.

        Parameters
        ----------
        db_path : str or None
            Path to opencode.db. Default: ~/.local/share/opencode/opencode.db.
        limit : int or None
            Max sessions to fetch (None = no limit).

        Returns
        -------
        list[str]
            List of filenames saved to raw/.
        """
        # --- Default path ---
        if db_path is None:
            db_path = os.path.expanduser(
                "~/.local/share/opencode/opencode.db"
            )

        # --- Validate DB exists ---
        if not os.path.exists(db_path):
            raise FileNotFoundError(
                f"OpenCode database not found at:\n"
                f"  {db_path}\n"
                "Verify opencode is installed and has been used at least once."
            )

        # --- Ensure raw/ exists (lazy — only created for archive) ---
        os.makedirs(self.raw_dir, exist_ok=True)

        # --- Connect ---
        conn = None
        try:
            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
        except PermissionError:
            raise PermissionError(
                f"Permission denied reading OpenCode database:\n"
                f"  {db_path}\n"
                f"Try: chmod +r '{db_path}'"
            )
        except sqlite3.OperationalError as e:
            raise RuntimeError(
                f"Cannot open OpenCode database:\n"
                f"  {e}\n"
                "The database may be locked. Wait and try again."
            )

        try:
            # ---------------------------------------------------------- #
            #  Schema probe (handle drift)
            # ---------------------------------------------------------- #
            required_tables = {
                "session": {
                    "id", "project_id", "title", "agent", "model",
                    "directory", "path", "time_created", "time_updated",
                },
                "message": {
                    "id", "session_id",
                    "time_created", "time_updated", "data",
                },
                "part": {
                    "id", "message_id", "session_id",
                    "time_created", "time_updated", "data",
                },
            }

            for table, expected_cols in required_tables.items():
                cur = conn.execute(f"PRAGMA table_info({table})")
                actual_cols = {row["name"] for row in cur.fetchall()}
                if not actual_cols:
                    raise ValueError(
                        f"Required table '{table}' not found in "
                        f"OpenCode database.\n"
                        "The database schema may have changed."
                    )
                missing = expected_cols - actual_cols
                if missing:
                    raise ValueError(
                        f"Required columns missing from table "
                        f"'{table}': {', '.join(sorted(missing))}\n"
                        "The OpenCode database schema may have changed."
                    )

            # ---------------------------------------------------------- #
            #  Load previously archived session IDs
            # ---------------------------------------------------------- #
            archive_tracker = os.path.join(
                self.data_dir, "archived_sessions.json"
            )
            archived_ids = set()
            if os.path.exists(archive_tracker):
                try:
                    with open(archive_tracker, "r", encoding="utf-8") as f:
                        data = json.load(f)
                        archived_ids = set(data.get("session_ids", []))
                except (json.JSONDecodeError, OSError):
                    print("  ⚠ Could not read archive tracker, starting fresh.")

            # ---------------------------------------------------------- #
            #  Get ALL sessions (no project filter), newest first
            # ---------------------------------------------------------- #
            sql = """SELECT id, project_id, title, agent, model,
                            directory, path,
                            time_created, time_updated
                     FROM session
                     ORDER BY time_created DESC"""
            params = []
            if limit is not None:
                sql += " LIMIT ?"
                params.append(limit)
            cur = conn.execute(sql, params)
            all_rows = cur.fetchall()

            # Filter out already-archived sessions
            session_rows = [
                row for row in all_rows
                if row["id"] not in archived_ids
            ]

            if not session_rows:
                total = len(all_rows)
                archived = len(archived_ids)
                print(
                    f"All {archived}/{total} sessions already archived. "
                    "Nothing new to do."
                )
                return []

            # ---------------------------------------------------------- #
            #  Helpers
            # ---------------------------------------------------------- #
            def _ts_to_date(ts):
                """Convert unix-millis timestamp to YYYY-MM-DD string."""
                if not ts:
                    return ""
                try:
                    dt = datetime.datetime.fromtimestamp(ts / 1000)
                    return dt.strftime("%Y-%m-%d")
                except (ValueError, OSError):
                    return str(ts)

            def _ts_to_iso(ts):
                """Convert unix-millis timestamp to ISO-8601 string."""
                if not ts:
                    return ""
                try:
                    dt = datetime.datetime.fromtimestamp(ts / 1000)
                    return dt.isoformat()
                except (ValueError, OSError):
                    return str(ts)

            def _ts_to_time(ts):
                """Convert unix-millis timestamp to HH:MM string."""
                if not ts:
                    return ""
                try:
                    dt = datetime.datetime.fromtimestamp(ts / 1000)
                    return dt.strftime("%H:%M")
                except (ValueError, OSError):
                    return str(ts)

            def _hex_encode_session_id(sid):
                """Return a reversible, collision-free UTF-8 hex encoding
                of the session ID.  Decode with bytes.fromhex(encoded)."""
                return sid.encode("utf-8").hex()

            def _make_slug(title, session_id):
                """Create a filesystem-safe slug from a title."""
                s = title.lower().replace(" ", "_")
                s = re.sub(r"[^a-z0-9_-]", "", s)
                s = s[:40]
                if not s:
                    s = f"session_{_hex_encode_session_id(session_id)}"
                return s

            # ---------------------------------------------------------- #
            #  Build exchanges per session, write markdown, ingest
            # ---------------------------------------------------------- #
            all_ops = []

            for session_row in session_rows:
                sid = session_row["id"]
                title = session_row["title"] or "Untitled"
                agent = session_row["agent"] or ""
                model = session_row["model"] or ""
                ts_created = session_row["time_created"]
                ts_updated = session_row["time_updated"]

                created_date = _ts_to_date(ts_created)
                created_iso = _ts_to_iso(ts_created)

                # -- Get messages for this session --
                cur.execute(
                    "SELECT id, session_id, "
                    "       time_created, time_updated, data "
                    "FROM message "
                    "WHERE session_id = ? "
                    "ORDER BY time_created ASC",
                    (sid,),
                )
                message_rows = cur.fetchall()

                # -- Build structured exchanges --
                exchanges = []
                for msg in message_rows:
                    # Parse message data for role
                    try:
                        msg_data = json.loads(msg["data"])
                    except json.JSONDecodeError:
                        print(
                            f"  ⚠ Invalid JSON in message "
                            f"{msg['id']}, skipping."
                        )
                        continue

                    role = msg_data.get("role", "unknown")
                    msg_ts = msg["time_created"]
                    msg_time = _ts_to_time(msg_ts)

                    # Get parts for this message (actual content)
                    cur.execute(
                        "SELECT id, message_id, session_id, "
                        "       time_created, time_updated, data "
                        "FROM part "
                        "WHERE message_id = ? "
                        "ORDER BY time_created ASC",
                        (msg["id"],),
                    )
                    part_rows = cur.fetchall()

                    text_blocks = []
                    tool_blocks = []

                    for part in part_rows:
                        try:
                            pdata = json.loads(part["data"])
                        except json.JSONDecodeError:
                            continue

                        ptype = pdata.get("type")

                        if ptype == "text":
                            text = pdata.get("text", "")
                            if text and text.strip():
                                text_blocks.append(text.strip())

                        elif ptype == "tool":
                            tool_name = pdata.get("tool", "unknown")
                            state = pdata.get("state", {})
                            inp = state.get("input", "")
                            out = state.get("output", "")
                            if isinstance(inp, dict):
                                inp = json.dumps(
                                    inp, indent=2, default=str
                                )
                            if isinstance(out, dict):
                                out = json.dumps(
                                    out, indent=2, default=str
                                )
                            tool_blocks.append({
                                "name": tool_name,
                                "input": str(inp) if inp else "",
                                "output": str(out) if out else "",
                            })

                        # Skip reasoning, file, tool-result parts
                        # for brevity in the raw markdown.

                    exchanges.append({
                        "role": role,
                        "time_label": msg_time,
                        "content": "\n\n".join(text_blocks),
                        "tool_calls": tool_blocks,
                    })

                # -- Write markdown file --
                slug = _make_slug(title, sid)
                hex_sid = _hex_encode_session_id(sid)
                md_filename = (
                    f"{created_date}_opencode_session_{hex_sid}_{slug}.md"
                )
                md_path = os.path.join(self.raw_dir, md_filename)

                lines = []

                # Frontmatter
                lines.append("---")
                lines.append(f'title: "{title}"')
                lines.append("source: opencode-session")
                lines.append(f'session_id: "{sid}"')
                if agent:
                    lines.append(f'agent: "{agent}"')
                if model:
                    lines.append(f'model: "{model}"')
                lines.append(f'date: "{created_iso}"')
                lines.append("---")
                lines.append("")

                # Session header
                lines.append(f"## Session: {title}")
                lines.append("")
                if agent:
                    lines.append(f"- **Agent**: {agent}")
                if model:
                    lines.append(f"- **Model**: {model}")
                lines.append(f"- **Date**: {created_date}")
                lines.append(f"- **Messages**: {len(exchanges)}")
                lines.append("")

                # Messages
                lines.append("### Messages")
                lines.append("")

                for ex in exchanges:
                    if ex["role"] == "user":
                        label = "User"
                    elif ex["role"] == "assistant":
                        label = "Assistant"
                    else:
                        label = ex["role"].capitalize()

                    ts_tag = (
                        f" ({ex['time_label']})"
                        if ex["time_label"]
                        else ""
                    )
                    lines.append(f"#### {label}{ts_tag}")
                    lines.append("")

                    if ex["content"]:
                        lines.append(ex["content"])
                        lines.append("")

                    for tc in ex["tool_calls"]:
                        lines.append(f"**Tool: {tc['name']}**")
                        lines.append("")
                        if tc["input"]:
                            lines.append("Input:")
                            lines.append("```")
                            lines.append(tc["input"])
                            lines.append("```")
                            lines.append("")
                        if tc["output"]:
                            lines.append("Output:")
                            lines.append("```")
                            lines.append(tc["output"])
                            lines.append("```")
                            lines.append("")

                    lines.append("---")
                    lines.append("")

                content = "\n".join(lines).strip()
                if not content:
                    print(
                        f"  ⚠ Empty content for session {sid}, "
                        f"skipping write."
                    )
                    continue

                # Never overwrite an existing raw provenance file.
                # Do NOT mark as archived here — if the existing target is
                # ambiguous (e.g. same session re-run), the session may
                # still need archival under a distinct filename.
                if os.path.exists(md_path):
                    print(
                        f"  ⚠ Raw file already exists, "
                        f"skipping (never overwrite): {md_filename}"
                    )
                    continue

                with open(md_path, "w", encoding="utf-8") as f:
                    f.write(content)
                    f.write("\n")

                print(f"📝 Saved session: {md_filename}")
                all_ops.append(md_filename)
                # Track this session as archived
                archived_ids.add(sid)

            # Persist archive tracker
            try:
                os.makedirs(os.path.dirname(archive_tracker), exist_ok=True)
                with open(archive_tracker, "w", encoding="utf-8") as f:
                    json.dump(
                        {"session_ids": sorted(archived_ids)},
                        f, indent=2,
                    )
            except OSError as e:
                print(f"  ⚠ Could not save archive tracker: {e}")

            return all_ops

        finally:
            if conn:
                conn.close()

    # ------------------------------------------------------------------ #
    #  Archive Engram observations into the wiki
    # ------------------------------------------------------------------ #
    def _probe_engram_schema(self, conn):
        """
        Probe the Engram DB schema via PRAGMA table_info(observations).

        Required columns: id, type, title, content
        Optional columns detected: topic_key, scope, project, created_at

        Returns dict[str, str] mapping column name to type.
        Raises ValueError if any required column is missing.
        """
        required = {"id", "type", "title", "content"}
        optional = {"topic_key", "scope", "project", "created_at"}

        cur = conn.execute("PRAGMA table_info(observations)")
        actual_cols = {}
        for row in cur.fetchall():
            actual_cols[row["name"]] = row["type"]

        if not actual_cols:
            raise ValueError(
                "Required table 'observations' not found in Engram database."
            )

        missing = required - set(actual_cols.keys())
        if missing:
            raise ValueError(
                "Missing required columns in 'observations' table: "
                f"{', '.join(sorted(missing))}\n"
                "The Engram database schema may have changed."
            )

        return actual_cols

    @staticmethod
    def _make_slug_engram(title, obs_id):
        """
        Create a filesystem-safe slug from an observation title.
        Falls back to 'observation_{obs_id}' if the slug is empty.

        Slug: lowercase, spaces→underscores, strip non-[a-z0-9_-],
        truncated at 40 chars.
        """
        slug = title.lower().replace(" ", "_")
        slug = re.sub(r"[^a-z0-9_-]", "", slug)
        slug = slug[:40]
        if not slug:
            slug = f"observation_{obs_id}"
        return slug

    def _format_observation_md(self, obs):
        """
        Format an observation sqlite3.Row as markdown with YAML frontmatter.

        Returns (filename, content_string) where filename is an immutable
        observation-ID filename (engram_<id>.md) — title/date are kept
        only as frontmatter metadata so metadata changes cannot create
        duplicate raw files.
        """
        title = obs["title"] or "Untitled"
        obs_id = obs["id"]
        obs_type = obs["type"] or ""
        topic_key = obs["topic_key"] or ""
        scope_val = obs["scope"] or "project"
        project = obs["project"] or ""
        created_at = obs["created_at"] or ""
        content = obs["content"] or ""

        # Immutable filename derived from observation ID alone.
        filename = f"engram_{obs_id}.md"

        lines = [
            "---",
            f'title: "{title}"',
            "source: engram",
            f"observation_id: {obs_id}",
            f'type: "{obs_type}"',
            f'topic_key: "{topic_key}"',
            f'scope: "{scope_val}"',
            f'project: "{project}"',
            f'date: "{created_at}"',
            "---",
            "",
            f"## Observation: {title}",
            "",
            f"**Type**: {obs_type}  ",
            f"**Project**: {project or '—'}  ",
            f"**Topic**: {topic_key or '—'}  ",
            f"**Created**: {created_at or '—'}",
            "",
            content,
        ]

        return filename, "\n".join(lines)

    def _load_engram_tracker(self):
        """
        Load the set of already-archived observation IDs from the tracker JSON.

        The tracker is stored at data_dir/engram-archive-tracker.json.
        Returns an empty set if the file is missing or corrupt.
        """
        tracker_path = os.path.join(
            self.data_dir, "engram-archive-tracker.json"
        )
        if not os.path.exists(tracker_path):
            return set()

        try:
            with open(tracker_path, "r", encoding="utf-8") as f:
                data = json.load(f)
                ids = data.get("observation_ids", [])
                return set(ids)
        except (json.JSONDecodeError, OSError):
            print(
                "  ⚠ Could not read engram archive tracker, "
                "starting fresh."
            )
            return set()

    def _save_engram_tracker(self, ids):
        """
        Save the set of archived observation IDs to the tracker JSON.
        Creates parent directory if missing.

        Format: {"observation_ids": [...], "last_updated": "<ISO datetime>"}
        """
        tracker_path = os.path.join(
            self.data_dir, "engram-archive-tracker.json"
        )
        os.makedirs(os.path.dirname(tracker_path), exist_ok=True)
        now = datetime.datetime.now().isoformat()
        with open(tracker_path, "w", encoding="utf-8") as f:
            json.dump(
                {
                    "observation_ids": sorted(ids),
                    "last_updated": now,
                },
                f, indent=2,
            )

    def archive_engram(self, db_path=None, dry_run=False):
        """
        Connect to the Engram SQLite database, read observations,
        format as structured Markdown, and write to raw/.

        Tracks archived observation IDs across runs via
        data_dir/engram-archive-tracker.json so repeated runs
        only pick up new observations.

        Parameters
        ----------
        db_path : str or None
            Path to engram.db. Default: ~/.engram/engram.db.
        dry_run : bool
            If True, print titles that would be archived but do not
            write files or update the tracker.

        Returns
        -------
        int
            Number of files written (0 in dry-run mode).
        """
        # --- Default path ---
        if db_path is None:
            db_path = os.path.expanduser("~/.engram/engram.db")

        # --- Validate DB exists ---
        if not os.path.exists(db_path):
            raise FileNotFoundError(
                f"Engram database not found at:\n"
                f"  {db_path}\n"
                "Searched paths: ~/.engram/engram.db\n"
                "Verify Engram is installed and has been used at least once."
            )

        # --- Ensure raw/ exists (lazy — only created for archive) ---
        os.makedirs(self.raw_dir, exist_ok=True)

        # --- Connect ---
        conn = None
        try:
            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
        except PermissionError:
            raise PermissionError(
                f"Permission denied reading Engram database:\n"
                f"  {db_path}\n"
                f"Try: chmod +r '{db_path}'"
            )
        except sqlite3.OperationalError as e:
            raise RuntimeError(
                f"Cannot open Engram database:\n"
                f"  {e}\n"
                "The database may be locked. Wait and try again."
            )

        try:
            # ---------------------------------------------------------- #
            #  Schema probe
            # ---------------------------------------------------------- #
            self._probe_engram_schema(conn)

            # ---------------------------------------------------------- #
            #  Load archive tracker
            # ---------------------------------------------------------- #
            archived_ids = self._load_engram_tracker()

            # ---------------------------------------------------------- #
            #  Query all observations
            # ---------------------------------------------------------- #
            cur = conn.execute(
                "SELECT id, type, title, content, topic_key, "
                "       scope, project, created_at "
                "FROM observations "
                "ORDER BY id ASC"
            )
            all_rows = cur.fetchall()

            # Filter out already-archived
            new_rows = [
                row for row in all_rows
                if row["id"] not in archived_ids
            ]

            total = len(all_rows)
            archived_count = len(archived_ids)

            if not new_rows:
                print(
                    f"All {archived_count}/{total} observations "
                    "already archived."
                )
                return 0

            if dry_run:
                print(
                    f"Engram: {len(new_rows)} new observation(s) "
                    f"would be archived (of {total} total):"
                )
                for row in new_rows:
                    title_str = row["title"] or "Untitled"
                    print(f"  - [{row['id']}] {title_str}")
                return 0

            # ---------------------------------------------------------- #
            #  Format and write each observation
            # ---------------------------------------------------------- #
            written = 0
            skipped = 0

            for row in new_rows:
                try:
                    filename, md_content = self._format_observation_md(row)
                except Exception as e:
                    print(
                        f"  ⚠ Error formatting observation "
                        f"{row['id']}: {e}",
                        file=sys.stderr,
                    )
                    skipped += 1
                    continue

                if not md_content.strip():
                    print(
                        f"  ⚠ Empty content for observation "
                        f"{row['id']}, skipping.",
                        file=sys.stderr,
                    )
                    skipped += 1
                    continue

                md_path = os.path.join(self.raw_dir, filename)

                # Never overwrite an existing raw provenance file.
                # Do NOT mark as archived here — if the existing target is
                # ambiguous (e.g. same observation, stale tracker), the
                # observation may still need archival under a distinct filename.
                if os.path.exists(md_path):
                    print(
                        f"  ⚠ Raw file already exists, "
                        f"skipping (never overwrite): {filename}"
                    )
                    skipped += 1
                    continue

                with open(md_path, "w", encoding="utf-8") as f:
                    f.write(md_content)
                    f.write("\n")

                print(f"📝 Saved observation: {filename}")
                written += 1
                archived_ids.add(row["id"])

            # ---------------------------------------------------------- #
            #  Save tracker (only when at least one file was written)
            # ---------------------------------------------------------- #
            if written > 0:
                self._save_engram_tracker(archived_ids)

            if skipped:
                print(
                    f"⚠ Skipped {skipped} corrupt observation(s).",
                    file=sys.stderr,
                )

            print(
                f"✅ Archived {written} new observation(s) "
                f"(tracker now has {len(archived_ids)}/{total})."
            )
            return written

        finally:
            if conn:
                conn.close()


# ------------------------------------------------------------------ #
#  CLI entry point
# ------------------------------------------------------------------ #
def main(argv=None):
    """
    CLI entry point for the Wiki Pipeline.

    Usage:

        # Search the wiki index (read-only, no WikiCompiler)
        python run.py search "query terms" [--type wiki]

        # Archive ALL sources (opencode + engram) to raw/
        python run.py archive-all

        # Archive OpenCode sessions from the local opencode DB to raw/
        python run.py archive-opencode [--db-path PATH] [--all | --limit N]

        # Archive Engram observations from ~/.engram/engram.db to raw/
        python run.py archive-engram [--db-path PATH] [--dry-run]

        # Lint the wiki for broken links and orphans
        python run.py lint

        # Regenerate the wiki context primer (single-file context for sub-agents)
        python run.py primer
    """
    if argv is None:
        argv = sys.argv

    if len(argv) < 2 or argv[1] in ("--help", "-h"):
        print(main.__doc__)
        sys.exit(1 if len(argv) < 2 else 0)

    command = argv[1]

    if command == "archive-opencode":
        # python run.py archive-opencode [--db-path PATH | --db-path=PATH] [--all | --limit N]
        db_path = None
        limit = 100  # default
        args = argv[2:]
        i = 0
        while i < len(args):
            a = args[i]
            if a.startswith("--db-path="):
                db_path = a.split("=", 1)[1]
            elif a == "--db-path" and i + 1 < len(args):
                db_path = args[i + 1]
                i += 1
            elif a == "--all":
                limit = None
            elif a.startswith("--limit="):
                limit = int(a.split("=", 1)[1])
            elif a == "--limit" and i + 1 < len(args):
                limit = int(args[i + 1])
                i += 1
            elif not a.startswith("--"):
                db_path = a
            i += 1
        compiler = WikiCompiler()
        compiler.archive_opencode(db_path=db_path, limit=limit)

    elif command == "archive-engram":
        # python run.py archive-engram [--db-path PATH] [--dry-run]
        db_path = None
        dry_run = False
        args = argv[2:]
        i = 0
        while i < len(args):
            a = args[i]
            if a.startswith("--db-path="):
                db_path = a.split("=", 1)[1]
            elif a == "--db-path" and i + 1 < len(args):
                db_path = args[i + 1]
                i += 1
            elif a == "--dry-run":
                dry_run = True
            elif not a.startswith("--"):
                db_path = a
            i += 1
        compiler = WikiCompiler()
        compiler.archive_engram(db_path=db_path, dry_run=dry_run)

    elif command == "archive-all":
        """Run all archive commands: opencode sessions + engram observations."""
        compiler = WikiCompiler()
        print("=" * 50)
        print("📦 archive-all: OpenCode sessions")
        print("=" * 50)
        compiler.archive_opencode()
        print()
        print("=" * 50)
        print("📦 archive-all: Engram observations")
        print("=" * 50)
        compiler.archive_engram()
        print()
        print("✅ archive-all complete.")

    elif command == "lint":
        compiler = WikiCompiler()
        compiler.lint()

    elif command == "search":
        # Read-only: no WikiCompiler, no writes, no primer access.
        # python run.py search "query terms" [--type TYPE]
        from search import search_index
        args = argv[2:]
        query_parts = []
        search_type = None
        i = 0
        while i < len(args):
            a = args[i]
            if a.startswith("--type="):
                search_type = a.split("=", 1)[1]
            elif a == "--type" and i + 1 < len(args):
                search_type = args[i + 1]
                i += 1
            elif not a.startswith("--"):
                query_parts.append(a)
            i += 1

        query = " ".join(query_parts)
        if not query:
            print("Error: search requires a query string.", file=sys.stderr)
            sys.exit(1)

        types = [search_type] if search_type else None
        results = search_index(query, types=types)

        if not results:
            print("No results found.")
        else:
            for r in results:
                print(
                    f"{r.get('file', '?')}  "
                    f"{r.get('title', '(untitled)')}  "
                    f"{r.get('type', '-')}"
                )

    elif command == "primer":
        # python run.py primer — regenerate wiki/.state/context-primer.md
        compiler = WikiCompiler()
        path = compiler.generate_context_primer()
        try:
            size = os.path.getsize(path)
        except OSError:
            size = 0
        print(f"✓ Context primer written: {path} ({size} bytes)")

    else:
        print(f"Unknown command: {command}")
        print(main.__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
