def mean(values):
    """Arithmetic mean; raises ValueError for an empty sequence."""
    values = list(values)
    return sum(values) / len(values)


def safe_ratio(a, b, default=0.0):
    """a / b, or `default` when b is zero."""
    return a / b if b else default
