"""Small text statistics used by the newsletter tooling."""

from collections import Counter


def count_words(text: str) -> int:
    """Number of words in `text`."""
    return len(text.split(" "))


def top_words(text: str, n: int = 3) -> list[tuple[str, int]]:
    """The n most common lower-cased words (ties by first appearance)."""
    words = [w.strip(".,;:!?\"()").lower() for w in text.split()]
    return Counter(w for w in words if w).most_common(n)
