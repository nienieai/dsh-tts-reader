# 安装与卸载

## 前提

- **DeepSeek Harness（DSH）**，桌面端或 Web 端都可以；「朗读桥」引擎只在桌面端出现。
- Node 18+（DSH 自带运行时，通常不用单独装）。
- 用 DeepSeek 云引擎时，需要 DSH 里已配置 `DEEPSEEK_API_KEY`；其它引擎不需要。

## 安装

### 从插件页（推荐）

1. 打开 DSH，进入 **插件** 页面；
2. 点 **添加插件**（Add plugin）；
3. 选择本仓库目录 —— 就是含 `package.json`、`index.js`、`client.js` 的那一层；
4. 安装完成后**刷新页面**，助手回复的操作行里就会出现喇叭按钮。

### 命令行

```bash
git clone https://github.com/nienieai/dsh-tts-reader.git
cd dsh-tts-reader
dsh plugin --profile desktop add link:$(pwd)
```

Windows 路径示例：

```powershell
dsh plugin --profile desktop add link:C:\Embedded\dsh-tts-reader
```

安装后同样需要刷新页面；`index.js` 的改动必须重启 DSH 才生效。

### 从 npm

```bash
dsh plugin --profile desktop add dsh-tts-reader
```

`dsh plugin` 只是把参数转发给 profile 目录里的 pnpm，所以这条等价于 `pnpm add dsh-tts-reader`：包会装好，但**启用状态由 插件 页决定**——装完去确认它是打开的。

npm 上的版本与 Git 标签一一对应（`0.5.3` 就是 `v0.5.3`）；要锁版本写 `dsh-tts-reader@0.5.3`。注意 `npm publish` 后 npm 会先写一个 `0.0.0-stage` 占位版本，几分钟后正式版本才成为 `latest`，这期间 `npm view` 看到的是占位版本，装的时候带上版本号即可。

## 第一次使用

1. 点任意助手回复下面的 🔊；
2. 右下角出现悬浮播放窗，工具栏上可以暂停、翻段、拖速度；
3. 打开 **设置 → 语音朗读** 可以换引擎/音色、调速度、开自动朗读、清缓存。

没有声音时先看喇叭的颜色：转圈 = 正在启动（朗读桥首次较慢）；黄色 `!` = 需要在朗读桥页面点一下 ▶；红色 = 合成失败，悬停看原因。

## 离线朗读（本地 Piper）

插件**不分发** Piper 与语音模型，需要自己装（各自的许可证由你遵守）。

1. 下载 Piper 可执行文件（[piper1-gpl](https://github.com/OHF-Voice/piper1-gpl) 的 CLI，或旧版 [rhasspy/piper](https://github.com/rhasspy/piper) 的 `piper_windows_amd64.zip`），解压到任意目录；
2. 下载中文模型，例如 `zh_CN-huayan-medium.onnx`，**与同名 `.json` 放同一目录**；
3. 设置 → 语音朗读 → 引擎选「本地 Piper」，填「程序」与「模型」两个路径，右侧显示「已找到」即就绪；
4. 可选：再填一个英文模型（如 `en_US-lessac-medium`），纯英文段落交给它读。

`chaowen` / `xiao_ya` 两个中文音色还需要 `g2pW/` 资源与 `bert-base-chinese` 分词器（约 250 MB），详见设置页的「离线安装说明」弹窗。

## 卸载

1. 在 **插件** 页面停用或移除本插件；
2. 需要彻底清干净时，删除以下目录（可选）：

| 路径 | 内容 |
|---|---|
| `<DSH_HOME>/cache/dsh-tts/` | 音频缓存与固定提示语 |
| `<DSH_HOME>/storages/dsh-tts-reader/` | 插件设置与自定义 API 的 Key |
| `%APPDATA%/.../localStorage` 里的 `dsh-tts-reader:*` | 朗读桥进度、悬浮窗位置等页面偏好 |

## 排错

| 现象 | 可能原因 | 处理 |
|---|---|---|
| 回复下面没有喇叭 | 插件未启用 / 页面没刷新 | 插件页确认已启用，刷新页面；Host 改动后重启 DSH |
| 喇叭一直转圈 | 朗读桥页面没打开或没回应 | 检查是否有朗读桥标签页；12 秒后会自动退回并提示 |
| 黄色感叹号 | 浏览器需要用户手势才能发声 | 到朗读桥页面点一次 ▶ |
| 红色感叹号 | 合成失败（Key、额度、网络、本地进程） | 悬停看提示；设置页检查 Key 状态与引擎就绪状态 |
| 云引擎报 401/403 | `DEEPSEEK_API_KEY` 未配置或无权限 | 在 DSH 里重新配置 Key；确认账号可调用 TTS 接口 |
| 本地 Piper 报错 | 路径/模型不匹配，或缺少 g2pW | 看设置页右下角报错原文；按离线说明补齐资源 |
| Linux 没有系统语音 | 未安装 `espeak-ng` | `sudo apt install espeak-ng`（或对应发行版包） |
| 没有声音但进度在走 | 系统静音 / 输出设备选错 | 检查系统音量与播放设备 |
