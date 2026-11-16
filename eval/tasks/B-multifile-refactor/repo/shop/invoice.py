from dataclasses import dataclass

from .cart import Cart
from .pricing import line_total
from .tax import line_tax


@dataclass
class Invoice:
    subtotal: float
    tax: float
    total: float
    lines: list[tuple[str, float, float]]


def build_invoice(cart: Cart) -> Invoice:
    rows = [(l.sku, line_total(l), line_tax(l)) for l in cart.lines]
    subtotal = sum(r[1] for r in rows)
    tax = sum(r[2] for r in rows)
    return Invoice(round(subtotal, 2), round(tax, 2), round(subtotal + tax, 2), rows)
