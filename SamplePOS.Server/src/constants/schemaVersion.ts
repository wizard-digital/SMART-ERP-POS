// Schema Version — Single Source of Truth
//
// This number MUST match the latest INSERT INTO schema_version (version)
// across all migration files. When adding a new migration:
//   1. Add: INSERT INTO schema_version (version) VALUES (N);
//   2. Bump CURRENT_SCHEMA_VERSION here to N.
//
// The tenantMigrationService checks MAX(version) in each tenant DB
// against this constant. If the tenant is behind, pending migrations
// are auto-applied before the request proceeds.

export const CURRENT_SCHEMA_VERSION = 615;
