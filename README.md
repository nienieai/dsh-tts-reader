# 语音朗读（dsh-tts-reader）

给 DSH 的每条助手回复加一个喇叭按钮，用 DeepSeek 官方 TTS 接口把回复念出来。

- **音频缓存**：第一次点会合成并把 WAV 存到本机；同一个按钮再点一次直接播缓存，不再请求接口。刷新页面后依然命中（缓存按「音色 + 文本」的 sha256 存在磁盘上）。
- **Key 不出 Host**：浏览器只发 `sessionId` + `messageId`，由 Host 从会话日志里取正文、再用 DSH 凭据（`DEEPSEEK_API_KEY`）调用 `POST https://api.deepseek.com/v1/tools/tts`。页面看不到 Key，也拿不到可改接口地址的开关。
- **只走官方接口**：固定 `api.deepseek.com`，`format: 'pcm'`，Host 自己补 WAV 头；`filter_markdown: true` 让服务端跳过代码块、表格和公式。

## 功能

| 位置 | 作用 |
|---|---|
| 助手消息操作行 | 🔊 点一下朗读，转圈表示合成中，播放中再点停止 |
| 设置 → 语音朗读 | 选音色（stella / tide）、改单次字数上限、查看缓存占用、清空缓存、显示 Key 是否已配置 |

## 用法

装好后在任意助手回复下方点喇叭即可。第二次点同一个按钮走本地缓存：

- 客户端保留 blob URL，同一次页面会话里立刻重播；
- Host 侧磁盘缓存让刷新页面后也不重复调用接口（响应头 `x-tts-cache: hit`）。

## 数据与安全

- 会话正文只在本机 Host 内读取，不额外落盘；发往上游的只有要朗读的那段文字。
- 音频缓存在 `<DSH_HOME>/cache/dsh-tts/<sha256>.wav`，默认上限 200 MB，超出按最旧文件淘汰。
- 插件自己的设置存在 `<DSH_HOME>/storages/dsh-tts-reader/settings.json`（不含 Key）。
- 所有路由只接受**回环地址 + 同源**请求，跨站页面无法触发合成或改配置。

## 已知限制

- 只朗读最终消息的文本块，思考过程、工具调用、代码块不会被单独念（代码块由服务端的 `filter_markdown` 跳过）。
- 一次请求的文本上限 4000 字，超出按字数截断（响应头 `x-tts-truncated: 1`）。
- 官方 TTS 只有 `stella` / `tide` 两个音色，不支持语速调节。
- 需要账号本身能调用 `/v1/tools/tts`（额度与地区限制另算）。

## 开发

```bash
node --check index.js
node --check client.js
```

安装到 profile：

```bash
dsh plugin --profile desktop add link:C:/Embedded/dsh-tts-reader
```

（或通过 Plugin Manager 的安装入口；安装后需刷新页面让 Client 半加载。）

## License

MIT
