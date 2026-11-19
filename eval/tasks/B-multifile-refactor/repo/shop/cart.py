from dataclasses import dataclass, field


@dataclass
class Line:
    sku: str
    unit_price: float
    quantity: int
    discount_pct: float = 0.0
    category: str = "standard"


@dataclass
class Cart:
    lines: list[Line] = field(default_factory=list)

    def add(self, sku, unit_price, quantity=1, discount_pct=0, category="standard"):
        self.lines.append(Line(sku, float(unit_price), int(quantity), float(discount_pct), category))
        return self
