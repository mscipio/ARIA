import unittest

from shop import Cart, build_invoice, render


class Shop(unittest.TestCase):
    def test_invoice(self):
        inv = build_invoice(Cart().add("pen", "1.50", 2).add("bread", "3.00", 1, category="food"))
        self.assertAlmostEqual(inv.subtotal, 6.0)
        self.assertAlmostEqual(inv.total, 6.0 + 0.27 + 0.06, places=2)

    def test_render(self):
        text = render(build_invoice(Cart().add("pen", "1.50", 2)))
        self.assertIn("total", text)


if __name__ == "__main__":
    unittest.main()
