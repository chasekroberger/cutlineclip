-- When a paid account's current 30 day clip allowance started. Yearly plans reset every 30 days too.
ALTER TABLE users ADD COLUMN plan_cycle_at INTEGER;
