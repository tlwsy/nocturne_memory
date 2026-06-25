CREATE TABLE IF NOT EXISTS schema_migrations(version TEXT PRIMARY KEY,applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
INSERT OR IGNORE INTO schema_migrations(version) VALUES('0001_core'),('0002_features'),('0003_audit_r2'),('0004_schema_migrations');
