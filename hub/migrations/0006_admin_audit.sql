-- 谁在什么时候对什么做了什么。存在的理由是「以后可能有第二个审核员」:
-- 这张表后补的话,此前的每一次操作都会永远归属于「不知道是谁」。
--
-- action 不加 CHECK 约束:动作集合会随功能增长,而 SQLite 改 CHECK 要重建
-- 整张表,不值得。target_type 加,是因为它只有三种可能且不会再长。
CREATE TABLE admin_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('config','device','report')),
  target_id TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_admin_actions_recent ON admin_actions(created_at DESC, id DESC);
CREATE INDEX idx_admin_actions_target ON admin_actions(target_type, target_id, created_at DESC);
