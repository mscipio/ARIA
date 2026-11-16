from .cart import Line
from .pricing import line_total

TAX_RATES = {"standard": 8.875, "food": 2.0, "exempt": 0.0}


def line_tax(line: Line) -> float:
    return line_total(line) * TAX_RATES[line.category] / 100
