-- The devices row IS the creator profile: devices.id stays the immutable
-- internal key every config points at, while nickname is the renameable
-- display handle. nickname_lc holds the normalized form (trimmed +
-- lowercased) the unique index is built on, so "Eamon" and "eamon " cannot
-- both be claimed. The index is partial: any number of devices may have no
-- nickname at all.
ALTER TABLE devices ADD COLUMN nickname TEXT;
ALTER TABLE devices ADD COLUMN nickname_lc TEXT;

CREATE UNIQUE INDEX idx_devices_nick
  ON devices(nickname_lc) WHERE nickname_lc IS NOT NULL;
