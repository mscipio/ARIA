Customers report invoices that are off by a cent, and the accountant says the shop's totals do not follow our rules. Money is currently handled as `float` throughout the `shop` package.

Our rules:
- Money is exact: use `decimal.Decimal` (no floats anywhere in money arithmetic).
- Every amount that leaves a function in `shop` is a `Decimal` quantized to cents.
- Tax is computed per line on the line total and rounded half-up to the cent; the invoice tax is the sum of the rounded line taxes.
- Discounts (percentage, per line) are applied before tax and rounded half-up to the cent.
- Prices in the catalogue and quantities may arrive as `str`, `int` or `Decimal`; a `float` price is rejected with `TypeError`.
- `report.render()` prints amounts with exactly two decimals.

Bring the package in line with these rules. Keep the public functions and their parameters as they are (callers pass the same arguments), and keep the existing tests passing (update them where they encode the old float behaviour).
