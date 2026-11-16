import unittest


class Placeholder(unittest.TestCase):
    def test_import(self):
        import petsuv  # noqa: F401


if __name__ == "__main__":
    unittest.main()
