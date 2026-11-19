"""Nightly cache cleanup."""

from __future__ import annotations

import time


def prune(root: str, max_age_seconds: float, now: float | None = None) -> list[str]:
    """Delete stale cache files under `root`. See the task description in the repository docs."""
    raise NotImplementedError
