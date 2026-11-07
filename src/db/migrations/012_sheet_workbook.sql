-- Sheets in GridCraft (asked 7 Nov 2026: "use storytold/gridcraft as the sheet
-- tool instead, with the same concept"): the sheet is opened in GridCraft as
-- an .xlsx workbook and every Save comes back as one. The workbook the person
-- last saved is kept whole — their formatting, extra columns and formulas —
-- beside the document the ERP reads from it (doc).
ALTER TABLE sheets ADD COLUMN workbook bytea;
ALTER TABLE sheets ADD COLUMN workbook_at timestamptz;
