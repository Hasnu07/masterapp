-- Where Chrono Key's own lists put each watch, at the last read that could be
-- trusted (src/import/chronokey/lists.js): its Inventory tab, its
-- To-be-shipped page, its Returned consignments — the status comes from
-- these, because the product grid cannot tell a watch returned to its client
-- from one on the shelf (stock 1722, 23 Oct 2026).
--   {"inventory": {"badge": "Available", "owner": "INVENTORY", "ck_id": 26369},
--    "incoming": {}, "returned": {"date": "2026-10-16", "ck_id": 41288},
--    "none": 0}           -- trusted reads in a row that found it on no list
ALTER TABLE ck_records ADD COLUMN ck_lists jsonb;
ALTER TABLE ck_records ADD COLUMN lists_at timestamptz;
