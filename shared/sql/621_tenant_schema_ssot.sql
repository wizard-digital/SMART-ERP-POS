-- Tenant schema SSOT stamp.
-- 618 and 620 originally omitted schema_version inserts, so MAX(version)
-- could look current (v617/v619) while later numbered files had not been
-- applied on every tenant. This file is the integer gate matching
-- CURRENT_SCHEMA_VERSION = 621. Idempotent; no DDL.

INSERT INTO schema_version (version)
SELECT 618 WHERE NOT EXISTS (SELECT 1 FROM schema_version WHERE version = 618);

INSERT INTO schema_version (version)
SELECT 620 WHERE NOT EXISTS (SELECT 1 FROM schema_version WHERE version = 620);

INSERT INTO schema_version (version)
SELECT 621 WHERE NOT EXISTS (SELECT 1 FROM schema_version WHERE version = 621);
