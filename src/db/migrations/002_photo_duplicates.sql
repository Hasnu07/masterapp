-- Recognising a picture already held under another address (storage/index.js:
-- fingerprint, samePicture). Filled in as photos are added, and for older
-- photos the first time they are compared.
ALTER TABLE watch_photos ADD COLUMN sha256 text;
ALTER TABLE watch_photos ADD COLUMN dhash text;

-- A copy the sync meets again under another address is still kept as a row,
-- so it is never fetched again — marked removed, pointing at the photo it
-- repeats, and with no file of its own.
ALTER TABLE watch_photos ADD COLUMN duplicate_of integer REFERENCES watch_photos(id);
ALTER TABLE watch_photos ALTER COLUMN storage_key DROP NOT NULL;

CREATE INDEX watch_photos_sha ON watch_photos(watch_id, sha256);
