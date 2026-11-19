from .invoice import Invoice


def render(inv: Invoice) -> str:
    out = [f"{sku:<12}{total:>10}{tax:>8}" for sku, total, tax in inv.lines]
    out.append(f"{'subtotal':<12}{inv.subtotal:>10}")
    out.append(f"{'tax':<12}{inv.tax:>10}")
    out.append(f"{'total':<12}{inv.total:>10}")
    return "\n".join(out)
