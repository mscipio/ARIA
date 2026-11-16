import unittest


class Placeholder(unittest.TestCase):
    def test_import(self):
        import cachetool  # noqa: F401


if __name__ == "__main__":
    unittest.main()
