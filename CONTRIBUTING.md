# 贡献指南

先谢谢你有兴趣改这个插件。下面是最少的约定，照着做能让评审快很多。

## 代码结构

| 文件 | 说什么 |
|---|---|
| `index.js` | Host 半：读会话、切段、调 TTS、缓存、HTTP/SSE 路由 |
| `client.js` | 浏览器半：按钮、悬浮窗、高亮、设置页、事件 |
| `bridge.html` | 独立的朗读桥页面（浏览器语音） |
| `docs/` | 文档（技术细节见 [TECHNICAL.md](docs/TECHNICAL.md)） |
| `locale/` | 插件列表里的标题/描述/详情路径 |

没有构建步骤：源码即产物。

## 开发循环

```bash
git clone https://github.com/nienieai/dsh-tts-reader.git
cd dsh-tts-reader
git checkout dev

node --check index.js
node --check client.js

dsh plugin --profile desktop add link:$(pwd)
```

- 改 `client.js` / `bridge.html`：刷新页面即可；
- 改 `index.js`：重启 DSH。

手工冒烟清单（每次改动至少过一遍相关的）：

1. 点一条回复的喇叭，能出声；
2. 再点一次走缓存（不重复合成）；
3. 悬浮窗能暂停/继续、翻段、拖速度、点刻度；
4. 自动朗读开关生效，提问/授权能念；
5. 朗读桥：音色列表、段落高亮、逐词高亮、关闭页面后 DSH 状态能恢复。

## 分支与提交

| 分支 | 用途 |
|---|---|
| `main` | 只放已发布版本（带 annotated tag） |
| `dev` | 日常开发，所有改动先到这里 |

- 提交信息用 `type(scope): subject`，例如 `fix(bridge): keep the popover open`；
- 一个提交做一件事，文档与行为分开提交更好评审；
- 改用户可见行为时同步 `CHANGELOG.md`（写在当前未发布版本下）。

## 发版（维护者）

1. `dev` 上改 `package.json` 的 `version`、`CHANGELOG.md`，并同步 README 徽章里的 `version-` 数字；
2. 合并到 `main`：`git merge --no-ff dev -m "release: vX.Y.Z"`；
3. 打 annotated tag：`git tag -a vX.Y.Z -m "dsh-tts-reader X.Y.Z"`；
4. 推分支与标签：`git push origin dev main --tags`；
5. 确认仓库仍带 `dsh-plugin` topic（插件市场靠它索引）。

## 文档规则

- 用户向内容（README、安装）写人话，不堆术语；实现细节放 `docs/TECHNICAL.md`。
- 插件详情页文档（`docs/DETAIL.*.md`）只放一张配图，功能与限制写在 `locale/*.json` 的 `meta.description` 里 —— 这是 DSH 的约定：详情页不渲染 HTML，相对链接会显示成纯文本。
- 新增或改名 `locale` 里的 `meta.detail` 时，确认文件真实存在（缺文件会让详情页直接报错）。

## 许可证

提交代码即表示同意以 [MIT](LICENSE) 许可发布。引用第三方代码时，请在 [THIRD_PARTY.md](THIRD_PARTY.md) 里补上来源与许可证。
