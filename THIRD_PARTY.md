# 第三方声明 / Third-party notices

本项目是 **DSH（DeepSeek Harness）的社区插件**，通过 DSH 的公开插件接口接入，并调用 DeepSeek 开放平台的 TTS 接口合成语音。

下列项目只用于参考接口、协议与交互方式；**本仓库不包含它们的源码文件**。如果将来某个文件确实改编自它们，会在该文件头部注明来源，并同样适用下方的 MIT 条款。

## DeepSeek chat-demo

- 仓库：<https://github.com/deepseek-ai/chat-demo>
- 许可证：MIT
- 版权：Copyright (c) 2026 DeepSeek
- 参考内容：朗读（read-aloud）的交互流程与 TTS 请求格式（`format: 'pcm'`、`filter_markdown`）。

## DeepSeek Harness（dsh）

- 仓库：<https://github.com/deepseek-ai/deepseek-harness>
- 许可证：MIT
- 版权：Copyright (c) 2026 DeepSeek
- 参考内容：公开插件 API（slot 注册、`ctx.locale`、`webServer`、`sessionQuery`、`settings.section.icon` 等）与页面 DOM 钩子（`[data-approval-key]`、`[data-question-key]`）。

## MIT 许可文本

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
