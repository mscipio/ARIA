import unittest

from textstats import count_words, top_words


class WordCount(unittest.TestCase):
    def test_simple(self):
        self.assertEqual(count_words("the quick brown fox"), 4)

    def test_top(self):
        self.assertEqual(top_words("a b a c a b", 2), [("a", 3), ("b", 2)])


if __name__ == "__main__":
    unittest.main()
