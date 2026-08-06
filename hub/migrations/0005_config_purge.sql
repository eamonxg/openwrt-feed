-- 下架从此可逆:configs.status='removed' 只是把配置从所有公开界面上摘掉,
-- assets 行和 R2 对象原封不动,恢复能拿回完整的一份。
--
-- purged_at 是「字节已经销毁」的戳。没有它,两种状态在数据上完全同形:
-- 一份本来就没有资产的配置被下架(assets 表无行),和一份被永久删除的配置
-- (assets 行已删)。管理端会对后者显示「恢复」按钮,恢复出来却是一份丢了
-- 字体和登录背景的空壳。
--
-- owner 自己删除走的也是销毁字节这条路,因此同样写这个戳(见 configs.js)。
ALTER TABLE configs ADD COLUMN purged_at TEXT;

-- 管理端列表默认不按 status 过滤,现有 idx_configs_list / idx_configs_new
-- 的前缀都是 (theme, status),对它无能为力。
CREATE INDEX idx_configs_admin ON configs(theme, updated_at DESC);
