// 一份配置的下架与销毁,拆成过去被揉在一起的两步。
//
// 管理端的下架/永久删除(admin-configs.js)和 owner 自己的删除(configs.js)
// 都调这里,两条路因此不可能对「removed 到底意味着什么」产生分歧。
//
// 但它们对「是谁干的」必须有分歧 —— 那是 by 参数存在的理由,见下。

import { r2Key } from "./assets.js";

// 可逆的一步:配置退出所有公开界面,但一个字节都不动。
// 这里不碰 assets 行、不碰 R2 —— 那正是它存在的全部意义。
//
// by 是必填的,不给默认值:两个调用点的答案不同,而一个猜错的默认值会让
// 作者自己删掉的作品以「已被下架」的名义回到他自己的列表里。宁可加参数时
// 漏传就报错,也不要静默地猜。
export async function softTakedown(env, id, by) {
  await env.DB
    .prepare(
      "UPDATE configs SET status = 'removed', removed_by = ?, updated_at = datetime('now') WHERE id = ?"
    )
    .bind(by, id)
    .run();
}

// 不可逆的一步:销毁字节,并盖上 purged_at 的戳,好让之后的恢复能分辨
// 「已下架、资产还在」和「已下架、资产没了」。没有这个戳,一份从来就没有
// 资产的配置和一份资产被销毁的配置长得一模一样,管理端会对后者显示恢复
// 按钮,恢复出来是个空壳。
//
// 一个资产同时可能躺在 pending/ 或 approved/ 下(甚至更新途中两边都没有),
// 所以两个 key 一律都试;R2 删一个不存在的 key 是 no-op。
export async function purgeConfig(env, id) {
  const { results: assetRows } = await env.DB
    .prepare("SELECT kind FROM assets WHERE config_id = ?")
    .bind(id)
    .all();

  // assets_status 和 assets 行在同一个批次里一起归零。少了这一句,一份资产已
  // 经全部销毁的配置会继续把 'pending'/'approved' 挂在列上 —— 那是 schema 里
  // 「有资产,且处于某个审核阶段」的意思,而这一行现在一个资产都没有了。
  // 'none' 正是 0001_init.sql 给「没有资产」定义的那个值。
  await env.DB.batch([
    env.DB.prepare("DELETE FROM assets WHERE config_id = ?").bind(id),
    env.DB
      .prepare(
        `UPDATE configs
            SET purged_at = datetime('now'), assets_status = 'none', updated_at = datetime('now')
          WHERE id = ?`
      )
      .bind(id),
  ]);

  // R2 删除放在 D1 batch 提交之后:批次失败只会留下几个没人服务的孤儿对象
  // (assets 行还在,但下一次重试会再删一遍),而反过来先删字节再丢批次,
  // 会留下指向空处的 assets 行。
  for (const row of assetRows) {
    await env.R2.delete(r2Key("pending", id, row.kind));
    await env.R2.delete(r2Key("approved", id, row.kind));
  }
}
