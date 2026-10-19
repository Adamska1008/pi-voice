# 2026-10-20：新版 Pi 自动词表提取丢失系统指令

- 修复提交：`e3ae9f1`（Fix vocabulary extraction context normalization on newer Pi）。
- 状态：代码修复、离线验证完成；2026-10-20 真实提词、检查点及 ASR 输入已确认。
- 环境差异：项目开发依赖 Pi coding-agent 0.83.0，实际宿主 Pi 1.3.0。

## 背景与现象

项目已支持固定词表、对话自动提词、词表 LRU/会话检查点，以及 ASR 上下文输入。
用户完成多轮语音对话后，希望确认这些增强功能是否实际生效。
转写正常，但会话中没有自动词表检查点，随后 UI 显示：
`Voice vocabulary extraction failed; keeping previous terms.`

影响范围是自动提词请求；固定词表和 ASR 对话上下文是独立路径。
当时日志确认固定词表和非空上下文已传入 ASR，自动词表仍为空。

## 定位过程

1. 对照录音/转写日志与会话事件，确认转写成功、消息提交和回复结束。
   缺少词表检查点本身不能区分未触发、失败或空结果。
2. 增加 info 级诊断：用户轮次、agent settled、提词调度、结果数量、失败类别、
   检查点写入、词表合并数量、ASR 实际传入词数和上下文 token 数。
   仅记录计数及受控类别，不输出正文、词条、原始模型响应或凭据。
3. `/reload` 后日志显示请求已触发，鉴权完成，但返回文本解析失败：`invalid-json`。
   因此问题不在录音、ASR 参数注入或未触发的调度器。
4. 检查实际宿主 Pi 1.3.0 的 registry、runtime、provider 和上下文转换实现，
   发现扩展使用旧式调用，直接把含 `systemPrompt` 的原始 context 交给底层 provider。
5. 用本机 Pi 1.3.0 实现离线截获请求体：旧调用的 instructions 变成通用助手指令，
   经 registry 调用则保留提词指令。使用合成凭据，并在发送前终止；无网络请求。

## 根因

新版底层 provider 期望已转换的 transcript：系统指令位于开头的 system 消息。
`ModelRuntime.streamSimple()` 调用 `normalizeContext()`，负责把 `Context.systemPrompt`
转换成该消息；`ModelRegistry.streamSimple()` 是扩展使用的上层入口。

原实现直接调用 `provider.streamSimple()`，绕过转换，导致“提取术语、只返回 JSON 数组”
的指令丢失。解析器仍要求 JSON，因而出现失败。
原始失败响应没有保存，不能断言其具体文字；指令丢失已由请求体离线复现确认。
旧版类型检查和只模拟旧 provider 的测试未覆盖新版宿主的上下文转换契约。

## 修复方法

- [vocabulary-background.ts](../../src/vocabulary-background.ts)：优先调用 registry 的
  `streamSimple()`，由 Pi 负责指令转换和请求时鉴权。
- 仅当该方法不存在时使用旧 provider 路径，保留 Pi 0.83.0 兼容性。
  新接口请求失败不回退旧路径，避免丢失指令或重复请求。
- 保留严格 JSON 校验、来源词过滤、超时、取消、缓存和调度策略。
  没有通过宽松解析普通回答来掩盖缺失指令的问题。
- [回归测试](../../test/vocabulary-background.test.ts)覆盖新接口选择、指令与参数传递、
  鉴权归属、取消、失败不回退，以及旧版路径和诊断隐私。

## 验证与边界

- `npm test`：178 项，177 通过，1 跳过；包含 TypeScript 检查。
- 本机 Pi 1.3.0 离线请求体对照：旧调用丢失指令，registry 调用保留指令。
- Windows 沙箱默认临时目录出现 `rename EPERM`；将测试进程的 `TEMP`/`TMP`
  指向项目内临时目录后全量通过，结束后已清理。未修改生产文件操作逻辑。
- 初次修复时尚未确认真实模型响应、自动词表检查点及后续 ASR 自动词注入；
  后续复测结果见下节。
  参数传入成功也不代表识别准确率一定提高。

## 真实语音复测

1. 在加载本地项目包的 Pi 会话运行 `/reload`，无需重新安装。
2. 语音完成一轮包含技术术语的对话，回复结束后留出约 35 秒供提词完成。
3. 核对 `dispatching via model registry`、`extraction completed` 和检查点记录。
   若结果为空，结合对话内容判断；不能仅凭无 warning 判定词表已更新。
4. 再录一轮，核对 `automatic`/`automaticAdded`、ASR `applied` 和上下文 `tokens`。
   自动词与固定词重复时，`automaticAdded=0` 可能正常。
5. 确认后在本记录及索引补充复测日期、结果和必要的技术摘要。

## 2026-10-20 真实链路复测结果

以下时间为北京时间；仅记录诊断计数，不保存会话正文或词条。

- 01:43:50 重载完成；01:44:29 提词通过 model registry 发起。
- 01:44:34 提词成功：`extracted=10 cached=10`，会话检查点保存 10 个词。
- 第二次录音在 01:44:30 开始，早于提词完成，因此仍使用 26 个固定词。
  录音开始时快照固定，录音中完成的提词留给下一次使用，符合设计。
- 01:45:05 第二轮回复后检查点再次写入；已知词的来源消息 ID 更新，验证提及刷新。
- 01:45:07 后续录音快照：`manual=26 automatic=10 automaticAdded=8 merged=34`。
  其中两个自动词与固定词重复，去重后新增 8 个。
- 01:45:25 ASR 接收 `offered=34 applied=34`；上下文 `tokens=997 applied=true`。
  重载后的前两次录音分别传入 614、919 tokens，证明上下文随对话重新生成。
- 结论：自动提词、会话持久化、后续录音词表注入和上下文输入均已走通。
  未测量识别准确率提升，也未在本次验证 LRU 满容量淘汰或再次重载恢复。
