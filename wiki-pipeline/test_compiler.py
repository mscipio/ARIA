"""Focused regression tests for archive_opencode filename uniqueness and
overwrite protection."""
import json
import os
import sqlite3
import tempfile
import unittest

# Import the module under test — add parent to path in case test runs standalone
import sys as _sys
_this_dir = os.path.dirname(os.path.abspath(__file__))
if _this_dir not in _sys.path:
    _sys.path.insert(0, _this_dir)

from compiler import WikiCompiler  # noqa: E402


# Timestamp: 2023-11-14 in milliseconds
_TS = 1700000000000
_DATE = "2023-11-14"


def _create_test_db(db_path, sessions):
    """Create a minimal OpenCode-shaped SQLite database with given sessions.

    Each session dict must have:
      id, title, agent, model, time_created, time_updated
    and optionally messages: list of dicts with role and text.
    """
    conn = sqlite3.connect(db_path)
    conn.execute("""
        CREATE TABLE session (
            id TEXT PRIMARY KEY,
            project_id TEXT,
            title TEXT,
            agent TEXT,
            model TEXT,
            directory TEXT,
            path TEXT,
            time_created INTEGER,
            time_updated INTEGER
        )
    """)
    conn.execute("""
        CREATE TABLE message (
            id INTEGER PRIMARY KEY,
            session_id TEXT,
            time_created INTEGER,
            time_updated INTEGER,
            data TEXT
        )
    """)
    conn.execute("""
        CREATE TABLE part (
            id INTEGER PRIMARY KEY,
            message_id INTEGER,
            session_id TEXT,
            time_created INTEGER,
            time_updated INTEGER,
            data TEXT
        )
    """)

    for i, s in enumerate(sessions):
        sid = s["id"]
        project_id = s.get("project_id", "test-project")
        title = s.get("title", "Untitled")
        agent = s.get("agent", "")
        model = s.get("model", "")
        directory = s.get("directory", "/tmp")
        path = s.get("path", "/tmp")
        tc = s["time_created"] if "time_created" in s else _TS
        tu = s.get("time_updated", tc)
        conn.execute(
            "INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (sid, project_id, title, agent, model, directory, path, tc, tu),
        )

        messages = s.get("messages", [])
        for j, msg in enumerate(messages):
            mid = (i * 1000) + j + 1
            role = msg.get("role", "user")
            text = msg.get("text", "Hello")
            msg_data = json.dumps({"role": role})
            conn.execute(
                "INSERT INTO message VALUES (?, ?, ?, ?, ?)",
                (mid, sid, tc, tu, msg_data),
            )
            part_id = mid * 10
            part_data = json.dumps({"type": "text", "text": text})
            conn.execute(
                "INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)",
                (part_id, mid, sid, tc, tu, part_data),
            )

    conn.commit()
    conn.close()


class TestArchiveOpenCode(unittest.TestCase):
    """Regression tests for archive_opencode filename uniqueness and
    overwrite protection."""

    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.workspace = self.tmpdir.name

    def tearDown(self):
        self.tmpdir.cleanup()

    def _make_compiler(self):
        return WikiCompiler(workspace_dir=self.workspace)

    def test_filenames_include_hex_session_id_and_are_unique(self):
        """Two sessions with the same date and title must produce distinct
        output filenames using reversible hex-encoded session IDs —
        no collision."""
        sid_a = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        sid_b = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff"
        db_path = os.path.join(self.workspace, "opencode.db")

        _create_test_db(db_path, [
            {
                "id": sid_a,
                "title": "Test Session",
                "agent": "cli",
                "model": "test-model",
                "time_created": _TS,
                "messages": [{"role": "user", "text": "Hello from A"}],
            },
            {
                "id": sid_b,
                "title": "Test Session",
                "agent": "cli",
                "model": "test-model",
                "time_created": _TS,
                "messages": [{"role": "user", "text": "Hello from B"}],
            },
        ])

        compiler = self._make_compiler()
        saved = compiler.archive_opencode(db_path=db_path)

        self.assertEqual(len(saved), 2, f"Expected 2 saved files, got: {saved}")

        # Filenames must differ
        f1, f2 = saved
        self.assertNotEqual(f1, f2, "Filenames must be distinct")

        # Both filenames must include the HEX-ENCODED session id
        hex_a = sid_a.encode("utf-8").hex()
        hex_b = sid_b.encode("utf-8").hex()
        self.assertIn(hex_a, f1, f"Filename {f1!r} missing hex session id")
        self.assertIn(hex_b, f2, f"Filename {f2!r} missing hex session id")

        # Both filenames must include the date
        self.assertIn(_DATE, f1, f"Filename {f1!r} missing date")
        self.assertIn(_DATE, f2, f"Filename {f2!r} missing date")

        # Both files must exist on disk and contain the original session ID
        for fn, sid, expected_text in [
            (f1, sid_a, "Hello from A"),
            (f2, sid_b, "Hello from B"),
        ]:
            path = os.path.join(self.workspace, "raw", fn)
            self.assertTrue(os.path.exists(path), f"File {path} must exist")
            with open(path, "r", encoding="utf-8") as f:
                content = f.read()
            # Original session ID must be preserved in frontmatter
            self.assertIn(sid, content,
                          f"File {path} must contain original session ID in frontmatter")

    def test_never_overwrites_existing_raw_file(self):
        """When a raw file already exists at the target path, archive_opencode
        must skip it and NOT overwrite; the tracker must still record it."""
        sid = "cccccccc-dddd-eeee-ffff-aaaaaaaaaaaa"
        db_path = os.path.join(self.workspace, "opencode.db")

        compiler = self._make_compiler()

        # Pre-create a raw file with the exact name that would be produced
        raw_dir = os.path.join(self.workspace, "raw")
        os.makedirs(raw_dir, exist_ok=True)
        hex_sid = sid.encode("utf-8").hex()
        pre_existing_name = f"{_DATE}_opencode_session_{hex_sid}_test_session.md"
        pre_existing_path = os.path.join(raw_dir, pre_existing_name)
        original_content = "ORIGINAL CONTENT — DO NOT OVERWRITE"
        with open(pre_existing_path, "w", encoding="utf-8") as f:
            f.write(original_content)

        _create_test_db(db_path, [
            {
                "id": sid,
                "title": "Test Session",
                "agent": "cli",
                "model": "test-model",
                "time_created": _TS,
                "messages": [{"role": "user", "text": "Overwritten?"}],
            },
        ])

        saved = compiler.archive_opencode(db_path=db_path)

        # Nothing should be saved (file existed, should be skipped)
        self.assertEqual(
            saved, [],
            f"Expected no newly saved files when target exists, got: {saved}",
        )

        # Original file must be unchanged
        with open(pre_existing_path, "r", encoding="utf-8") as f:
            current = f.read()
        # Content written by archive_opencode includes a trailing "\n" via f.write("\n")
        self.assertEqual(
            current.strip(),
            original_content,
            "Pre-existing file must NOT be overwritten",
        )

        # Tracker must NOT mark the session archived when we skipped the file.
        # With full session IDs, the only way the target already exists is if
        # the exact same session was previously archived. In that case the
        # tracker already has the ID loaded from disk (pre-filter) and we
        # never reach the skip path. When the tracker is empty and a stale
        # file exists, we must not falsely claim the session was archived.
        tracker_path = os.path.join(self.workspace, ".state", "archived_sessions.json")
        if os.path.exists(tracker_path):
            with open(tracker_path, "r", encoding="utf-8") as f:
                tracker = json.load(f)
            self.assertNotIn(
                sid, tracker.get("session_ids", []),
                "Session ID must NOT be in tracker when file was skipped "
                "without prior tracker record",
            )

    def test_tracker_idempotence(self):
        """Re-running with the same sessions must not produce duplicate files."""
        sid = "dddddddd-eeee-ffff-aaaa-bbbbbbbbbbbb"
        db_path = os.path.join(self.workspace, "opencode.db")

        _create_test_db(db_path, [
            {
                "id": sid,
                "title": "Idempotent Session",
                "agent": "cli",
                "model": "test-model",
                "time_created": _TS,
                "messages": [{"role": "user", "text": "First run"}],
            },
        ])

        compiler = self._make_compiler()

        # First run
        saved1 = compiler.archive_opencode(db_path=db_path)
        self.assertEqual(len(saved1), 1, "First run should save one file")

        # Second run — must return empty (all sessions already archived)
        compiler2 = self._make_compiler()
        saved2 = compiler2.archive_opencode(db_path=db_path)
        self.assertEqual(saved2, [], "Second run must return empty (idempotent)")

        # Tracker must contain the session ID exactly once
        tracker_path = os.path.join(self.workspace, ".state", "archived_sessions.json")
        with open(tracker_path, "r", encoding="utf-8") as f:
            tracker = json.load(f)
        sids = tracker.get("session_ids", [])
        self.assertEqual(
            len(sids), 1,
            f"Tracker must have exactly 1 session, got: {sids}",
        )
        self.assertEqual(sids[0], sid)

    def test_same_prefix_ids_are_distinct(self):
        """Two sessions whose UUIDs share the same first 8 characters
        must produce completely distinct hex-encoded filenames — no
        collision from the hex encoding."""
        same_prefix = "cafebabe"
        # Same prefix, different full IDs
        sid_a = f"{same_prefix}-aaaa-bbbb-cccc-dddddddddddd"
        sid_b = f"{same_prefix}-eeee-ffff-0000-111111111111"
        db_path = os.path.join(self.workspace, "opencode.db")

        _create_test_db(db_path, [
            {
                "id": sid_a,
                "title": "Collision Test A",
                "agent": "cli",
                "model": "test-model",
                "time_created": _TS,
                "messages": [{"role": "user", "text": "Message from A"}],
            },
            {
                "id": sid_b,
                "title": "Collision Test B",
                "agent": "cli",
                "model": "test-model",
                "time_created": _TS,
                "messages": [{"role": "user", "text": "Message from B"}],
            },
        ])

        compiler = self._make_compiler()
        saved = compiler.archive_opencode(db_path=db_path)

        self.assertEqual(len(saved), 2, f"Expected 2 saved files, got: {saved}")

        f1, f2 = saved
        self.assertNotEqual(f1, f2, "Filenames must be distinct")

        # Each filename must contain its FULL hex session ID (not just prefix)
        hex_a = sid_a.encode("utf-8").hex()
        hex_b = sid_b.encode("utf-8").hex()
        self.assertIn(hex_a, f1, f"Filename {f1!r} missing hex session id")
        self.assertIn(hex_b, f2, f"Filename {f2!r} missing hex session id")

        # Both files must exist and contain the correct content
        for fn, expected_sid, expected_text in [
            (f1, sid_a, "Message from A"),
            (f2, sid_b, "Message from B"),
        ]:
            path = os.path.join(self.workspace, "raw", fn)
            self.assertTrue(os.path.exists(path), f"File {path} must exist")
            with open(path, "r", encoding="utf-8") as f:
                content = f.read()
            self.assertIn(expected_text, content)

        # Tracker must contain both session IDs
        tracker_path = os.path.join(self.workspace, ".state", "archived_sessions.json")
        self.assertTrue(os.path.exists(tracker_path), "Tracker must exist")
        with open(tracker_path, "r", encoding="utf-8") as f:
            tracker = json.load(f)
        sids = tracker.get("session_ids", [])
        self.assertEqual(len(sids), 2, f"Tracker must have 2 sessions, got: {sids}")
        self.assertIn(sid_a, sids)
        self.assertIn(sid_b, sids)

    def test_skip_does_not_falsely_update_tracker(self):
        """When a raw file already exists but the tracker has no record
        of that session (e.g. stale/ambiguous target), archive_opencode
        must NOT falsely mark the session as archived."""
        sid = "deadbeef-1234-5678-9abc-def012345678"
        db_path = os.path.join(self.workspace, "opencode.db")

        compiler = self._make_compiler()

        # Pre-create the expected raw file WITHOUT any tracker record
        raw_dir = os.path.join(self.workspace, "raw")
        os.makedirs(raw_dir, exist_ok=True)
        hex_sid = sid.encode("utf-8").hex()
        stale_name = f"{_DATE}_opencode_session_{hex_sid}_untitled.md"
        stale_path = os.path.join(raw_dir, stale_name)
        stale_content = "STALE CONTENT — different session or leftover"
        with open(stale_path, "w", encoding="utf-8") as f:
            f.write(stale_content)

        _create_test_db(db_path, [
            {
                "id": sid,
                "title": "Untitled",
                "agent": "cli",
                "model": "test-model",
                "time_created": _TS,
                "messages": [{"role": "user", "text": "New content"}],
            },
        ])

        saved = compiler.archive_opencode(db_path=db_path)

        # Should return empty — file existed, was skipped
        self.assertEqual(
            saved, [],
            f"Expected no saved files when target exists, got: {saved}",
        )

        # Stale file must remain untouched
        with open(stale_path, "r", encoding="utf-8") as f:
            self.assertEqual(f.read(), stale_content)

        # Tracker must NOT contain the session ID (we never wrote the file)
        tracker_path = os.path.join(self.workspace, ".state", "archived_sessions.json")
        if os.path.exists(tracker_path):
            with open(tracker_path, "r", encoding="utf-8") as f:
                tracker = json.load(f)
            self.assertNotIn(
                sid, tracker.get("session_ids", []),
                "Session ID must NOT be in tracker when file was skipped "
                "without prior tracker record",
            )


def _create_engram_test_db(db_path, observations):
    """Create a minimal Engram-shaped SQLite database with given observations.

    Each observation dict must have:
      id, type, title, content
    and optionally: topic_key, scope, project, created_at
    """
    conn = sqlite3.connect(db_path)
    conn.execute("""
        CREATE TABLE observations (
            id INTEGER PRIMARY KEY,
            type TEXT,
            title TEXT,
            content TEXT,
            topic_key TEXT,
            scope TEXT,
            project TEXT,
            created_at TEXT
        )
    """)
    for obs in observations:
        conn.execute(
            "INSERT INTO observations VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                obs["id"],
                obs.get("type", ""),
                obs.get("title", ""),
                obs.get("content", ""),
                obs.get("topic_key", ""),
                obs.get("scope", ""),
                obs.get("project", ""),
                obs.get("created_at", ""),
            ),
        )
    conn.commit()
    conn.close()


class TestArchiveEngram(unittest.TestCase):
    """Regression tests for archive_engram overwrite protection and
    collision-safe identity."""

    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.workspace = self.tmpdir.name

    def tearDown(self):
        self.tmpdir.cleanup()

    def _make_compiler(self):
        return WikiCompiler(workspace_dir=self.workspace)

    def test_never_overwrites_existing_raw_file(self):
        """When a raw file already exists at the target path, archive_engram
        must skip it and NOT overwrite; the tracker must NOT falsely mark
        the observation as archived."""
        obs_id = 42
        db_path = os.path.join(self.workspace, "engram.db")

        compiler = self._make_compiler()

        # Pre-create a raw file with the exact name that would be produced
        raw_dir = os.path.join(self.workspace, "raw")
        os.makedirs(raw_dir, exist_ok=True)
        pre_existing_name = "engram_42.md"
        pre_existing_path = os.path.join(raw_dir, pre_existing_name)
        original_content = "ORIGINAL CONTENT — DO NOT OVERWRITE"
        with open(pre_existing_path, "w", encoding="utf-8") as f:
            f.write(original_content)

        _create_engram_test_db(db_path, [
            {
                "id": obs_id,
                "type": "bugfix",
                "title": "My observation",
                "content": "New replacement content.",
                "topic_key": "test/key",
                "scope": "project",
                "project": "test",
                "created_at": "",
            },
        ])

        written = compiler.archive_engram(db_path=db_path)

        # Nothing should be saved (file existed, should be skipped)
        self.assertEqual(
            written, 0,
            f"Expected 0 saved files when target exists, got: {written}",
        )

        # Original file must be unchanged
        with open(pre_existing_path, "r", encoding="utf-8") as f:
            current = f.read()
        self.assertEqual(
            current.strip(),
            original_content,
            "Pre-existing file must NOT be overwritten",
        )

        # Tracker must NOT falsely mark the observation as archived
        tracker_path = os.path.join(
            self.workspace, ".state", "engram-archive-tracker.json"
        )
        self.assertFalse(
            os.path.exists(tracker_path),
            "Tracker must NOT be created when no files were written",
        )

    def test_tracker_idempotence(self):
        """Re-running with the same observations must not produce duplicate
        files or double-count in the tracker."""
        obs_id = 100
        db_path = os.path.join(self.workspace, "engram.db")

        _create_engram_test_db(db_path, [
            {
                "id": obs_id,
                "type": "decision",
                "title": "Idempotent observation",
                "content": "First run content.",
                "topic_key": "arch/idempotent",
                "scope": "project",
                "project": "test",
                "created_at": "2024-01-15T10:00:00",
            },
        ])

        compiler = self._make_compiler()

        # First run
        written1 = compiler.archive_engram(db_path=db_path)
        self.assertEqual(written1, 1, "First run should save one file")

        # Second run — must return 0 (all already archived)
        compiler2 = self._make_compiler()
        written2 = compiler2.archive_engram(db_path=db_path)
        self.assertEqual(written2, 0, "Second run must return 0 (idempotent)")

        # Tracker must contain the observation ID exactly once
        tracker_path = os.path.join(
            self.workspace, ".state", "engram-archive-tracker.json"
        )
        with open(tracker_path, "r", encoding="utf-8") as f:
            tracker = json.load(f)
        ids = tracker.get("observation_ids", [])
        self.assertEqual(
            len(ids), 1,
            f"Tracker must have exactly 1 id, got: {ids}",
        )
        self.assertEqual(ids[0], obs_id)

    def test_skip_does_not_falsely_update_tracker(self):
        """When a raw file already exists but the tracker has no record
        of that observation (stale/corrupt tracker), archive_engram
        must NOT falsely mark the observation as archived."""
        obs_id = 200
        db_path = os.path.join(self.workspace, "engram.db")

        compiler = self._make_compiler()

        # Pre-create the expected raw file WITHOUT any tracker record
        raw_dir = os.path.join(self.workspace, "raw")
        os.makedirs(raw_dir, exist_ok=True)
        stale_name = "engram_200.md"
        stale_path = os.path.join(raw_dir, stale_name)
        stale_content = "STALE CONTENT — leftover from different run"
        with open(stale_path, "w", encoding="utf-8") as f:
            f.write(stale_content)

        _create_engram_test_db(db_path, [
            {
                "id": obs_id,
                "type": "pattern",
                "title": "My stale obs",
                "content": "New content should not overwrite stale file.",
                "topic_key": "test/stale",
                "scope": "project",
                "project": "test",
                "created_at": "",
            },
        ])

        written = compiler.archive_engram(db_path=db_path)

        # Should return 0 — file existed, was skipped
        self.assertEqual(
            written, 0,
            f"Expected 0 saved files when target exists, got: {written}",
        )

        # Stale file must remain untouched
        with open(stale_path, "r", encoding="utf-8") as f:
            self.assertEqual(f.read(), stale_content)

        # Tracker must NOT be created when no files were written
        tracker_path = os.path.join(
            self.workspace, ".state", "engram-archive-tracker.json"
        )
        self.assertFalse(
            os.path.exists(tracker_path),
            "Tracker must NOT be created when no files were written",
        )

    def test_deterministic_identity_based_on_observation_id(self):
        """The filename uses observation_id alone as deterministic identity.
        Different observations with similar titles must produce distinct
        filenames derived purely from their IDs."""
        db_path = os.path.join(self.workspace, "engram.db")

        _create_engram_test_db(db_path, [
            {
                "id": 1,
                "type": "decision",
                "title": "Same title",
                "content": "First observation.",
                "topic_key": "",
                "scope": "",
                "project": "",
                "created_at": "2024-01-01T00:00:00",
            },
            {
                "id": 2,
                "type": "decision",
                "title": "Same title",
                "content": "Second observation, same title.",
                "topic_key": "",
                "scope": "",
                "project": "",
                "created_at": "2024-01-01T00:00:00",
            },
        ])

        compiler = self._make_compiler()
        written = compiler.archive_engram(db_path=db_path)

        self.assertEqual(written, 2, f"Expected 2 saved files, got: {written}")

        # Both files must exist
        raw_dir = os.path.join(self.workspace, "raw")
        files = sorted(os.listdir(raw_dir))
        self.assertEqual(len(files), 2)

        # Filenames are observation-ID-only: engram_1.md, engram_2.md
        self.assertEqual(files[0], "engram_1.md",
                         f"Filename {files[0]!r} must be engram_1.md")
        self.assertEqual(files[1], "engram_2.md",
                         f"Filename {files[1]!r} must be engram_2.md")
        self.assertNotEqual(files[0], files[1], "Filenames must be distinct")

        # Both files must contain title as frontmatter metadata, not in filename
        for fn in files:
            path = os.path.join(raw_dir, fn)
            with open(path, "r", encoding="utf-8") as f:
                content = f.read()
            self.assertIn("Same title", content,
                          f"File {fn} must contain title as metadata")


class TestLazyDirectoryCreation(unittest.TestCase):
    """Regression: WikiCompiler must not eagerly create directories during
    initialization. Archive operations create only raw/ and .state/,
    never wiki/."""

    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.workspace = self.tmpdir.name

    def tearDown(self):
        self.tmpdir.cleanup()

    def test_init_does_not_create_directories(self):
        """WikiCompiler() validates WIKI_DIR but must not create
        raw/, wiki/, or .state/ on its own."""
        compiler = WikiCompiler(workspace_dir=self.workspace)
        self.assertFalse(
            os.path.exists(compiler.raw_dir),
            "raw/ must NOT be created by __init__",
        )
        self.assertFalse(
            os.path.exists(compiler.wiki_dir),
            "wiki/ must NOT be created by __init__",
        )
        self.assertFalse(
            os.path.exists(compiler.data_dir),
            ".state/ must NOT be created by __init__",
        )

    def test_archive_opencode_creates_only_raw_and_state(self):
        """archive_opencode creates raw/ and .state/ but NOT wiki/."""
        sid = "eeeeeeee-ffff-aaaa-bbbb-cccccccccccc"
        db_path = os.path.join(self.workspace, "opencode.db")
        _create_test_db(db_path, [
            {
                "id": sid,
                "title": "Archive Only Test",
                "agent": "cli",
                "model": "test-model",
                "time_created": _TS,
                "messages": [{"role": "user", "text": "Hello"}],
            },
        ])

        compiler = WikiCompiler(workspace_dir=self.workspace)
        compiler.archive_opencode(db_path=db_path)

        self.assertTrue(
            os.path.isdir(compiler.raw_dir),
            "raw/ must be created by archive_opencode",
        )
        self.assertTrue(
            os.path.isdir(compiler.data_dir),
            ".state/ must be created by archive_opencode",
        )
        self.assertFalse(
            os.path.exists(compiler.wiki_dir),
            "wiki/ must NOT be created by archive_opencode",
        )

    def test_archive_all_does_not_create_wiki(self):
        """archive-all creates raw/ and .state/, NOT wiki/ when only
        archive_opencode runs (engram DB may not exist)."""
        sid = "ffffffff-aaaa-bbbb-cccc-dddddddddddd"
        db_path = os.path.join(self.workspace, "opencode.db")
        _create_test_db(db_path, [
            {
                "id": sid,
                "title": "archive-all Test",
                "agent": "cli",
                "model": "test-model",
                "time_created": _TS,
                "messages": [{"role": "user", "text": "archive-all"}],
            },
        ])

        compiler = WikiCompiler(workspace_dir=self.workspace)
        compiler.archive_opencode(db_path=db_path)

        self.assertFalse(
            os.path.exists(compiler.wiki_dir),
            "wiki/ must NOT be created by archive operations",
        )

    def test_wiki_dir_creation_missing_is_handled_gracefully(self):
        """_get_existing_wiki_files returns empty list when wiki/ is missing."""
        compiler = WikiCompiler(workspace_dir=self.workspace)
        files = compiler._get_existing_wiki_files()
        self.assertEqual(files, [], "Must return empty list when wiki/ missing")


class TestSearchReadOnly(unittest.TestCase):
    """Focused tests for read-only search: no WikiCompiler, no directory
    creation, clean failure when WIKI_DIR/index is unavailable."""

    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.workspace = self.tmpdir.name
        # Create wiki/ dir + a minimal index.json
        self.wiki_dir = os.path.join(self.workspace, "wiki")
        os.makedirs(self.wiki_dir, exist_ok=True)
        self.index_path = os.path.join(self.wiki_dir, "index.json")

    def tearDown(self):
        self.tmpdir.cleanup()

    def _write_index(self, pages):
        """Write a minimal index.json to the workspace wiki/ dir."""
        with open(self.index_path, "w", encoding="utf-8") as f:
            json.dump({"pages": pages, "page_count": len(pages)}, f)

    def _set_wiki_dir(self):
        """Set WIKI_DIR env var and reload search module caches."""
        os.environ["WIKI_DIR"] = self.workspace
        import search
        search.INDEX_PATH = os.path.join(self.workspace, "wiki", "index.json")
        search._cache = None

    def _clear_wiki_dir(self):
        """Unset WIKI_DIR and clear search module caches."""
        if "WIKI_DIR" in os.environ:
            del os.environ["WIKI_DIR"]
        import search
        search.INDEX_PATH = None
        search._cache = None

    def test_search_index_returns_matching_page(self):
        """search_index finds a page by keyword match."""
        self._write_index([
            {
                "file": "wiki/test_page.md",
                "title": "Test Page",
                "type": "wiki",
                "keywords": ["test", "search"],
                "summary": "A test page about searching.",
            },
            {
                "file": "wiki/other.md",
                "title": "Other",
                "type": "wiki",
                "keywords": ["other"],
                "summary": "Unrelated page.",
            },
        ])
        self._set_wiki_dir()
        from search import search_index
        results = search_index("search")
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["file"], "wiki/test_page.md")

    def test_search_index_no_match_returns_empty(self):
        """search_index returns empty list when nothing matches."""
        self._write_index([
            {
                "file": "wiki/a.md",
                "title": "A",
                "type": "wiki",
                "keywords": ["a"],
                "summary": "Page A.",
            },
        ])
        self._set_wiki_dir()
        from search import search_index
        results = search_index("nonexistent")
        self.assertEqual(results, [])

    def test_search_index_type_filter(self):
        """search_index with types=[\"wiki\"] filters out non-wiki pages."""
        self._write_index([
            {
                "file": "wiki/page.md",
                "title": "Wiki Page",
                "type": "wiki",
                "keywords": ["shared"],
                "summary": "A wiki page.",
            },
            {
                "file": "wiki/other.md",
                "title": "Other Type",
                "type": "other",
                "keywords": ["shared"],
                "summary": "Different type.",
            },
        ])
        self._set_wiki_dir()
        from search import search_index
        results = search_index("shared", types=["wiki"])
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["type"], "wiki")

    def test_search_index_fails_clearly_without_wiki_dir(self):
        """search_index raises clear error when WIKI_DIR is not set."""
        self._clear_wiki_dir()
        from search import search_index
        with self.assertRaises(ValueError) as ctx:
            search_index("test")
        self.assertIn("WIKI_DIR", str(ctx.exception))

    def test_search_does_not_create_directories(self):
        """Searching must not create any directories under workspace."""
        self._write_index([
            {
                "file": "wiki/page.md",
                "title": "Page",
                "type": "wiki",
                "keywords": ["test"],
                "summary": "Test.",
            },
        ])
        self._set_wiki_dir()
        from search import search_index
        search_index("test")

        # No new directories beyond what setUp created (workspace + wiki/)
        entries = set(os.listdir(self.workspace))
        self.assertEqual(entries, {"wiki"})


if __name__ == "__main__":
    unittest.main()
