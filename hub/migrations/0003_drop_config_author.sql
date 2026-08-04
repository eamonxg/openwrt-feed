-- Signing moved to devices.nickname, joined at read time. Nothing reads or
-- writes configs.author any more, and no index references it.
ALTER TABLE configs DROP COLUMN author;
