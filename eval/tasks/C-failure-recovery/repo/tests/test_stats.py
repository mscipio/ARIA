import unittest

from calc import mean, safe_ratio


class Stats(unittest.TestCase):
    def test_mean(self):
        self.assertEqual(mean([1, 2, 3]), 2)

    def test_mean_empty(self):
        with self.assertRaises(ValueError):
            mean([])

    def test_ratio(self):
        self.assertEqual(safe_ratio(1, 4), 0.25)
        self.assertEqual(safe_ratio(1, 0, default=-1), -1)


if __name__ == "__main__":
    unittest.main()
