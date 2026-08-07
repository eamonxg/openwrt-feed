-- /api/v1/me 查的是 WHERE device_id = ? ORDER BY created_at DESC,而 configs
-- 上三个既有索引的前缀分别是 (theme,status,downloads)、(theme,status,created_at)
-- 和 (theme,content_hash),没有一个能用。于是每次打开商店的「我的」标签页都
-- 全表扫一遍 configs —— 代价随整个商店的作品总数涨,而不是随这台路由器自己
-- 发过几件。
CREATE INDEX idx_configs_owner ON configs(device_id, created_at DESC);

-- 是谁把它下架的。
--
-- 此前只有一个 status='removed':owner 自己删(configs.js 的 deleteConfig)和
-- 管理员下架(admin.js 的 takedownConfig)写进库里完全同形。客户端因此只能把
-- 两者一起藏掉(marketplace.js 的 renderMyShares),代价是作者永远不会知道自己
-- 的作品被下架过 —— 它只是某天从列表里消失了。
--
-- purged_at 看似能替代这一列(owner 删会盖戳,管理员下架不盖),但那是巧合:
-- 0005 给它的定义是「字节已经销毁」,而管理员的永久删除同样盖戳。哪天 owner
-- 的删除改成保留字节(回收站之类),这个推断就会静默失效,而失效的表现是
-- 用户自己删掉的作品重新出现在列表里。
--
-- 存量的 removed 行留 NULL。NULL 按「不显示」处理,与这次改版之前的行为
-- 完全一致 —— 不会有旧数据凭空冒出来。
ALTER TABLE configs ADD COLUMN removed_by TEXT CHECK (removed_by IN ('owner','admin'));
