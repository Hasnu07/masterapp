-- Jewellery and bags beside the watches (asked 5 Nov 2026: "add category of
-- jewellery and bags here too; the stock number sequence stays the same, but
-- new categories with their accompanying detail fields — material, carats,
-- gemstones, colour, chain length etc.; the same with bags").
--
-- One table still: a piece of jewellery or a bag is a stock number like any
-- watch — one purchase, one record, in the SAME sequence (the unique index on
-- stock_no stands as it is) — with the same purchase, prices, sale, photos,
-- documents, costs and history. What differs is the item's own description:
-- a watch has a dial, a case and a movement; a piece of jewellery its metal,
-- carats and stones; a bag its leather, colour, size and hardware. So:
-- `category` says which the record is, and each category's own fields are
-- columns of their own, blank on the others. Everything copied from Chrono
-- Key and the vault is a watch (the default); the two new categories are
-- added here by hand.
--
-- Additive only: columns with defaults, one index.

ALTER TABLE watches
  ADD COLUMN category text NOT NULL DEFAULT 'watch' CHECK (category IN ('watch', 'jewellery', 'bag')),

  -- jewellery
  ADD COLUMN jewel_type     text NOT NULL DEFAULT '',   -- ring, necklace, bracelet, earrings, pendant, brooch …
  ADD COLUMN material       text NOT NULL DEFAULT '',   -- 18k yellow gold, platinum, silver …
  ADD COLUMN carats         text NOT NULL DEFAULT '',   -- the stones' carat weight, as written: "2.05 ct", "1.5"
  ADD COLUMN gemstones      text NOT NULL DEFAULT '',   -- diamond, sapphire, emerald …
  ADD COLUMN gem_colour     text NOT NULL DEFAULT '',   -- D–Z for a diamond, or the stone's colour
  ADD COLUMN gem_clarity    text NOT NULL DEFAULT '',   -- VVS1, VS2 …
  ADD COLUMN chain_length   text NOT NULL DEFAULT '',   -- "45 cm", "18 in"
  ADD COLUMN ring_size      text NOT NULL DEFAULT '',   -- "52", "M", "6.5 US"
  ADD COLUMN weight         text NOT NULL DEFAULT '',   -- "12.4 g"
  ADD COLUMN certificate    text NOT NULL DEFAULT '',   -- GIA / IGI number, hallmark

  -- bags
  ADD COLUMN bag_type       text NOT NULL DEFAULT '',   -- tote, shoulder, clutch, backpack, wallet …
  ADD COLUMN bag_material   text NOT NULL DEFAULT '',   -- Togo leather, canvas, crocodile …
  ADD COLUMN bag_colour     text NOT NULL DEFAULT '',
  ADD COLUMN bag_size       text NOT NULL DEFAULT '',   -- "25 cm", "Medium"
  ADD COLUMN hardware       text NOT NULL DEFAULT '',   -- gold, palladium, silver-tone
  ADD COLUMN date_code      text NOT NULL DEFAULT '';   -- the maker's year or date stamp: "Z stamp 2021"

CREATE INDEX watches_category ON watches(category) WHERE deleted_at IS NULL;
