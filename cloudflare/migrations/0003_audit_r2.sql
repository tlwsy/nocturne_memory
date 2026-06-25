CREATE TABLE IF NOT EXISTS changeset_rows(row_key TEXT PRIMARY KEY,table_name TEXT NOT NULL,node_uuid TEXT,before_json TEXT,after_json TEXT,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_changeset_node ON changeset_rows(node_uuid);
CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY,object_key TEXT NOT NULL UNIQUE,namespace TEXT NOT NULL DEFAULT '',node_uuid TEXT REFERENCES nodes(uuid) ON DELETE SET NULL,filename TEXT NOT NULL,content_type TEXT NOT NULL,size_bytes INTEGER NOT NULL CHECK(size_bytes>=0 AND size_bytes<=10485760),etag TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_attachments_node ON attachments(namespace,node_uuid);
