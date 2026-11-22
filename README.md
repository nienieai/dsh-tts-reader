# 语音朗读（dsh-tts-reader）

给 DSH 的每条助手回复加一个喇叭按钮，用 DeepSeek 官方 TTS 接口把回复念出来。

- **流式播放**：Host 把上游 PCM 边收边转给页面，页面用 Web Audio 按块排程，首句到达就出声，不用等整段合成完。
- **本地引擎（可选）**：不联网也能念。自己装好 [Piper](https://github.com/OHF-Voice/piper1-gpl) 和一个语音模型，在设置里把引擎切成「本地 Piper」并填两个路径即可；Host 调 `piper.exe` 合成，转成 24 kHz 后走同一套段落缓存（缓存键带引擎，云端与本地互不串）。
- **变速不变调**：设置里有 0.5×–2.0× 速度滑杆，用 WSOLA 做时长伸缩（官方 TTS 接口没有语速参数），录音缓存仍是原始速度。
- **两级缓存**：页面把解码后的 PCM 留在内存（最多 8 条），再点是纯内存重播；Host 按**段落**存 WAV，一条消息有几个段落就有几个文件，刷新页面后仍命中（响应头 `x-tts-cache: hit`）。磁盘上限可自己设（默认 200 MB）。
- **自动朗读**：设置里打开后，默认只朗读回合结束的最后一条（那一条必然带官方操作行和喇叭按钮）；另有「中途输出也朗读」开关，打开后回合中间的每段输出依次朗读，且提问/授权会排在它后面，卡片按钮显示「等待上条朗读完成」，点一下即切断并立刻朗读该请求。
- **选中即读整段**：先选中文字再点喇叭，会朗读选区**所在的整段**（跨段就整段连着读）——Host 按同一套切段规则把选区扩到段落边界，所以选一段里任意几个字都能命中整条朗读时存的段落文件。选区落在代码块等正文之外时，才退回只念选中的那点文字。
- **提问 / 授权播报**：Agent 用 `ask_user_question` 提问时念出问题与选项；出现审批请求时念一句「需要授权：<工具>，原因…」。两项可各自关闭，且会抢占正在播放的回复。等待回答期间，屏幕右上角出现「朗读问题 / 朗读授权」浮动按钮（弹窗会盖住输入框，所以它挂在页面顶层），可随时重播，答复后自动消失。
- **Key 不出 Host**：浏览器只发 `sessionId` + `messageId`，由 Host 从会话日志里取正文、再用 DSH 凭据（`DEEPSEEK_API_KEY`）调用 `POST https://api.deepseek.com/v1/tools/tts`。页面看不到 Key，也拿不到可改接口地址的开关。
- **只走官方接口**：固定 `api.deepseek.com`，`format: 'pcm'`，Host 自己补 WAV 头；Host 先把 markdown 转成纯文本（跳过代码/表格/公式/脚注，去 HTML 标签）再按段落送上游，这样"选中的渲染文本"和"消息里的 markdown"能算出同一个缓存键。

## 功能

| 位置 | 作用 |
|---|---|
| 助手消息操作行 | 🔊 点一下朗读；选中文字后点读它所在的整段；播放中再点停止 |
| 设置 → 语音朗读 | **引擎（DeepSeek 云 / 本地 Piper / 系统语音 / 自定义 API）**、各引擎自己的音色与路径、**试听**、每段字数上限、**朗读速度（0.5×–2.0×，无变调）**、**自动朗读开关**、**中途输出也朗读**、**磁盘缓存上限（50–4096 MB）**、查看占用、清空缓存、Key 是否已配置；导航项带自定义 SVG 图标，界面文案跟随应用语言（中/英） |

## 引擎

| 引擎 | 需要什么 | 联网 | 适合 |
|---|---|---|---|
| **DeepSeek 云** | DSH 里配置的 `DEEPSEEK_API_KEY` | ✅ | 默认，音色 stella / tide |
| **本地 Piper** | 自备 piper 与模型（见下） | ❌ | 免费离线；可再填一个英文模型解决英文读音 |
| **系统语音** | 无，用系统已装语音包 | ❌ | 零下载、中英混读正常；机械感重 |
| **自定义 API** | OpenAI 兼容端点 + Key | ✅ | 想要 Azure/OpenAI/SiliconFlow 等自然语音 |

系统语音按平台调用：Windows 用 `System.Speech`（SAPI，语音来自系统安装的语言包，例如中文的 `Microsoft Huihui`）、macOS 用 `say`、Linux 用 `espeak-ng`；某一平台没有可用语音时设置页会直接标「没有可用的系统语音」，不会假装就绪。

自定义 API 支持四种协议（设置里先选「协议」）：

| 协议 | 请求 | 说明 |
|---|---|---|
| **OpenAI 兼容** | `POST {base}/v1/audio/speech`，`{model,input,voice,response_format}` | OpenAI / Azure OpenAI / SiliconFlow / Groq 等 |
| **GPT-SoVITS** | `POST {base}/tts`（api_v2），`{text,text_lang,ref_audio_path,prompt_text,prompt_lang,media_type}` | 本地自部署；参考音频填的是**服务端**上的路径 |
| **Fish Audio** | `POST {base}/v1/tts`，`{text,model,reference_id,format}` | 远程服务，需要 Key |
| **自定义模板** | 自己填方法 / 路径 / 请求头 / 请求体 | 占位符 `{{text}} {{voice}} {{model}} {{format}} {{lang}}`；GET 时请求体变成查询串（自动编码） |

**回环地址**（`127.0.0.1`、`localhost`、`::1`）不需要 Key，其它地址必须填。Key 存在 `~/.dsh/storages/dsh-tts-reader/secrets.json`（仅本用户可读），设置接口只回「已配置 / 未配置」，不回传明文、不写日志。返回 MP3/ADTS 会明确报错而不是放出噪声；模板协议可以指定「自动识别 / WAV / PCM（24 kHz 裸流）」。

Piper 还可以再填一个「英文模型」：一个中文声学模型读英文会读成无意义音节，所以配置后会按语言把段落切成若干段分别合成——纯英文的部分交给英文模型，含中文的部分仍用中文模型，各自独立缓存。

引擎卡里还有一行「试听」：用**当前引擎和音色**念一句固定的中英混读样本（`你好，这是一段语音试听，用来确认音色。Hello, this is a preview.`），播放中再点即停止。样本走同一条 `/read` 路由并照常缓存，所以换引擎前后各点一次就能直接对比听感，第二次点不会有任何合成开销。

不朗读的块会念一句提示音，而不是静默跳过：代码块「这里是代码块」、表格「这里是表格」、块级公式「这里是公式」、图片「这里是图片」，mermaid 按图类型细分为时序图 / 流程图 / 类图 / 状态图 / ER 图 / 甘特图 / 饼图 / 思维导图 / 时间线 / Git 分支图，其余统称 Mermaid 图表。这些提示语是固定字符串、各自独立成段，**每个音色只合成一次**（一条消息里出现三个表格也只合成一次），缓存放 `~/.dsh/cache/dsh-tts/fixed/`，**永不参与按上限淘汰**（只有手动「清空缓存」会清掉）。

## 用法

装好后在任意助手回复下方点喇叭即可。第二次点同一个按钮走本地缓存：

- 页面对已播放过的消息保留解码后的 PCM，再点立刻重播（不发请求）；
- 没在内存里的（例如刷新过页面）会向 Host 再要一次，Host 按段落命中磁盘缓存就直接流式回放，不调用接口（响应头 `x-tts-cache: hit`；部分命中为 `mixed`）。
- 段落之间插 240 ms 静音，下一段在当前段播放时就已经在合成（响应头 `x-tts-units` 是段数）。
- 同一段文字、同一音色永远命中已有文件，不会重复合成，也不会互相覆盖；只有超过缓存上限时，最久未用的普通段落才会被淘汰（提示语不在此列）。

## 本地引擎（Piper）

不联网也能念，代价是要自己装一套 Piper：

1. 取一个 Piper 可执行文件（[piper1-gpl](https://github.com/OHF-Voice/piper1-gpl) 的 CLI，或旧版 [rhasspy/piper](https://github.com/rhasspy/piper) 发布的 `piper_windows_amd64.zip`），解压到任意目录；
2. 下载一个语音模型，例如 `zh_CN-huayan-medium.onnx`，**与同名 `.json` 放在同一目录**；
3. 打开 设置 → 语音朗读，引擎选「本地 Piper」，填「程序」与「模型」两个路径，右侧出现「已找到」即就绪；
4. 点喇叭就是离线合成。

可选：再填一行「英文模型」（同一个目录里带同名 `.json` 的 `.onnx`，例如 `en_US-lessac-medium`），纯英文段落就会交给它读；不填则英文也走中文模型，会读成怪音。

同一步骤在设置里也有：本地引擎下的「安装帮助 → 离线安装说明」打开一个弹窗，写着这三步、磁盘占用（花颜 ≈97 MB，超文/小雅 ≈660 MB 含 `g2pW` 与分词器）和镜像提示，不用翻文档。

说明：

- 插件**不分发** piper 与模型；它们各自的许可证（Piper 为 GPL-3.0、espeak-ng 为 GPL-3.0、语音模型另有条款）由安装者自行遵守；
- 采样率从 `<模型>.onnx.json` 里读，Host 重采样到 24 kHz——页面、WSOLA 与缓存只认这一种速率；
- 本地合成失败会直接报错，不会悄悄改用云端，避免声音来源不明；
- Piper 官方的中文音色共 4 个，放在同一个目录里会出现在「音色模型」下拉中：

| 音色 | 性别 | 备注 |
|---|---|---|
| `zh_CN-huayan-medium`（花颜） | 女 | 2023 版 Windows 二进制也能跑，每段约 3 秒 |
| `zh_CN-chaowen-medium`（超文） | 男 | 需要新版 piper（pip 版 1.8）与下方资源，每段约 10 秒 |
| `zh_CN-xiao_ya-medium`（小雅） | 女 | 同上 |
| `zh_CN-huayan-x_low`（花颜低配） | 女 | 质量更低，一般不用 |

`chaowen` / `xiao_ya` 额外需要两份资源（约 250 MB）：

1. `g2pW/`：放在**模型目录**下，内含 `g2pw.onnx` 等文件（piper 按 `cwd/g2pW` 查找，插件会把工作目录设成模型目录）；
2. `bert-base-chinese` 分词器：进入 HuggingFace 缓存（`~/.cache/huggingface`），可由 `huggingface_hub.snapshot_download` 只下载 `vocab.txt`、`config.json` 等小文件。

缺少这些资源时 piper 会报错，插件把 stderr 原样带出来。

## 数据与安全

- 会话正文只在本机 Host 内读取，不额外落盘；发往上游的只有要朗读的那段文字。
- 音频缓存在 `<DSH_HOME>/cache/dsh-tts/<sha256>.wav`，**一段一个文件**，默认上限 200 MB，超出按最旧文件淘汰。
- 插件自己的设置存在 `<DSH_HOME>/storages/dsh-tts-reader/settings.json`（不含 Key）。
- 所有路由只接受**回环地址 + 同源**请求，跨站页面无法触发合成或改配置。

## 已知限制

- 只朗读最终消息的文本块，思考过程、工具调用不会被念。以下内容会被跳过：围栏代码块（含 ```mermaid 图）、表格整块、块级公式（`$$…$$`、`\[…\]`）、HTML 标签（保留文字）、脚注定义与正文里的 `[^n]` 标记；行内代码与行内 `$…$` 照常念。
- 文本按空行切段，一段一次请求、一个缓存文件；单段超过「每段上限」（默认 4000 字）会按句末标点再切，实在切不动才硬截断（响应头 `x-tts-truncated: 1`）。
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

## 发版流程

仓库只有两条长期分支，历史不再是一条直线：

| 分支 | 用途 |
|---|---|
| `main` | **只放已发布版本**。发布提交上打 tag，可随时检出使用 |
| `dev` | 日常开发。版本号、CHANGELOG 都先在这里改 |

发布一个版本：

```bash
# 1. 在 dev 上改 version / CHANGELOG，并确认能加载
git checkout dev
#    编辑 package.json 的 version 与 CHANGELOG.md

# 2. 合并到 main（保留合并点，便于看出一版包含哪些提交）
git checkout main
git merge --no-ff dev -m "release: v0.2.23"

# 3. 在合并提交上打 annotated tag
git tag -a v0.2.23 -m "dsh-tts-reader 0.2.23"

# 4. 回到开发线
git checkout dev
```

约定：

- 版本号用语义化版本：新增能力升次版本号（`0.2.x` → `0.3.0`），修复只升修订号；
- tag 一律 **annotated**（`git tag -a`），轻量 tag 不带发布信息；
- 提交信息前缀里带版本号（如 `fix(0.2.22): ...`），便于事后按版本检索；
- 只给**确认稳定**的版本打 tag；目前只有 `v0.2.22`（指向 `main` 的发布提交）。

## License

MIT，见 [LICENSE](LICENSE)。

本插件是**非官方社区项目**，与 DeepSeek（深度求索）没有隶属或背书关系；名称里的 "DeepSeek" 只用于说明它对接的接口。插件通过 DSH 的公开插件接口接入，并调用 DeepSeek 开放平台的 TTS 接口；参考过的 MIT 开源项目（chat-demo、deepseek-harness）及各自的版权声明见 [THIRD_PARTY.md](THIRD_PARTY.md)。
