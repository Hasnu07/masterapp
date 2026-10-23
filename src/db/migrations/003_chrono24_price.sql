-- The Chrono24 price, as the vault's Research panel confirms it
-- (b2chronoFinal, one figure per currency like its B2B and B2C prices).
ALTER TABLE watches ADD COLUMN chrono24_price numeric(14,2);
ALTER TABLE watches ADD COLUMN chrono24_currency text NOT NULL DEFAULT '';
