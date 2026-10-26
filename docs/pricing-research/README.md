# Pricing research (not used by the agent)

Spectora is the only authority on price. The agent accepts the price Spectora shows on the Review step and
records it with the booking result (`spectoraShown`); it does not compute or check prices.

Kept for reference only:

- `pricing-observations-2026-10-25.csv`: 325 of Spectora's own Step 1 price calculations for the Truss
  scheduler, with Spectora's fee lines (measured 2026-10-25, never past Step 2).
- `pricing-rules-2026-10-25.json`: the rules those observations imply.

Things in Spectora's configuration you may want to fix there (they do not affect booking):

- Above each service's last square-footage range Spectora charges only the base price (Residential over
  7,000 sq ft, 1 Year Warranty over 6,500, New Construction over 6,000, Condo over 3,500).
- New Construction 6,001–6,500 sq ft adds $3 (most likely meant to be $300).
- The Residential mileage fee stops after 100 miles (no range above it).
