# 语音朗读

给 DSH 的助手回复加一个朗读按钮，语音由 DeepSeek 官方 TTS 接口合成，音频缓存在本机。

## 做什么

- 助手消息操作行出现 🔊 按钮：第一次点击合成并播放，同时把 WAV 写入缓存。
- 同一个按钮再点一次：直接播放缓存（客户端内存 / Host 磁盘缓存），不请求接口。
- 设置 → 语音朗读：音色、单次字数上限、自动朗读开关、磁盘缓存上限（50–4096 MB）、缓存占用与清空、Key 是否已配置。
- 打开自动朗读后，Host 监听 `session/event` 里的 `assistant/message`，通过 SSE 告诉页面“这条消息好了”，页面按当前会话过滤后自动开播；切换会话立刻停播。
- 先选中文字再点喇叭：页面把选中的片段作为 `text` 发给 Host，只合成这一段（缓存按 消息 + 片段哈希 分键）。
- Agent 提问（`ask_user_question`）走 `tools/execute` 旁听：Host 抽出问题与选项，经 SSE 推给页面；开启时自动念，同时在输入框上方显示「朗读问题」按钮（`tools/result` 回来后按钮消失）。
- 审批请求（`approval/asked`）同样旁听：念「需要授权：<工具>，原因…」，会抢占正在播放的回复。

## 怎么工作

```
浏览器 ──POST /api/dsh-tts/read {sessionId, messageId}──▶ Host
                                                        │ 1. sessionQuery 读会话日志取正文
                                                        │ 2. sha256(voice+text) 查磁盘缓存
                                                        │ 3. 命中 → 跳过 WAV 头，流式回 PCM
                                                        │ 4. 未命中 → POST api.deepseek.com/v1/tools/tts
                                                        │    边收边转给页面，同时 tee 进 WAV 缓存
浏览器 ◀──── 裸 PCM 块（x-tts-cache / x-tts-sample-rate）──┘
        │
        └─ Web Audio：Int16→Float32 → AudioBuffer 排程播放
```

页面按块排程（首块留 0.1 秒缓冲），网络落后于播放时从“现在”续上，不补播过去的时间。

Key 只在 Host 进程里，从 DSH 凭据 `DEEPSEEK_API_KEY` 解析；接口基址固定，路由不接受改地址的请求。

## 边界

- 只接受回环地址 + 同源浏览器请求；跨站页面无法触发合成。
- 缓存默认上限 200 MB，超出按最旧文件淘汰。
- 单次朗读上限 4000 字（超出截断）。
- 只有 `stella` / `tide` 两个官方音色。

## 已知限制

- 只念最终消息的文本块，不含思考与工具过程。
- 代码块由服务端 `filter_markdown` 跳过，不会念出来。
- 需要账号可调用 `/v1/tools/tts`。
