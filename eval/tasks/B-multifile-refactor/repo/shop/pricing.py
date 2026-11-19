from .cart import Line


def line_total(line: Line) -> float:
    """Price of a line after its percentage discount."""
    gross = line.unit_price * line.quantity
    return gross - gross * line.discount_pct / 100
