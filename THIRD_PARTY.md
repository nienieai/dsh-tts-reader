# 第三方声明 / Third-party notices

本项目是 **DSH（DeepSeek Harness）的社区插件**，通过 DSH 的公开插件接口接入，并调用 DeepSeek 开放平台的 TTS 接口合成语音。

下列项目被参考或包含少量改编内容；对应许可证全文附在文末。另有一项只提供过设计思路、**不含其任何代码**，单独列在最后。

## DeepSeek chat-demo（MIT）

- 仓库：<https://github.com/deepseek-ai/chat-demo>
- 版权：Copyright (c) 2026 DeepSeek
- 参考/改编内容：
  - 朗读按钮的交互流程（未朗读 → 加载中/朗读中点击停止）与 TTS 请求格式（`format: 'pcm'`、`filter_markdown`）；
  - 朗读状态条的**概念**（4 根竖条、`mode: 'loading' | 'playing'` 两态）。本仓库的实现是 CSS `@keyframes` 的 `<span>` + `<i>`，与上游的 SVG/SMIL 版本不同；
  - 喇叭图标的圆角形状（见下方 Lucide 条目，上游同样使用该图标集）。

## DeepSeek Harness / dsh（MIT）

- 仓库：<https://github.com/deepseek-ai/deepseek-harness>
- 版权：Copyright (c) 2026 DeepSeek
- 参考内容：公开插件 API（slot 注册、`ctx.locale`、`webServer`、`sessionQuery`、`settings.section.icon` 等）与页面 DOM 钩子（`[data-approval-key]`、`[data-question-key]`）。

## 用户自行安装的本地引擎（不随本项目分发）

本地引擎模式调用使用者自己安装的 [Piper](https://github.com/OHF-Voice/piper1-gpl) 可执行文件与语音模型。本仓库不包含、也不分发这些文件：

- Piper（含 espeak-ng）：GPL-3.0，由安装者自行遵守；
- 语音模型：各自的许可证与商用条款，见模型发布页。

插件只通过命令行调用它们，属于独立程序之间的调用。

## Lucide Icons（ISC）

- 仓库：<https://github.com/lucide-icons/lucide>
- 版权：Copyright (c) 2026 Lucide Icons and Contributors
- 使用内容：`client.js` 里 `SpeakerIcon` / `SettingsIcon` 的喇叭路径改编自 Lucide 的 `volume-2` 图标（数值做了取整）。

## dsh-tts-bridge（仅设计参考，未包含其代码）

- 仓库：<https://github.com/Yuuyuko-uu/dsh-tts-bridge>
- 作者：Yuuyuko-uu
- 关系：本插件的**朗读桥**借鉴了它「把 DSH 的会话文本交给浏览器去发声」的整体思路。
- 未复制：本仓库不包含该项目的代码、文本或图片。朗读桥用浏览器自带的 SpeechSynthesis 朗读，不经过 DeepSeek 网页端；对方的形态是「DSH 插件 + 浏览器扩展 + 借 DeepSeek 网页的朗读功能」，实现路径不同。
- 许可提示：该项目采用作者自定义的「Yuuyuko-uu 插件许可 1.2」——允许安装、修改、商用，但再分发时须完整保留许可、在 README 第一屏署名原作者，且禁止声称原创；与本仓库的 MIT 不同。由于本仓库**没有再分发**其任何部分，文末不附该许可全文；若你打算使用其代码，请按其许可要求署名。

---

## MIT License（适用于 chat-demo 与 deepseek-harness）

```text
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## ISC License（适用于 Lucide Icons）

```text
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```
