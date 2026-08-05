-- 浏览器直传的中转态：路由器建草稿把 payload 存这里，浏览器把字节 PUT 到
-- R2 的 draft/ 前缀，路由器再提交。存在的理由是 OpenWrt 的 uclient-fetch 走
-- TLS 推不动大 body，而单请求发布把整张登录背景 base64 塞进一个 JSON。
--
-- target_id 非空表示这份草稿是去覆盖一条已有分享（更新），空表示新发布 ——
-- 两条路共用一套机制，因为"更新"的语义本来就是"用当前配置替换它"。
CREATE TABLE drafts (
  id TEXT PRIMARY KEY,
  theme TEXT NOT NULL,
  device_id TEXT NOT NULL REFERENCES devices(id),
  target_id TEXT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_drafts_gc ON drafts(created_at);
