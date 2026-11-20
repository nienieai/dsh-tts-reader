# 语音朗读

给 DSH 的助手回复加一个朗读按钮，语音由 DeepSeek 官方 TTS 接口合成，音频缓存在本机。

## 做什么

- 助手消息操作行出现 🔊 按钮：第一次点击合成并播放，同时把 WAV 写入缓存。
- 同一个按钮再点一次：直接播放缓存（客户端 blob / Host 磁盘缓存），不请求接口。
- 设置 → 语音朗读：音色、单次字数上限、缓存占用与清空、Key 是否已配置。

## 怎么工作

```
浏览器 ──POST /api/dsh-tts/read {sessionId, messageId}──▶ Host
                                                        │ 1. sessionQuery 读会话日志取正文
                                                        │ 2. sha256(voice+text) 查磁盘缓存
                                                        │ 3. 未命中 → POST api.deepseek.com/v1/tools/tts
                                                        │ 4. 写缓存，回 WAV（x-tts-cache: hit|miss）
浏览器 ◀────────────── audio/wav ──────────────────────┘
```

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
