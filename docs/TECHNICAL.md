# 技术文档

本文写给要改这个插件的人：结构、接口、缓存、引擎实现、测试与发版。普通用户看 [README](../README.md) 或 [安装说明](INSTALL.md) 就够了。

## 结构

插件由两个半组成，都打包在同一个目录里：

| 文件 | 运行位置 | 作用 |
|---|---|---|
| `index.js` | DSH Host 进程（Node） | 读会话、切段、调 TTS、写缓存、注册 HTTP 路由、SSE |
| `client.js` | DSH Web 客户端（浏览器） | 喇叭按钮、悬浮窗、高亮、设置页、事件订阅 |
| `bridge.html` | 独立浏览器页面 | 「朗读桥」：用浏览器语音朗读、自己的工具栏与高亮 |
| `cordis.patch.yml` | 安装时 | 把插件插入 Loader |
| `locale/*.json` | 插件列表/详情 | 标题、描述、详情文档路径 |
| `docs/` | 打包资源 | 本文、安装说明、详情页配图、`screenshots/` 界面截图 |

构建：没有构建步骤，`node --check` 通过即可加载。分发靠 `package.json` 的 `files`，`docs` 整个目录会随包发布。

## 朗读一条回复的流程

```
浏览器                       Host                         上游
  │ POST /plan {sessionId, messageId}                       │
  ├──────────────────────────▶│ 读会话 → markdown→纯文本 → 切段 │
  │◀── {units:[{index,text,chars}], total} ────────────────│
  │ POST /read {unit:i}                                    │
  ├──────────────────────────▶│ 命中缓存？                    │
  │                           ├─ 是 → 直接流式回 WAV/PCM ────│
  │                           └─ 否 → 调引擎合成 ───────────▶│
  │◀── audio/*（x-tts-cache: hit|miss|mixed）───────────────│
  │ Web Audio 排程播放；下一段在后台预取                      │
```

- 段落之间固定 `PLAYER_UNIT_GAP_MS = 60`，不写进缓存。
- 悬浮窗按段推进；有字词边界（boundary）的语音额外逐词高亮。
- 客户端随时可能停止：预取 promise 带 `catch`，流式写入同时等 `drain`/`close`/`error`，任何失败都不会变成 Host 的未处理拒绝。

## HTTP 路由

全部挂在 `/api/dsh-tts/` 下，只接受回环地址 + 同源请求（`guard`）。

| 路由 | 方法 | 说明 |
|---|---|---|
| `/config` | GET/POST | 读写设置；返回 `keyConfigured`，永不回传 Key |
| `/plan` | POST | 把消息切成朗读单元；正文按消息缓存 5 分钟 |
| `/read` | POST | 合成/回放一个单元；支持 `unitText` 直接合成 |
| `/cache/clear` | POST | 清空音频缓存（含固定提示语） |
| `/recent` | GET | 增量事件（`?after=<seq>`），SSE 断线兜底 |
| `/events` | GET | SSE：`assistant`、`approval`、`question`、`bridge-state` 等 |
| `/pending` | GET | 当前等待作答的提问/授权 |
| `/bridge` | POST | 把正文推给朗读桥（已有监听页则直接推送，否则打开一次页面） |
| `/bridge/stream` | GET | 朗读桥的 SSE 长连接 |
| `/bridge/ack` | POST | 朗读桥回执：`read` / `state` / `done` / `stop` |
| `/bridge/prefs` | POST | 主题与语言推送（只在朗读桥用过之后） |

`/bridge` 在已有监听页时最多等 1.2 秒回执，返回 `acked`；页面关闭时用 `pagehide` + `sendBeacon` 上报 `stopped`，Host 还会在最后一个监听断开 1.2 秒后兜底清理，避免 DSH 的喇叭一直停在波浪上。

## 段落切分

`stripMarkdown` → `separateBlocks` → `toParagraphs` → `planUnits`（`index.js`）：

1. 围栏代码块、表格、块级公式、图片等替换成固定提示语（「这里是代码块 / 表格 / 公式 / 图片」，mermaid 再按图类型细分），各自独立成段；
2. 标题保留编号（`### 3. 5V` 的 `3.` 是渲染文本，不是列表符号）；真正的列表/引用标记才剥掉；
3. 空行切段；列表项、标题行各自成段，保证「一段 = 页面上一块」；
4. 单段超过 `maxChars`（默认 4000）按句末标点再切，切不动才硬截断；
5. 配置了 Piper 英文模型时，再按文字种类拆成中/英单元。

切段结果必须能在渲染后的 DOM 里**从块首**匹配到（见「高亮」），所以改动切分规则时要同时跑 `planUnits` 与高亮的测试。

## 高亮与进度

- 段落/字词高亮用 CSS Custom Highlight API（`::highlight(dsh-tts-para)`、`::highlight(dsh-tts-word)`），不往 React 渲染的消息里插节点。
- `locateUnits` 在消息根节点的纯文本里按**块首**匹配每个单元；匹配不到（例如标题编号被吃掉）就会跳过该段的高亮。
- 没有字词边界时进度条按**字符**加权（`charStarts[i] / totalChars`）；有边界时用精确字符位置。

## 引擎

| 引擎 | 实现 |
|---|---|
| `deepseek` | `POST https://api.deepseek.com/v1/tools/tts`，`format: 'pcm'`；Host 补 WAV 头；Key 从 DSH 凭据 `DEEPSEEK_API_KEY` 取 |
| `bridge` | 不由 Host 合成：把正文推给浏览器里的朗读桥页面，用 Web Speech 朗读 |
| `browser` | 页面内 `speechSynthesis`；支持 boundary 的语音可逐词高亮 |
| `system` | Windows `System.Speech`、macOS `say`、Linux `espeak-ng`；输出解析成 16-bit PCM 并重采样到 24 kHz |
| `custom` | 四种协议：OpenAI 兼容、GPT-SoVITS（api_v2）、Fish Audio、自填模板（占位符 `{{text}}` 等） |
| `piper` | 本地可执行文件，`--output-raw` / `--output_raw` 都试；采样率取模型 JSON；可选英文模型按语言拆分 |

所有引擎统一 24 kHz 单声道、Int16、WAV 缓存。

## 缓存

- 页面内存：最近 8 条解码后的 PCM。
- Host 磁盘：`<DSH_HOME>/cache/dsh-tts/<sha256>.wav`，一段一个文件，默认 200 MB，按最久未用淘汰。
- 固定提示语：`<cache>/fixed/`，每个音色只合成一次，**不参与淘汰**。
- 缓存键带引擎身份：`piper:v2+模型指纹`、`system:v1+平台+语音`、`custom:v2+端点指纹+协议身份`；DeepSeek 用裸键以兼容旧缓存。速度不进键（变速在播放时做，不改音频）。
- 响应头 `x-tts-cache: hit|miss|mixed` 在发头前就算好。

## 朗读桥协议

- 页面通过 SSE（`/bridge/stream`）长连；Host 在 `/bridge` 时优先复用已开的页面。
- 页面回执 `/bridge/ack`：`read`（收到了）、`state`（`playing/paused/queued/blocked/finished/stopped` + 单元号、队列长度）、`done`、`stop`。
- Host 把 `state` 广播成 `bridge-state`，DSH 的喇叭据此显示波浪/暂停/排队/警告。
- 页面被浏览器拦截发声时上报 `blocked`，DSH 显示黄色感叹号；点过页面上的 ▶ 后恢复。
- 主题/语言通过 `/bridge/prefs` 单独推送（150 ms 去抖），只在朗读桥用过之后发送。

## 语言与主题

- 客户端 8 种语言：`MESSAGES` 按英文原文查表，`t(zh, en)` 调用点不变；缺译回落英文。
- 朗读桥同样 8 种：`I18N` 键集合与中文一致，跟随 `__BRIDGE_DATA__.lang` 与 `prefs` 推送。
- 主题：客户端读 `ctx.get('theme')`，取不到时按页面背景亮度判断，再用系统偏好兜底；推给朗读桥。
- 高亮的段落底色随主题重绘（深色 `rgba(96,165,250,.30)`、浅色 `rgba(37,99,235,.26)`）。

## 存储与安全边界

- 设置：`<DSH_HOME>/storages/dsh-tts-reader/settings.json`（不含 Key）。
- 自定义 API 的 Key：`secrets.json`，仅本用户可读；接口只回「已配置/未配置」。
- 所有路由：回环地址 + 同源；跨站无法触发。
- 会话正文只在本机读取，不额外落盘；发往上游的只有待朗读文本。

## 已知限制

- 只朗读最终消息的文本块，不含思考与工具过程；代码/表格/公式/图片以提示语代替。
- 选区跨到代码块时按选区原文合成，不命中提示语缓存。
- 官方 TTS 只有 `stella` / `tide`，且接口本身不支持语速；变速由播放端 WSOLA 完成（比例上限 4×，界面到 3×）。
- 朗读桥需要桌面端；Web 端没有这个引擎。

## 开发

```bash
node --check index.js
node --check client.js
```

本地安装（link 方式，改完刷新页面即可）：

```bash
dsh plugin --profile desktop add link:C:/path/to/dsh-tts-reader
```

改 `index.js` 要重启 DSH；改 `client.js` / `bridge.html` 刷新页面即可。

## 发版流程

`main` 只放已发布版本，`dev` 是开发线。

```bash
git checkout dev
# 改 package.json 的 version、CHANGELOG.md，并同步 README 徽章里的 version
git commit -am "chore: release 0.5.4"
git checkout main
git merge --no-ff dev -m "release: v0.5.4"
git tag -a v0.5.4 -m "dsh-tts-reader 0.5.4"
git checkout dev
git push origin dev main --tags
npm publish              # 在 main 上，走 npm 动态码；先出 0.0.0-stage 占位，几分钟后才有 0.5.3
```

约定：

- 版本号语义化：新能力升次版本号，修复升修订号；
- tag 一律 annotated；
- 只给确认稳定的版本打 tag；
- GitHub 仓库保持 `dsh-plugin` topic，插件市场靠它索引；
- npm 包名固定为 `dsh-tts-reader`，版本号必须与 tag 一致；npm 不允许同一版本发两次，重发前先升版本。
