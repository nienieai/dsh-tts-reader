# 语音朗读

给 DSH 的助手回复加一个朗读按钮，语音由 DeepSeek 官方 TTS 接口合成，音频缓存在本机。

## 做什么

- 助手消息操作行出现 🔊 按钮：第一次点击合成并播放，同时把 WAV 写入缓存。
- 同一个按钮再点一次：直接播放缓存（客户端内存 / Host 磁盘缓存），不请求接口。
- 设置 → 语音朗读：音色、每段字数上限、朗读速度（0.5×–2.0×）、自动朗读开关、中途输出也朗读、磁盘缓存上限（50–4096 MB）、缓存占用与清空、Key 是否已配置。
- 朗读速度：官方接口不支持语速，页面用 WSOLA（帧 1024、50% 重叠、±25% 相似度搜索、Hann 窗）在播放时做时长伸缩，音高不变；缓存键不含速度，换速度直接复用已缓存录音。
- 中英双语：文案走 `ctx.locale`（当前应用语言），不用 `navigator.language`；切换语言时通过 `ctx.locale.subscribe` 触发设置页与按钮重渲染，slot label 用 thunk 跟随语言。
- 设置导航图标：注册 `settings.section.icon`，id 与 `settings.section` 的 id 相同（`tts-reader`），按 `{ size, active }` 渲染内联 SVG。
- 打开自动朗读后，Host 监听 `session/event` 里的 `assistant/message`：每条都带 `final:false` 推送（中途输出），并在 `agent/status` 转 `idle` 时用 `final:true` 推送该回合最后一条。页面默认只播 `final:true`，因为只有最后一条会渲染官方操作行（`conversation.chat.assistant-actions` 只存在于 turn-tail），按钮一定在。
- 打开「中途输出也朗读」后，`final:false` 的消息依次播放；此时来了提问/审批，请求语音按**到达顺序**排队（严格 FIFO，中途输出先于请求），卡片按钮显示「等待上条朗读完成」，点击即切断当前音频并立刻朗读请求。
- 审批/提问被确认或撤回后（`approval/decided`、`tools/result`，或 `/pending` 变空），该条语音立即停止并出队，不会继续念完。
- 先选中文字再点喇叭：页面把选区连同 `sessionId`/`messageId` 一起发给 Host，Host 读正文、按同一套规则切段，再用选区首尾（先 80 字、退到 24 字）定位它覆盖的连续段，只合成这些整段——所以选区在段内任意位置都能命中整段文件。选区不在正文里（代码块、表格外的东西）时退回按选区原文合成。
- Agent 提问（`ask_user_question`）走 `tools/execute` 旁听：Host 抽出问题与选项，经 SSE 推给页面；开启时自动念。
- 审批请求（`approval/asked`）同样旁听：念「需要授权：<工具>，原因…」。
- 请求等待期间，按钮挂在请求卡片自己的头部行里（审批卡的状态行右端、提问卡的最小化/关闭左侧），用 `[data-approval-key]` / `[data-question-key]` 定位；`approval/decided` 或 `tools/result` 回来后按钮消失。

## 怎么工作

```
浏览器 ──POST /api/dsh-tts/read {sessionId, messageId | text}──▶ Host
                                                        │ 1. 取正文 → markdown 转纯文本
                                                        │ 2. 按空行切段；单段超限再按句切
                                                        │ 3. 每段 sha256(voice+段落) 查磁盘缓存
                                                        │ 4. 命中 → 读文件；未命中 → 调上游并 tee 落盘
                                                        │    下一段在当前段播放时预取
浏览器 ◀──── 裸 PCM：段 + 240ms 静音 + 段 …（x-tts-units / x-tts-cache）┘
        │
        └─ Web Audio：Int16→Float32 → AudioBuffer 排程播放
```

`x-tts-cache` 在发头前就能定：先 stat 一遍所有段文件，全命中 `hit`、全未命中 `miss`、否则 `mixed`。

页面按块排程（首块留 0.1 秒缓冲），网络落后于播放时从“现在”续上，不补播过去的时间。

自动朗读的消息来源有两条通道：`GET /api/dsh-tts/events`（SSE，低延迟）和 `GET /api/dsh-tts/recent?after=<seq>`（页面每 2.5 秒增量拉取）。页面把两者喂给同一个 `handleAssistant()`，用 `autoPlayed` 去重；SSE 断了也不会漏读。`/config` 里的 `sse` 字段（opened / closed / rejected / clients / recentSeq）用来判断页面是否真连上了事件流。

Key 只在 Host 进程里，从 DSH 凭据 `DEEPSEEK_API_KEY` 解析；接口基址固定，路由不接受改地址的请求。

## 边界

- 只接受回环地址 + 同源浏览器请求；跨站页面无法触发合成。
- 缓存默认上限 200 MB，超出按最旧文件淘汰；一个段落一个文件，段落数多时文件数会明显变多。
- 每段上限 4000 字（单段超限按句切分，切不动才硬截断）。
- 段落之间固定 240 ms 静音（`PARAGRAPH_GAP_MS`），不写进缓存文件。
- 只有 `stella` / `tide` 两个官方音色。

## 已知限制

- 只念最终消息的文本块，不含思考与工具过程。
- 送上游前先做 markdown → 纯文本：围栏代码块（含 mermaid）、整块表格、块级公式 `$$…$$`/`\[…\]`、HTML 标签、脚注定义与 `[^n]` 标记都会去掉；行内代码与行内 `$…$` 保留。
- 需要账号可调用 `/v1/tools/tts`。
