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
- 引擎：`engine` 为 `deepseek` 时走云端流式接口；为 `piper` 时 spawn 用户自备的 `piper.exe`（`--model <模型> --output-raw`，老版本用 `--output_raw`，两个都试、成功哪个记哪个），把 stdin 喂进文本、stdout 收裸 PCM；模型采样率从 `<模型>.json` 读取并流式重采样到 24 kHz。缓存键在非 deepseek 引擎前加引擎前缀，云端与本地互不串。
- 系统语音（`engine: 'system'`）：Windows 用 `powershell -NoProfile -Command` 调 `System.Speech`（SAPI，`GetInstalledVoices` 列语音，合成写临时 WAV 后读回）；macOS 用 `say --file-format=WAVE --data-format=LEI16@22050`；Linux 用 `espeak-ng --stdin -w`。输出统一经 `parseWav` 解析（只接受 16-bit PCM）、多声道下混单声道、重采样到 24 kHz。语音清单按平台缓存 5 分钟（枚举要起进程）。
- 自定义 API（`engine: 'custom'`）：四种协议由 `customProtocol` 选择，`buildCustomRequest` 统一算出 URL / headers / body。`openai` 打 `{base}/v1/audio/speech`；`gpt-sovits` 打 `{base}/tts`（api_v2：`text_lang`、`ref_audio_path`、`prompt_text`、`prompt_lang`、`media_type: wav`）；`fish` 打 `{base}/v1/tts`（`model`、`reference_id`、`format: wav`）；`template` 由用户填方法/路径/请求头/请求体，占位符 `{{text}}` 等，JSON 模板先 parse 再替换（文本里的引号不会破坏请求），GET 时转成 URL 编码的查询串。响应按 `audioType` 处理：`wav` 必须能解析、`pcm` 按 24 kHz 裸流、`auto` 先嗅 WAV 否则当 PCM，MP3/ADTS 直接报错。Key 存 `secrets.json`（0600），`/config` 只回 `keyConfigured`；**回环地址（127.0.0.1 / localhost / ::1）免 Key**，其余地址缺 Key 直接报 `NO_KEY` 不发请求。缓存键 `custom:v2 + 端点指纹 + 协议相关身份`（SoVITS 带参考音频/参考文本/语言，Fish 带 model/reference_id，模板带方法/路径/请求体）。
- Piper 双模型：配置 `piperModelEn` 后切段时按文字种类拆成若干 unit（`splitByScript`，短于 2 个字母/汉字的片段并入相邻段），纯英文 unit 走英文模型，其余走中文模型；缓存键用该 unit 实际使用的模型指纹。
- 每个引擎的缓存键都带自己的身份：`piper:v2+模型指纹`、`system:v1+平台+语音`、`custom:v1+端点哈希+模型+音色+格式`；DeepSeek 保持裸键以兼容旧缓存。
- 先选中文字再点喇叭：页面把选区连同 `sessionId`/`messageId` 一起发给 Host，Host 读正文、按同一套规则切段，再用选区首尾定位它覆盖的连续段，只合成这些整段——所以选区在段内任意位置都能命中整段文件。选区不在正文里（代码块、表格外的东西）时退回按选区原文合成。
- Agent 提问（`ask_user_question`）走 `tools/execute` 旁听：Host 抽出问题与选项，经 SSE 推给页面；开启时自动念。
- 审批请求（`approval/asked`）同样旁听：念「需要授权：<工具>，原因…」。
- 请求等待期间，按钮挂在请求卡片自己的头部行里（审批卡的状态行右端、提问卡的最小化/关闭左侧），用 `[data-approval-key]` / `[data-question-key]` 定位；`approval/decided` 或 `tools/result` 回来后按钮消失。

## 怎么工作

```
浏览器 ──POST /api/dsh-tts/plan {sessionId, messageId | text}──▶ Host
                                                        │ 1. 取正文 → markdown 转纯文本
                                                        │ 2. 按空行切段（piper 双模型时再按文字种类切）
                                                        │ 3. 返回 [{index, text, chars}] + total
浏览器 ──POST /api/dsh-tts/read {…, unit: i}──▶ Host
                                                        │ 4. 只流这一段的 PCM（缓存命中就直接读文件）
                                                        │    下一段在页面侧预取（第二路请求，命中缓存时几乎瞬时）
浏览器 ◀──── 裸 PCM（单段；x-tts-units 是总段数，x-tts-unit-index 是本次段号）┘
        │
        └─ Web Audio：Int16→Float32 → AudioBuffer 排程；悬浮窗控制暂停/前后段/变速
```

`x-tts-cache` 在发头前就能定：先 stat 一遍这一段（或整段集合）的文件，全命中 `hit`、全未命中 `miss`、否则 `mixed`。

**播放器按段**：页面保留当前段的全部 Float32 样本；`/plan` 拿段清单，`/read?unit=i` 流式播放第 i 段，播放中预取第 i+1 段。段落之间留 180 ms。

- **暂停/继续**：`AudioContext.suspend()/resume()`，时间轴冻结，恢复后从原处继续。
- **变速立即生效**：把「已播输出时长 × 旧速度」换算成源样本偏移，停掉尚未播完的已排程 buffer，用新比例重建 WSOLA 并从该偏移重新排程（衔接点最多一个调度窗口）。速度同时写回设置（350 ms 防抖），供以后朗读使用。
- **上一段/下一段**：只在本条回复内，越界按钮置灰；切换会中断当前段请求并播放目标段（预取命中时无等待）。
- 悬浮窗是可拖动的顶层 `popover`，位置存 `localStorage`；× 停止并清空自动朗读队列。

自动朗读的消息来源有两条通道：`GET /api/dsh-tts/events`（SSE，低延迟）和 `GET /api/dsh-tts/recent?after=<seq>`（页面每 2.5 秒增量拉取）。页面把两者喂给同一个 `handleAssistant()`，用 `autoPlayed` 去重；SSE 断了也不会漏读。`/config` 里的 `sse` 字段（opened / closed / rejected / clients / recentSeq）用来判断页面是否真连上了事件流。

Key 只在 Host 进程里，从 DSH 凭据 `DEEPSEEK_API_KEY` 解析；接口基址固定，路由不接受改地址的请求。

## 边界

- 只接受回环地址 + 同源浏览器请求；跨站页面无法触发合成。
- 缓存默认上限 200 MB，超出按最旧文件淘汰；一个段落一个文件，段落数多时文件数会明显变多。
- 提示语（`BLOCK_MARKERS`）的音频单独放 `<cache>/fixed/`，按引擎 + 模型指纹 + 音色分键，**不参与按上限淘汰**；只有「清空缓存」才删除它们。
- 朗读的 PCM 响应带 `cache-control: no-store, no-transform`，宿主的 gzip 中间件会跳过它：音频压缩没有收益，流式响应被包一层 Transform 反而会把背压监听堆在 Gzip 上。
- 客户端随时可能停止播放：预取 promise 带 catch、流式写入同时等待 `drain`/`close`/`error`、每个路由有兜底 catch，任何一条路径的失败都不会变成宿主的未处理拒绝（那会被当成致命加载错误并直接退出进程）。
- 每段上限 4000 字（单段超限按句切分，切不动才硬截断）。
- 段落之间固定 180 ms 间隔，不写进缓存文件。
- 悬浮窗只在网页前台可用：页面被隐藏时浏览器会节流计时器，跨段的 180 ms 间隔可能被拉长；音频本身已排程，不受影响。
- 本地引擎的 piper 与语音模型由用户自行安装，插件不下载、不分发。
- 只有 `stella` / `tide` 两个官方音色。

## 已知限制

- 只念最终消息的文本块，不含思考与工具过程。
- 送上游前先做 markdown → 纯文本：围栏代码块、整块表格、块级公式 `$$…$$`/`\[…\]`、图片、HTML 标签、脚注定义与 `[^n]` 标记都不会被逐字念出；前四类改为一句固定提示音（代码块 / 表格 / 公式 / 图片，mermaid 再按时序图、流程图、类图、状态图、ER 图、甘特图、饼图、思维导图、时间线、Git 分支图细分），行内代码与行内 `$…$` 保留。提示音各自独立成段、只合成一次。
- 选区跨到代码块/表格时，选区文字是页面上的原文而不是提示音，因此会退回「按选区原文合成」，不会命中整条朗读时的提示音缓存。
- 需要账号可调用 `/v1/tools/tts`。
