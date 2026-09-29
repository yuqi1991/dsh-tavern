# 第三项第二批：失败生成尾部清理

状态：开发与离线验证完成，待独立部署授权；第三项整体仍未完成。

失败生成没有提交 Story Round。开启 conversationAlgebra 时，临时尾部清理计划通过 `planRegenerationAttemptCleanup` 转成单个受保护的 `runTransaction`，沿用宿主 surface replace 和 G5 合法 user 墓碑；flush、expectedHead、detached 预检和恢复标记由事务层负责。关闭开关及旧 Chat 意图继续使用兼容清理，便于已存在的旧 `regenRecovery` 数据恢复。

新增真实宿主 Session 回归：失败尾部清理后的 fold 只保留原输入和已提交正文，重启恢复不重复追加。完整开发副本 121 项测试全绿。运行安装尚未部署。

本批不迁移重生成成功提交的 `complete` 投影、不删除 `regeneration-recovery.js`，也不改 reroll 生成流程；它们仍属于后续独立接线。部署白名单和验证结果待下一步生成。
