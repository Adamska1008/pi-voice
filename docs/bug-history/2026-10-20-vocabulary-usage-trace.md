# 2026-10-20：后台提词缺少 token 用量记录

- 状态：实现与离线测试完成；真实 provider usage 待验证。
- 提交：见 Git 历史 `Trace vocabulary token usage and expand vocabulary limits`。

## 背景与定位

Pi 主对话消息已有 usage，但插件单独发起的提词请求只记录输入字节数和结果数量。
`extractVocabulary()` 原先读取响应正文后丢弃 usage，无法核对额外 token 消耗。
因此只补插件自身记录，不重复记录主对话、不新增命令或统计界面。

## 实现

- `src/vocabulary-background.ts`：提词调用结束时通过现有 info 日志写一条
  `voice vocabulary usage: {JSON}`，复用日志级别、写入失败保护和轮转。
- 记录起始会话 ID、请求 UUID、provider、模型、耗时和 success/error/cancelled 状态。
  请求 UUID 同时用于独立模型请求的 sessionId；Pi 会话 ID 单独保留用于关联。
- 仅白名单记录 input/output/cacheRead/cacheWrite/totalTokens；无效或缺失值为 null，
  usageStatus 标识 reported 或 unknown-or-partial；不根据字符数估算，不补零。
- 在正文校验前捕获 usage，因此无效 JSON 或中止响应仍可保留已返回的用量。
  提交前就已取消或没有模型时，不发起请求，也不产生本记录。
- 不写入正文、词条、原始异常、认证信息或费用估算；不改调度与缓存。

## 验证与边界

- `npm test`：180 项，179 通过、1 跳过，包含 TypeScript 检查。
- 新测试覆盖成功、无效 JSON、usage 缺失、provider 抛错和取消；检查关联、耗时、隐私。
- 仅验证模拟响应，尚未验证当前真实 provider 的计数口径；reported 表示字段齐全，
  不保证计费完整性，尤其不能把 provider 返回的零值直接视作失败请求免费。
- 日志仍是 1 MiB 轮转并保留 `.1`，不是长期账本。
- 重载后完成一次真实提词，核对日志和会话 ID；分析时仅比较记录完整的同一时间区间。
  额外增幅为提词 totalTokens / 主对话 totalTokens；缓存单列，避免再加进 totalTokens。
  unknown/partial 请求须披露缺失，不能作为零消耗纳入精确比例。
