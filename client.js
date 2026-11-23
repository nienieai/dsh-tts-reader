// dsh-tts-reader — Client half.
//
// Adds a "read aloud" action to every finalized assistant message. The page
// never talks to api.deepseek.com and never sees the API key: it posts the
// session/message identity to this plugin's own Host route, which resolves the
// text, synthesizes it through the official TTS API, and streams raw PCM back.
//
// Playback follows the official web client's approach: the response stream is
// converted Int16 → Float32 and scheduled chunk by chunk on one AudioContext,
// so the first sentence starts long before the whole reply is synthesized.
//
// Cache: the finished PCM chunks stay in memory per message (bounded), so the
// second click replays instantly; the Host also caches the WAV on disk, so a
// page reload still answers without a second API call.

window.__ModuleLoader__.load({
  id: 'dsh-tts-reader',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const CONFIG_PATH = '/api/dsh-tts/config'
    const READ_PATH = '/api/dsh-tts/read'
    const PLAN_PATH = '/api/dsh-tts/plan'
    const CLEAR_PATH = '/api/dsh-tts/cache/clear'
    const EVENTS_PATH = '/api/dsh-tts/events'
    const RECENT_PATH = '/api/dsh-tts/recent'
    const BRIDGE_PREFS_PATH = '/api/dsh-tts/bridge/prefs'

    const SAMPLE_RATE = 24000
    const START_DELAY = 0.1

    // Locale follows the Host's active language (what DSH itself shows), not the
    // browser's: the plugin's copy must switch with the app. `ctx.locale` is
    // wired in apply(); the navigator language is only the pre-injection guess.
    // DSH ships exactly these eight languages, so an unknown id falls back to
    // English instead of leaking a half-translated UI.
    const LOCALES = ['zh', 'en', 'ja', 'es', 'fr', 'de', 'ru', 'pt']
    let localeCtx = null
    let localeListeners = []
    function currentLang() {
      try {
        const snapshot = localeCtx && typeof localeCtx.getLocale === 'function' ? localeCtx.getLocale() : null
        const active = snapshot && typeof snapshot.active === 'string' ? snapshot.active.toLowerCase() : ''
        if (active) {
          const base = active.split(/[-_]/)[0]
          return LOCALES.indexOf(base) !== -1 ? base : 'en'
        }
      } catch {}
      try {
        const base = String(navigator.language || 'zh').toLowerCase().split(/[-_]/)[0]
        return LOCALES.indexOf(base) !== -1 ? base : 'en'
      } catch {
        return 'zh'
      }
    }
    // Call sites keep passing (Chinese, English): Chinese is the source, English
    // is the dictionary key, and a missing translation falls back to English.
    function t(zh, en) {
      const lang = currentLang()
      if (lang === 'zh') return zh
      const table = MESSAGES[lang]
      return (table && table[en]) || en
    }

    /**
     * Two Host failures have copy worth translating (`code` rides along with
     * them); engine and network diagnostics stay as the Host wrote them, because
     * they embed the provider's own answer.
     */
    function hostErrorText(payload) {
      const code = payload && typeof payload.code === 'string' ? payload.code : ''
      if (code === 'NO_TEXT') return t('这条消息没有可朗读的文字', 'nothing to read here')
      if (code === 'SESSION_READ_FAILED') return t('读取会话失败', 'could not read the session')
      return ''
    }

    /**
     * UI copy for the languages DSH ships. Keyed by the English text of each
     * `t()` call so no call site had to change; `zh` and `en` stay inline.
     */
    const MESSAGES = {
      ja: {
        'the bridge failed': '読み上げページに失敗しました',
        'the browser confirmed receipt': 'ブラウザが受信を確認しました',
        'sent to the bridge tab, but no confirmation came back (closed tab, or an older page)': '読み上げページに送信しましたが、確認が返ってきません（ページが閉じられたか、古い版のページです）',
        'could not open a browser; the link is copied: ': 'ブラウザを開けませんでした。リンクをコピーしました：',
        'no browser voices here': 'この環境にはブラウザの音声がありません',
        'the browser needs one click on this page before it may speak; try again': 'このページで一度クリックするまでブラウザが音声を出せません。もう一度お試しください',
        'preview failed: ': '試聴に失敗しました：',
        'the cloud voice stayed silent for 8 s — it cannot reach its server; try a local voice': 'このクラウド音声は8秒間無音でした（サーバーに接続できていない可能性）。⌂ ローカル音声をお試しください',
        'no sound in 8 s; the browser may be blocking autoplay': '8秒間音が出ません。自動再生がブロックされている可能性があります',
        'Speech synthesis failed': '音声合成に失敗しました',
        online: 'オンライン',
        words: '単語',
        'browser speech is not available here': 'この環境ではブラウザ読み上げが使えません',
        'no sound from this cloud voice in 8 s; it cannot reach its server — pick a local voice': 'このクラウド音声は8秒間無音でした（サーバーに接続できない可能性）。⌂ ローカル音声に切り替えてください',
        'this desktop shell stayed silent; it now uses the bridge — press read again': 'デスクトップ版では音が出なかったため、読み上げページに切り替えました。もう一度読み上げを押してください',
        'no sound in 8 s; the browser may be blocking autoplay — press read again': '8秒間音が出ません。自動再生がブロックされている可能性があります。もう一度読み上げを押してください',
        'the browser needs one click on this page before it may speak; press read': 'このページで一度クリックするまでブラウザが音声を出せません。読み上げボタンを押してください',
        'browser speech failed: ': 'ブラウザ読み上げに失敗しました：',
        'nothing to read here': 'このメッセージに読み上げる文字がありません',
        'could not read the session': 'セッションを読み取れませんでした',
        'Read aloud': '音声読み上げ',
        'Stop reading': '読み上げを停止',
        'Previous paragraph': '前の段落',
        'Pause / resume': '一時停止 / 再開',
        'Next paragraph': '次の段落',
        'Playback speed': '再生速度',
        Paused: '一時停止中',
        Resume: '再開',
        Pause: '一時停止',
        'Sent to the browser': 'ブラウザに送信しました',
        'Playback failed': '読み上げに失敗しました',
        Dismiss: '閉じる',
        'Read request': '承認を読み上げ',
        'Read question': '質問を読み上げ',
        'Waiting for the current read': '前の読み上げの完了を待っています',
        'Reading the previous item — click to cut in and read this now': '前の項目を読み上げ中です。クリックすると中断してこれを読み上げます',
        Stop: '停止',
        'Click to stop': 'クリックで停止',
        'Synthesizing…': '合成中…',
        'Click to stop (the floating window pauses and steps)': 'クリックで停止（小窓から一時停止・段落移動ができます）',
        'Paused — resume from the floating window': '一時停止中。小窓から再開してください',
        'Play again (cached)': 'もう一度再生（キャッシュ）',
        'Read this reply aloud (the paragraphs around the selection)': 'この返信を読み上げ（選択中ならその段落）',
        'Speech bridge (read in a browser)': '読み上げページ（ブラウザで読み上げ）',
        'Reads in your default browser through the bridge page: no key, nothing cached; it follows the app theme and language.': '既定のブラウザで読み上げます（読み上げページ経由）。キー不要・キャッシュなし。ページは DSH のテーマと言語に従います。',
        'desktop only': 'デスクトップ版のみ',
        'Install Piper offline': 'Piper をオフラインで導入',
        Close: '閉じる',
        'This plugin only plays audio; the Piper program and voice models are not bundled. Set them up once and synthesis stays offline and free.': 'このプラグインは音声を再生するだけで、Piper 本体と音声モデルは含みません。一度用意すれば合成はオフライン・無料のまま使えます。',
        'Program: get a piper executable. For Huayan alone the 2023 self-contained build is enough (about 37 MB, unzip and run); Chaowen / Xiao_ya need the pip build on Python 3.9–3.12: pip install "piper-tts[zh]".': '本体：piper の実行ファイルを用意します。「花顔」だけなら2023年版の自己完結パッケージで十分です（約37 MB、解凍して実行）。「超文 / 小雅」は Python 3.9–3.12 の pip 版が必要です：pip install "piper-tts[zh]"',
        'Voice: a voice is an .onnx plus its same-named .json in one folder (about 60 MB each). Chaowen / Xiao_ya also need g2pW/ (about 260 MB) and the BERT tokenizer (about 0.1 MB) in that folder.': '音声：音声は .onnx と同名の .json を同じフォルダに置いたものです（各約60 MB）。超文 / 小雅 はさらに g2pW/（約260 MB）と BERT トークナイザー（約0.1 MB）が必要です。',
        'Fill it in: pick "Local Piper" above, set the program and voice model paths; once the status reads ready, the speaker button works offline.': '設定：上の「ローカル Piper」を選び、「プログラム」と「音声モデル」のパスを入力します。状態が「準備完了」になればスピーカーボタンがオフラインで使えます。',
        'Disk: Huayan ≈ 97 MB (37 program + 60 model); Chaowen / Xiao_ya ≈ 660 MB including g2pW and the tokenizer.': '容量：花顔 ≈ 97 MB（本体37 + モデル60）。超文 / 小雅 ≈ 660 MB（g2pW とトークナイザーを含む）。',
        'Program: ': 'プログラム：',
        '; the older build works too: ': '（旧版も使用可：',
        'Voices: ': 'モデル：',
        '; from mainland China use the HF_ENDPOINT=https://hf-mirror.com mirror.': '。中国本土では HF_ENDPOINT=https://hf-mirror.com ミラーが使えます。',
        'Piper and espeak-ng are GPL-3.0 and each voice model has its own terms; this plugin does not redistribute them.': 'Piper と espeak-ng は GPL-3.0、音声モデルはそれぞれ独自の条件があります。本プラグインはこれらを再配布しません。',
        'Save failed': '保存に失敗しました',
        Saved: '保存しました',
        'Loading…': '読み込み中…',
        'The official DeepSeek TTS API: billed per use against your own balance; needs a key and network.': 'DeepSeek 公式 TTS API：利用量に応じてご自身の残高から課金されます。キーとネットワークが必要です。',
        'The browser speaks the paragraphs itself: no key, nothing cached, no Host round-trip; speed is the engine rate.': 'ブラウザ自身が段落を読み上げます。キー不要、保存なし、Host との往復なし。速度は音声エンジン側の速度です。',
        'Voices that ship with the operating system: offline, no download, fine at mixed Chinese/English, but synthetic.': 'OS に付属する音声。オフライン・追加ダウンロードなし。中国語と英語の混在も読めますが機械的な声です。',
        'Any OpenAI-compatible /v1/audio/speech endpoint: hosted services bill your own account, local ones are free. The key stays on this machine and is never sent back to the page.': 'OpenAI 互換の /v1/audio/speech エンドポイントならどれでも可。オンラインサービスはご自身のアカウントに課金され、ローカルなら無料です。キーはこの端末に残り、ページには返しません。',
        ready: '準備完了',
        'key missing': 'キー未設定',
        'no browser voices': 'この環境にはブラウザ音声がありません',
        'no voices': '音声なし',
        unsupported: '非対応',
        'needs setup': '設定が必要',
        Chinese: '中国語',
        Japanese: '日本語',
        Korean: '韓国語',
        Cantonese: '広東語',
        Auto: '自動',
        Engine: '合成エンジン',
        'DeepSeek cloud (online)': 'DeepSeek クラウド（オンライン）',
        'Browser speech (hand off to a browser)': 'ブラウザ読み上げ（ブラウザに委譲）',
        'Browser speech (no voices here)': 'ブラウザ読み上げ（この環境に音声なし）',
        'System voices (offline)': 'システム音声（オフライン）',
        'Custom API (online)': 'カスタム API（オンライン）',
        Voice: '音声',
        female: '女性',
        male: '男性',
        'Configured · DEEPSEEK_API_KEY': '設定済み（DEEPSEEK_API_KEY）',
        'Not configured — set a key in Settings → Models': '未設定。設定 → モデル でキーを入力してください',
        'no system voices installed': '利用できるシステム音声がありません',
        'not supported on this OS': 'この OS では未対応',
        Protocol: 'プロトコル',
        'OpenAI-compatible /v1/audio/speech': 'OpenAI 互換 /v1/audio/speech',
        'GPT-SoVITS (api_v2 /tts)': 'GPT-SoVITS（api_v2 /tts）',
        'Fish Audio (/v1/tts)': 'Fish Audio（/v1/tts）',
        'Custom request template': 'カスタムリクエストテンプレート',
        'key required': 'キーが必要',
        'local, no key': 'ローカル、キー不要',
        'invalid URL': 'URL が不正',
        'Reference audio': '参照音声',
        required: '必須',
        'Reference text': '参照テキスト',
        'what the reference audio says (optional)': '参照音声の発話内容（任意）',
        'Text language': 'テキスト言語',
        'Prompt language': '参照言語',
        Model: 'モデル',
        Format: '形式',
        'wav (recommended)': 'wav（推奨）',
        'pcm (24 kHz raw)': 'pcm（24 kHz 生データ）',
        'Reference voice id': '参照音声 ID',
        Method: 'メソッド',
        Path: 'パス',
        Headers: 'ヘッダー',
        'Body template': 'ボディテンプレート',
        'Audio type': '音声タイプ',
        'auto (sniff WAV)': '自動（WAV を判別）',
        'PCM (24 kHz raw)': 'PCM（24 kHz 生データ）',
        'configured — leave empty to keep': '設定済み（空欄なら変更しません）',
        Clear: 'クリア',
        configured: '設定済み',
        missing: '未設定',
        Preview: '試聴',
        'Stop (synthesizing)': '停止（合成中）',
        'Stop preview': '試聴を停止',
        'Play a sample': 'サンプルを再生',
        'fixed mixed zh/en sentence': '中国語と英語の混在した固定文',
        Playback: '読み上げ',
        'Part size sets how much text one synthesis covers; speed only changes playback, never pitch.': '1回の合成に含める文字数を決めます。速度は再生の速さだけを変え、音程は変わりません。',
        'Max per part': '1回の上限',
        chars: '文字',
        Speed: '速度',
        'Auto-read': '自動読み上げ',
        'Turn these on to speak automatically; the speaker button still works with all of them off.': 'オンにすると自動で読み上げます。すべてオフでも各返信のスピーカーボタンは使えます。',
        'Read replies': '返信を読み上げ',
        'Read mid-turn output': '途中出力を読み上げ',
        'needs "Read replies"': '「返信を読み上げ」が必要',
        'Read questions': '質問を読み上げ',
        'prompts that need your answer': '回答が必要な質問',
        'Read approvals': '承認を読み上げ',
        'requests that need your confirmation': '確認が必要な承認リクエスト',
        'Audio cache': '音声キャッシュ',
        ' files · ': ' ファイル · ',
        'in memory: ': 'メモリ内 ',
        ' entries · ': ' 件 · ',
        'Only Host-synthesized engines (DeepSeek, custom API, system voices) are cached; browser speech never is.': 'Host が合成するエンジン（DeepSeek / カスタム API / システム音声）だけをキャッシュします。ブラウザ読み上げはキャッシュしません。',
        Location: '保存場所',
        'Disk (survives a restart)': 'ディスク（再起動後も残る）',
        'Memory (cleared on restart, nothing written)': 'メモリ（再起動で消去、書き込みなし）',
        Limit: '上限',
        Cleanup: 'クリーンアップ',
        'Cache cleared': 'キャッシュを消去しました',
        'Clear cache': 'キャッシュを消去',
        'Saves on Enter, blur, or release.': 'Enter、フォーカス移動、または操作を離したときに保存します。',
      },
      es: {
        'the bridge failed': 'falló el puente de lectura',
        'the browser confirmed receipt': 'el navegador confirmó la recepción',
        'sent to the bridge tab, but no confirmation came back (closed tab, or an older page)': 'enviado a la pestaña del puente, pero sin confirmación (pestaña cerrada o página antigua)',
        'could not open a browser; the link is copied: ': 'no se pudo abrir el navegador; el enlace está copiado: ',
        'no browser voices here': 'aquí no hay voces del navegador',
        'the browser needs one click on this page before it may speak; try again': 'el navegador necesita un clic en esta página para hablar; inténtalo de nuevo',
        'preview failed: ': 'falló la vista previa: ',
        'the cloud voice stayed silent for 8 s — it cannot reach its server; try a local voice': 'la voz en la nube estuvo 8 s en silencio: no llega a su servidor; prueba una voz local',
        'no sound in 8 s; the browser may be blocking autoplay': 'sin sonido en 8 s; puede que el navegador bloquee la reproducción automática',
        'Speech synthesis failed': 'falló la síntesis de voz',
        online: 'en línea',
        words: 'palabras',
        'browser speech is not available here': 'la lectura del navegador no está disponible aquí',
        'no sound from this cloud voice in 8 s; it cannot reach its server — pick a local voice': 'esta voz en la nube no sonó en 8 s; no llega a su servidor: elige una voz local',
        'this desktop shell stayed silent; it now uses the bridge — press read again': 'este entorno de escritorio no emitió sonido; ahora usa el puente: pulsa leer de nuevo',
        'no sound in 8 s; the browser may be blocking autoplay — press read again': 'sin sonido en 8 s; quizá el navegador bloquea la reproducción automática: pulsa leer de nuevo',
        'the browser needs one click on this page before it may speak; press read': 'el navegador necesita un clic en esta página para hablar; pulsa leer',
        'browser speech failed: ': 'falló la lectura del navegador: ',
        'nothing to read here': 'aquí no hay nada que leer',
        'could not read the session': 'no se pudo leer la sesión',
        'Read aloud': 'Leer en voz alta',
        'Stop reading': 'Detener la lectura',
        'Previous paragraph': 'Párrafo anterior',
        'Pause / resume': 'Pausar / reanudar',
        'Next paragraph': 'Párrafo siguiente',
        'Playback speed': 'Velocidad de reproducción',
        Paused: 'En pausa',
        Resume: 'Reanudar',
        Pause: 'Pausar',
        'Sent to the browser': 'Enviado al navegador',
        'Playback failed': 'Falló la lectura',
        Dismiss: 'Cerrar',
        'Read request': 'Leer solicitud',
        'Read question': 'Leer pregunta',
        'Waiting for the current read': 'Esperando la lectura actual',
        'Reading the previous item — click to cut in and read this now': 'Leyendo el elemento anterior: haz clic para interrumpir y leer esto',
        Stop: 'Detener',
        'Click to stop': 'Haz clic para detener',
        'Synthesizing…': 'Sintetizando…',
        'Click to stop (the floating window pauses and steps)': 'Haz clic para detener (la ventana flotante permite pausar y cambiar de párrafo)',
        'Paused — resume from the floating window': 'En pausa: reanuda desde la ventana flotante',
        'Play again (cached)': 'Reproducir de nuevo (en caché)',
        'Read this reply aloud (the paragraphs around the selection)': 'Leer esta respuesta (los párrafos junto a la selección)',
        'Speech bridge (read in a browser)': 'Puente de lectura (leer en un navegador)',
        'Reads in your default browser through the bridge page: no key, nothing cached; it follows the app theme and language.': 'Lee en tu navegador predeterminado mediante la página del puente: sin clave, sin caché; sigue el tema y el idioma de la app.',
        'desktop only': 'solo en escritorio',
        'Install Piper offline': 'Instalar Piper sin conexión',
        Close: 'Cerrar',
        'This plugin only plays audio; the Piper program and voice models are not bundled. Set them up once and synthesis stays offline and free.': 'Este plugin solo reproduce audio; el programa Piper y los modelos de voz no están incluidos. Configúralos una vez y la síntesis seguirá sin conexión y gratis.',
        'Program: get a piper executable. For Huayan alone the 2023 self-contained build is enough (about 37 MB, unzip and run); Chaowen / Xiao_ya need the pip build on Python 3.9–3.12: pip install "piper-tts[zh]".': 'Programa: consigue un ejecutable de piper. Solo con Huayan basta la versión autocontenida de 2023 (unos 37 MB, descomprimir y ejecutar); Chaowen / Xiao_ya necesitan la versión pip en Python 3.9–3.12: pip install "piper-tts[zh]".',
        'Voice: a voice is an .onnx plus its same-named .json in one folder (about 60 MB each). Chaowen / Xiao_ya also need g2pW/ (about 260 MB) and the BERT tokenizer (about 0.1 MB) in that folder.': 'Voz: una voz son un .onnx y su .json del mismo nombre en una carpeta (unos 60 MB cada uno). Chaowen / Xiao_ya también necesitan g2pW/ (unos 260 MB) y el tokenizador BERT (unos 0,1 MB) en esa carpeta.',
        'Fill it in: pick "Local Piper" above, set the program and voice model paths; once the status reads ready, the speaker button works offline.': 'Rellénalo: elige «Piper local» arriba, indica las rutas del programa y del modelo de voz; cuando el estado diga listo, el botón del altavoz funcionará sin conexión.',
        'Disk: Huayan ≈ 97 MB (37 program + 60 model); Chaowen / Xiao_ya ≈ 660 MB including g2pW and the tokenizer.': 'Disco: Huayan ≈ 97 MB (37 programa + 60 modelo); Chaowen / Xiao_ya ≈ 660 MB con g2pW y el tokenizador.',
        'Program: ': 'Programa: ',
        '; the older build works too: ': '; la versión anterior también sirve: ',
        'Voices: ': 'Voces: ',
        '; from mainland China use the HF_ENDPOINT=https://hf-mirror.com mirror.': '; en China continental usa el espejo HF_ENDPOINT=https://hf-mirror.com.',
        'Piper and espeak-ng are GPL-3.0 and each voice model has its own terms; this plugin does not redistribute them.': 'Piper y espeak-ng son GPL-3.0 y cada modelo de voz tiene sus propias condiciones; este plugin no los redistribuye.',
        'Save failed': 'Error al guardar',
        Saved: 'Guardado',
        'Loading…': 'Cargando…',
        'The official DeepSeek TTS API: billed per use against your own balance; needs a key and network.': 'La API oficial de TTS de DeepSeek: se factura por uso con tu propio saldo; necesita una clave y red.',
        'The browser speaks the paragraphs itself: no key, nothing cached, no Host round-trip; speed is the engine rate.': 'El navegador lee los párrafos: sin clave, sin caché, sin ida y vuelta al Host; la velocidad es la del motor.',
        'Voices that ship with the operating system: offline, no download, fine at mixed Chinese/English, but synthetic.': 'Voces del sistema operativo: sin conexión, sin descargas, bien en mezclas de chino e inglés, pero sintéticas.',
        'Any OpenAI-compatible /v1/audio/speech endpoint: hosted services bill your own account, local ones are free. The key stays on this machine and is never sent back to the page.': 'Cualquier endpoint /v1/audio/speech compatible con OpenAI: los servicios alojados cobran a tu cuenta, los locales son gratis. La clave se queda en esta máquina y nunca vuelve a la página.',
        ready: 'listo',
        'key missing': 'falta la clave',
        'no browser voices': 'sin voces del navegador',
        'no voices': 'sin voces',
        unsupported: 'no compatible',
        'needs setup': 'requiere configuración',
        Chinese: 'Chino',
        Japanese: 'Japonés',
        Korean: 'Coreano',
        Cantonese: 'Cantonés',
        Auto: 'Automático',
        Engine: 'Motor de síntesis',
        'DeepSeek cloud (online)': 'DeepSeek en la nube (en línea)',
        'Browser speech (hand off to a browser)': 'Lectura del navegador (delegar en un navegador)',
        'Browser speech (no voices here)': 'Lectura del navegador (sin voces aquí)',
        'System voices (offline)': 'Voces del sistema (sin conexión)',
        'Custom API (online)': 'API personalizada (en línea)',
        Voice: 'Voz',
        female: 'femenina',
        male: 'masculina',
        'Configured · DEEPSEEK_API_KEY': 'Configurado · DEEPSEEK_API_KEY',
        'Not configured — set a key in Settings → Models': 'Sin configurar: define una clave en Ajustes → Modelos',
        'no system voices installed': 'no hay voces del sistema instaladas',
        'not supported on this OS': 'no compatible con este sistema',
        Protocol: 'Protocolo',
        'OpenAI-compatible /v1/audio/speech': 'Compatible con OpenAI /v1/audio/speech',
        'GPT-SoVITS (api_v2 /tts)': 'GPT-SoVITS (api_v2 /tts)',
        'Fish Audio (/v1/tts)': 'Fish Audio (/v1/tts)',
        'Custom request template': 'Plantilla de solicitud personalizada',
        'key required': 'clave necesaria',
        'local, no key': 'local, sin clave',
        'invalid URL': 'URL no válida',
        'Reference audio': 'Audio de referencia',
        required: 'obligatorio',
        'Reference text': 'Texto de referencia',
        'what the reference audio says (optional)': 'lo que dice el audio de referencia (opcional)',
        'Text language': 'Idioma del texto',
        'Prompt language': 'Idioma de referencia',
        Model: 'Modelo',
        Format: 'Formato',
        'wav (recommended)': 'wav (recomendado)',
        'pcm (24 kHz raw)': 'pcm (24 kHz sin formato)',
        'Reference voice id': 'ID de voz de referencia',
        Method: 'Método',
        Path: 'Ruta',
        Headers: 'Cabeceras',
        'Body template': 'Plantilla del cuerpo',
        'Audio type': 'Tipo de audio',
        'auto (sniff WAV)': 'automático (detectar WAV)',
        'PCM (24 kHz raw)': 'PCM (24 kHz sin formato)',
        'configured — leave empty to keep': 'configurado: déjalo vacío para conservarlo',
        Clear: 'Borrar',
        configured: 'configurado',
        missing: 'sin configurar',
        Preview: 'Vista previa',
        'Stop (synthesizing)': 'Detener (sintetizando)',
        'Stop preview': 'Detener la vista previa',
        'Play a sample': 'Reproducir una muestra',
        'fixed mixed zh/en sentence': 'frase fija mixta chino/inglés',
        Playback: 'Reproducción',
        'Part size sets how much text one synthesis covers; speed only changes playback, never pitch.': 'El tamaño de parte decide cuánto texto cubre una síntesis; la velocidad solo cambia la reproducción, nunca el tono.',
        'Max per part': 'Máximo por parte',
        chars: 'caracteres',
        Speed: 'Velocidad',
        'Auto-read': 'Lectura automática',
        'Turn these on to speak automatically; the speaker button still works with all of them off.': 'Actívalos para leer automáticamente; el botón del altavoz sigue funcionando con todos apagados.',
        'Read replies': 'Leer respuestas',
        'Read mid-turn output': 'Leer salida intermedia',
        'needs "Read replies"': 'requiere «Leer respuestas»',
        'Read questions': 'Leer preguntas',
        'prompts that need your answer': 'preguntas que necesitan tu respuesta',
        'Read approvals': 'Leer aprobaciones',
        'requests that need your confirmation': 'solicitudes que necesitan tu confirmación',
        'Audio cache': 'Caché de audio',
        ' files · ': ' archivos · ',
        'in memory: ': 'en memoria: ',
        ' entries · ': ' entradas · ',
        'Only Host-synthesized engines (DeepSeek, custom API, system voices) are cached; browser speech never is.': 'Solo se cachean los motores sintetizados por el Host (DeepSeek, API personalizada, voces del sistema); la lectura del navegador nunca.',
        Location: 'Ubicación',
        'Disk (survives a restart)': 'Disco (sobrevive al reinicio)',
        'Memory (cleared on restart, nothing written)': 'Memoria (se borra al reiniciar, no escribe nada)',
        Limit: 'Límite',
        Cleanup: 'Limpieza',
        'Cache cleared': 'Caché borrada',
        'Clear cache': 'Borrar caché',
        'Saves on Enter, blur, or release.': 'Se guarda al pulsar Enter, al salir del campo o al soltar.',
      },
      fr: {
        "the bridge failed": "le pont de lecture a échoué",
        "the browser confirmed receipt": "le navigateur a confirmé la réception",
        "sent to the bridge tab, but no confirmation came back (closed tab, or an older page)": "envoyé à l’onglet du pont, mais aucune confirmation n’est revenue (onglet fermé ou page ancienne)",
        "could not open a browser; the link is copied: ": "impossible d’ouvrir un navigateur ; le lien est copié : ",
        "no browser voices here": "aucune voix du navigateur ici",
        "the browser needs one click on this page before it may speak; try again": "le navigateur exige un clic sur cette page avant de parler ; réessayez",
        "preview failed: ": "l’aperçu a échoué : ",
        "the cloud voice stayed silent for 8 s — it cannot reach its server; try a local voice": "la voix du cloud est restée muette 8 s : elle n’atteint pas son serveur ; essayez une voix locale",
        "no sound in 8 s; the browser may be blocking autoplay": "aucun son en 8 s ; le navigateur bloque peut-être la lecture automatique",
        "Speech synthesis failed": "la synthèse vocale a échoué",
        online: "en ligne",
        words: "mots",
        "browser speech is not available here": "la lecture par le navigateur n’est pas disponible ici",
        "no sound from this cloud voice in 8 s; it cannot reach its server — pick a local voice": "cette voix du cloud n’a rien émis en 8 s ; elle n’atteint pas son serveur — choisissez une voix locale",
        "this desktop shell stayed silent; it now uses the bridge — press read again": "ce shell de bureau est resté muet ; il utilise maintenant le pont — appuyez de nouveau sur lire",
        "no sound in 8 s; the browser may be blocking autoplay — press read again": "aucun son en 8 s ; le navigateur bloque peut-être la lecture automatique — appuyez de nouveau sur lire",
        "the browser needs one click on this page before it may speak; press read": "le navigateur exige un clic sur cette page avant de parler ; appuyez sur lire",
        "browser speech failed: ": "la lecture par le navigateur a échoué : ",
        "nothing to read here": "rien à lire ici",
        "could not read the session": "impossible de lire la session",
        "Read aloud": "Lire à voix haute",
        "Stop reading": "Arrêter la lecture",
        "Previous paragraph": "Paragraphe précédent",
        "Pause / resume": "Pause / reprendre",
        "Next paragraph": "Paragraphe suivant",
        "Playback speed": "Vitesse de lecture",
        Paused: "En pause",
        Resume: "Reprendre",
        Pause: "Mettre en pause",
        "Sent to the browser": "Envoyé au navigateur",
        "Playback failed": "La lecture a échoué",
        Dismiss: "Fermer",
        "Read request": "Lire la demande",
        "Read question": "Lire la question",
        "Waiting for the current read": "En attente de la lecture en cours",
        "Reading the previous item — click to cut in and read this now": "Lecture de l’élément précédent — cliquez pour couper et lire ceci",
        Stop: "Arrêter",
        "Click to stop": "Cliquer pour arrêter",
        "Synthesizing…": "Synthèse…",
        "Click to stop (the floating window pauses and steps)": "Cliquer pour arrêter (la fenêtre flottante permet pause et navigation)",
        "Paused — resume from the floating window": "En pause — reprenez depuis la fenêtre flottante",
        "Play again (cached)": "Relire (cache)",
        "Read this reply aloud (the paragraphs around the selection)": "Lire cette réponse (les paragraphes autour de la sélection)",
        "Speech bridge (read in a browser)": "Pont de lecture (lire dans un navigateur)",
        "Reads in your default browser through the bridge page: no key, nothing cached; it follows the app theme and language.": "Lit dans votre navigateur par défaut via la page du pont : sans clé, sans cache ; elle suit le thème et la langue de l’application.",
        "desktop only": "bureau uniquement",
        "Install Piper offline": "Installer Piper hors ligne",
        Close: "Fermer",
        "This plugin only plays audio; the Piper program and voice models are not bundled. Set them up once and synthesis stays offline and free.": "Ce plugin ne fait que lire l’audio ; le programme Piper et les modèles de voix ne sont pas fournis. Configurez-les une fois : la synthèse reste hors ligne et gratuite.",
        "Program: get a piper executable. For Huayan alone the 2023 self-contained build is enough (about 37 MB, unzip and run); Chaowen / Xiao_ya need the pip build on Python 3.9–3.12: pip install \"piper-tts[zh]\".": "Programme : procurez-vous un exécutable piper. Pour Huayan seul, la version autonome de 2023 suffit (environ 37 Mo, à décompresser) ; Chaowen / Xiao_ya nécessitent la version pip sous Python 3.9–3.12 : pip install \"piper-tts[zh]\".",
        "Voice: a voice is an .onnx plus its same-named .json in one folder (about 60 MB each). Chaowen / Xiao_ya also need g2pW/ (about 260 MB) and the BERT tokenizer (about 0.1 MB) in that folder.": "Voix : une voix, c’est un .onnx et son .json du même nom dans un dossier (environ 60 Mo chacun). Chaowen / Xiao_ya exigent aussi g2pW/ (environ 260 Mo) et le tokenizer BERT (environ 0,1 Mo) dans ce dossier.",
        "Fill it in: pick \"Local Piper\" above, set the program and voice model paths; once the status reads ready, the speaker button works offline.": "Renseignez : choisissez « Piper local » ci-dessus, indiquez les chemins du programme et du modèle de voix ; quand l’état affiche prêt, le bouton haut-parleur fonctionne hors ligne.",
        "Disk: Huayan ≈ 97 MB (37 program + 60 model); Chaowen / Xiao_ya ≈ 660 MB including g2pW and the tokenizer.": "Disque : Huayan ≈ 97 Mo (37 programme + 60 modèle) ; Chaowen / Xiao_ya ≈ 660 Mo avec g2pW et le tokenizer.",
        "Program: ": "Programme : ",
        "; the older build works too: ": " ; l’ancienne version fonctionne aussi : ",
        "Voices: ": "Voix : ",
        "; from mainland China use the HF_ENDPOINT=https://hf-mirror.com mirror.": " ; en Chine continentale, utilisez le miroir HF_ENDPOINT=https://hf-mirror.com.",
        "Piper and espeak-ng are GPL-3.0 and each voice model has its own terms; this plugin does not redistribute them.": "Piper et espeak-ng sont sous GPL-3.0 et chaque modèle de voix a ses propres conditions ; ce plugin ne les redistribue pas.",
        "Save failed": "Échec de l’enregistrement",
        Saved: "Enregistré",
        "Loading…": "Chargement…",
        "The official DeepSeek TTS API: billed per use against your own balance; needs a key and network.": "L’API TTS officielle DeepSeek : facturée à l’usage sur votre propre solde ; nécessite une clé et un réseau.",
        "The browser speaks the paragraphs itself: no key, nothing cached, no Host round-trip; speed is the engine rate.": "Le navigateur lit les paragraphes lui-même : pas de clé, aucun cache, aucun aller-retour avec l’hôte ; la vitesse est celle du moteur.",
        "Voices that ship with the operating system: offline, no download, fine at mixed Chinese/English, but synthetic.": "Voix fournies par le système : hors ligne, aucun téléchargement, correctes en chinois/anglais mêlés, mais synthétiques.",
        "Any OpenAI-compatible /v1/audio/speech endpoint: hosted services bill your own account, local ones are free. The key stays on this machine and is never sent back to the page.": "Tout point de terminaison /v1/audio/speech compatible OpenAI : les services hébergés facturent votre compte, les services locaux sont gratuits. La clé reste sur cette machine et n’est jamais renvoyée à la page.",
        ready: "prêt",
        "key missing": "clé manquante",
        "no browser voices": "aucune voix du navigateur",
        "no voices": "aucune voix",
        unsupported: "non pris en charge",
        "needs setup": "configuration requise",
        Chinese: "Chinois",
        Japanese: "Japonais",
        Korean: "Coréen",
        Cantonese: "Cantonais",
        Auto: "Automatique",
        Engine: "Moteur de synthèse",
        "DeepSeek cloud (online)": "DeepSeek cloud (en ligne)",
        "Browser speech (hand off to a browser)": "Lecture par le navigateur (déléguer à un navigateur)",
        "Browser speech (no voices here)": "Lecture par le navigateur (aucune voix ici)",
        "System voices (offline)": "Voix du système (hors ligne)",
        "Custom API (online)": "API personnalisée (en ligne)",
        Voice: "Voix",
        female: "féminine",
        male: "masculine",
        "Configured · DEEPSEEK_API_KEY": "Configuré · DEEPSEEK_API_KEY",
        "Not configured — set a key in Settings → Models": "Non configuré — définissez une clé dans Réglages → Modèles",
        "no system voices installed": "aucune voix système installée",
        "not supported on this OS": "non pris en charge sur ce système",
        Protocol: "Protocole",
        "OpenAI-compatible /v1/audio/speech": "Compatible OpenAI /v1/audio/speech",
        "GPT-SoVITS (api_v2 /tts)": "GPT-SoVITS (api_v2 /tts)",
        "Fish Audio (/v1/tts)": "Fish Audio (/v1/tts)",
        "Custom request template": "Modèle de requête personnalisé",
        "key required": "clé requise",
        "local, no key": "local, sans clé",
        "invalid URL": "URL invalide",
        "Reference audio": "Audio de référence",
        required: "obligatoire",
        "Reference text": "Texte de référence",
        "what the reference audio says (optional)": "ce que dit l’audio de référence (facultatif)",
        "Text language": "Langue du texte",
        "Prompt language": "Langue de référence",
        Model: "Modèle",
        Format: "Format",
        "wav (recommended)": "wav (recommandé)",
        "pcm (24 kHz raw)": "pcm (24 kHz brut)",
        "Reference voice id": "ID de voix de référence",
        Method: "Méthode",
        Path: "Chemin",
        Headers: "En-têtes",
        "Body template": "Modèle du corps",
        "Audio type": "Type d’audio",
        "auto (sniff WAV)": "auto (détection WAV)",
        "PCM (24 kHz raw)": "PCM (24 kHz brut)",
        "configured — leave empty to keep": "configuré — laissez vide pour conserver",
        Clear: "Effacer",
        configured: "configuré",
        missing: "manquant",
        Preview: "Aperçu",
        "Stop (synthesizing)": "Arrêter (synthèse en cours)",
        "Stop preview": "Arrêter l’aperçu",
        "Play a sample": "Lire un exemple",
        "fixed mixed zh/en sentence": "phrase fixe chinois/anglais mêlés",
        Playback: "Lecture",
        "Part size sets how much text one synthesis covers; speed only changes playback, never pitch.": "La taille des parties fixe la quantité de texte par synthèse ; la vitesse ne change que la lecture, jamais la hauteur.",
        "Max per part": "Maximum par partie",
        chars: "caractères",
        Speed: "Vitesse",
        "Auto-read": "Lecture automatique",
        "Turn these on to speak automatically; the speaker button still works with all of them off.": "Activez ces options pour lire automatiquement ; le bouton haut-parleur fonctionne même avec tout désactivé.",
        "Read replies": "Lire les réponses",
        "Read mid-turn output": "Lire la sortie intermédiaire",
        "needs \"Read replies\"": "nécessite « Lire les réponses »",
        "Read questions": "Lire les questions",
        "prompts that need your answer": "questions qui attendent votre réponse",
        "Read approvals": "Lire les autorisations",
        "requests that need your confirmation": "demandes qui attendent votre confirmation",
        "Audio cache": "Cache audio",
        " files · ": " fichiers · ",
        "in memory: ": "en mémoire : ",
        " entries · ": " entrées · ",
        "Only Host-synthesized engines (DeepSeek, custom API, system voices) are cached; browser speech never is.": "Seuls les moteurs synthétisés par l’hôte (DeepSeek, API personnalisée, voix système) sont mis en cache ; jamais la lecture par le navigateur.",
        Location: "Emplacement",
        "Disk (survives a restart)": "Disque (survit au redémarrage)",
        "Memory (cleared on restart, nothing written)": "Mémoire (vidée au redémarrage, rien n’est écrit)",
        Limit: "Limite",
        Cleanup: "Nettoyage",
        "Cache cleared": "Cache vidé",
        "Clear cache": "Vider le cache",
        "Saves on Enter, blur, or release.": "Enregistre sur Entrée, à la perte de focus ou au relâchement.",
      },
      de: {
        "the bridge failed": "die Lese-Brücke ist fehlgeschlagen",
        "the browser confirmed receipt": "der Browser hat den Empfang bestätigt",
        "sent to the bridge tab, but no confirmation came back (closed tab, or an older page)": "an den Brücken-Tab gesendet, aber keine Bestätigung erhalten (Tab geschlossen oder alte Seite)",
        "could not open a browser; the link is copied: ": "Browser konnte nicht geöffnet werden; der Link ist kopiert: ",
        "no browser voices here": "hier gibt es keine Browser-Stimmen",
        "the browser needs one click on this page before it may speak; try again": "der Browser braucht einen Klick auf dieser Seite, bevor er sprechen darf; versuche es erneut",
        "preview failed: ": "Vorschau fehlgeschlagen: ",
        "the cloud voice stayed silent for 8 s — it cannot reach its server; try a local voice": "die Cloud-Stimme blieb 8 s stumm – sie erreicht ihren Server nicht; probiere eine lokale Stimme",
        "no sound in 8 s; the browser may be blocking autoplay": "8 s lang kein Ton; eventuell blockiert der Browser die automatische Wiedergabe",
        "Speech synthesis failed": "Sprachsynthese fehlgeschlagen",
        online: "online",
        words: "Wörter",
        "browser speech is not available here": "Browser-Sprachausgabe ist hier nicht verfügbar",
        "no sound from this cloud voice in 8 s; it cannot reach its server — pick a local voice": "diese Cloud-Stimme gab 8 s keinen Ton; sie erreicht ihren Server nicht – nimm eine lokale Stimme",
        "this desktop shell stayed silent; it now uses the bridge — press read again": "diese Desktop-Hülle blieb stumm; sie nutzt jetzt die Lese-Brücke – drücke erneut auf Lesen",
        "no sound in 8 s; the browser may be blocking autoplay — press read again": "8 s kein Ton; eventuell blockiert der Browser die automatische Wiedergabe – drücke erneut auf Lesen",
        "the browser needs one click on this page before it may speak; press read": "der Browser braucht einen Klick auf dieser Seite, bevor er sprechen darf; drücke Lesen",
        "browser speech failed: ": "Browser-Sprachausgabe fehlgeschlagen: ",
        "nothing to read here": "hier gibt es nichts zu lesen",
        "could not read the session": "die Sitzung konnte nicht gelesen werden",
        "Read aloud": "Vorlesen",
        "Stop reading": "Vorlesen stoppen",
        "Previous paragraph": "Vorheriger Absatz",
        "Pause / resume": "Pause / fortsetzen",
        "Next paragraph": "Nächster Absatz",
        "Playback speed": "Wiedergabegeschwindigkeit",
        Paused: "Pausiert",
        Resume: "Fortsetzen",
        Pause: "Pause",
        "Sent to the browser": "An den Browser gesendet",
        "Playback failed": "Wiedergabe fehlgeschlagen",
        Dismiss: "Schließen",
        "Read request": "Freigabe vorlesen",
        "Read question": "Frage vorlesen",
        "Waiting for the current read": "Wartet auf die aktuelle Wiedergabe",
        "Reading the previous item — click to cut in and read this now": "Vorheriger Eintrag wird gelesen – klicken, um ihn zu unterbrechen und dies zu lesen",
        Stop: "Stopp",
        "Click to stop": "Zum Stoppen klicken",
        "Synthesizing…": "Synthetisiere…",
        "Click to stop (the floating window pauses and steps)": "Zum Stoppen klicken (das schwebende Fenster pausiert und wechselt Absätze)",
        "Paused — resume from the floating window": "Pausiert – im schwebenden Fenster fortsetzen",
        "Play again (cached)": "Erneut abspielen (Cache)",
        "Read this reply aloud (the paragraphs around the selection)": "Diese Antwort vorlesen (die Absätze um die Auswahl)",
        "Speech bridge (read in a browser)": "Lese-Brücke (im Browser lesen)",
        "Reads in your default browser through the bridge page: no key, nothing cached; it follows the app theme and language.": "Liest im Standardbrowser über die Brückenseite: kein Schlüssel, kein Cache; die Seite folgt Thema und Sprache der App.",
        "desktop only": "nur Desktop",
        "Install Piper offline": "Piper offline installieren",
        Close: "Schließen",
        "This plugin only plays audio; the Piper program and voice models are not bundled. Set them up once and synthesis stays offline and free.": "Dieses Plugin spielt nur Audio ab; Piper-Programm und Stimmmodelle sind nicht enthalten. Einmal eingerichtet, bleibt die Synthese offline und kostenlos.",
        "Program: get a piper executable. For Huayan alone the 2023 self-contained build is enough (about 37 MB, unzip and run); Chaowen / Xiao_ya need the pip build on Python 3.9–3.12: pip install \"piper-tts[zh]\".": "Programm: eine piper-Executable besorgen. Für Huayan allein genügt der eigenständige Build von 2023 (ca. 37 MB, entpacken und starten); Chaowen / Xiao_ya brauchen den pip-Build unter Python 3.9–3.12: pip install \"piper-tts[zh]\".",
        "Voice: a voice is an .onnx plus its same-named .json in one folder (about 60 MB each). Chaowen / Xiao_ya also need g2pW/ (about 260 MB) and the BERT tokenizer (about 0.1 MB) in that folder.": "Stimme: eine Stimme besteht aus einer .onnx und der gleichnamigen .json in einem Ordner (je ca. 60 MB). Chaowen / Xiao_ya brauchen zusätzlich g2pW/ (ca. 260 MB) und den BERT-Tokenizer (ca. 0,1 MB) in diesem Ordner.",
        "Fill it in: pick \"Local Piper\" above, set the program and voice model paths; once the status reads ready, the speaker button works offline.": "Eintragen: oben „Lokales Piper“ wählen, Programmpfad und Stimmmodell angeben; sobald der Status bereit meldet, funktioniert der Lautsprecher offline.",
        "Disk: Huayan ≈ 97 MB (37 program + 60 model); Chaowen / Xiao_ya ≈ 660 MB including g2pW and the tokenizer.": "Speicher: Huayan ≈ 97 MB (37 Programm + 60 Modell); Chaowen / Xiao_ya ≈ 660 MB inkl. g2pW und Tokenizer.",
        "Program: ": "Programm: ",
        "; the older build works too: ": "; die ältere Version funktioniert auch: ",
        "Voices: ": "Stimmen: ",
        "; from mainland China use the HF_ENDPOINT=https://hf-mirror.com mirror.": "; in Festlandchina den Spiegel HF_ENDPOINT=https://hf-mirror.com verwenden.",
        "Piper and espeak-ng are GPL-3.0 and each voice model has its own terms; this plugin does not redistribute them.": "Piper und espeak-ng stehen unter GPL-3.0, jedes Stimmmodell hat eigene Bedingungen; dieses Plugin verteilt sie nicht.",
        "Save failed": "Speichern fehlgeschlagen",
        Saved: "Gespeichert",
        "Loading…": "Lädt…",
        "The official DeepSeek TTS API: billed per use against your own balance; needs a key and network.": "Die offizielle DeepSeek-TTS-API: nutzungsabhängig über dein eigenes Guthaben abgerechnet; braucht Schlüssel und Netzwerk.",
        "The browser speaks the paragraphs itself: no key, nothing cached, no Host round-trip; speed is the engine rate.": "Der Browser liest die Absätze selbst: kein Schlüssel, kein Cache, kein Host-Umweg; die Geschwindigkeit ist die der Engine.",
        "Voices that ship with the operating system: offline, no download, fine at mixed Chinese/English, but synthetic.": "Stimmen des Betriebssystems: offline, kein Download, gut bei gemischtem Chinesisch/Englisch, aber synthetisch.",
        "Any OpenAI-compatible /v1/audio/speech endpoint: hosted services bill your own account, local ones are free. The key stays on this machine and is never sent back to the page.": "Jeder OpenAI-kompatible /v1/audio/speech-Endpunkt: gehostete Dienste rechnen über dein Konto ab, lokale sind kostenlos. Der Schlüssel bleibt auf diesem Rechner und geht nie an die Seite zurück.",
        ready: "bereit",
        "key missing": "Schlüssel fehlt",
        "no browser voices": "keine Browser-Stimmen",
        "no voices": "keine Stimmen",
        unsupported: "nicht unterstützt",
        "needs setup": "Einrichtung nötig",
        Chinese: "Chinesisch",
        Japanese: "Japanisch",
        Korean: "Koreanisch",
        Cantonese: "Kantonesisch",
        Auto: "Automatisch",
        Engine: "Synthese-Engine",
        "DeepSeek cloud (online)": "DeepSeek-Cloud (online)",
        "Browser speech (hand off to a browser)": "Browser-Sprachausgabe (an Browser übergeben)",
        "Browser speech (no voices here)": "Browser-Sprachausgabe (hier keine Stimmen)",
        "System voices (offline)": "Systemstimmen (offline)",
        "Custom API (online)": "Eigene API (online)",
        Voice: "Stimme",
        female: "weiblich",
        male: "männlich",
        "Configured · DEEPSEEK_API_KEY": "Konfiguriert · DEEPSEEK_API_KEY",
        "Not configured — set a key in Settings → Models": "Nicht konfiguriert — Schlüssel unter Einstellungen → Modelle eintragen",
        "no system voices installed": "keine Systemstimmen installiert",
        "not supported on this OS": "auf diesem System nicht unterstützt",
        Protocol: "Protokoll",
        "OpenAI-compatible /v1/audio/speech": "OpenAI-kompatibel /v1/audio/speech",
        "GPT-SoVITS (api_v2 /tts)": "GPT-SoVITS (api_v2 /tts)",
        "Fish Audio (/v1/tts)": "Fish Audio (/v1/tts)",
        "Custom request template": "Eigene Anfragevorlage",
        "key required": "Schlüssel nötig",
        "local, no key": "lokal, ohne Schlüssel",
        "invalid URL": "ungültige URL",
        "Reference audio": "Referenzaudio",
        required: "erforderlich",
        "Reference text": "Referenztext",
        "what the reference audio says (optional)": "was das Referenzaudio sagt (optional)",
        "Text language": "Textsprache",
        "Prompt language": "Referenzsprache",
        Model: "Modell",
        Format: "Format",
        "wav (recommended)": "wav (empfohlen)",
        "pcm (24 kHz raw)": "pcm (24 kHz roh)",
        "Reference voice id": "Referenz-Stimm-ID",
        Method: "Methode",
        Path: "Pfad",
        Headers: "Header",
        "Body template": "Body-Vorlage",
        "Audio type": "Audiotyp",
        "auto (sniff WAV)": "auto (WAV erkennen)",
        "PCM (24 kHz raw)": "PCM (24 kHz roh)",
        "configured — leave empty to keep": "konfiguriert — leer lassen zum Behalten",
        Clear: "Löschen",
        configured: "konfiguriert",
        missing: "fehlt",
        Preview: "Vorschau",
        "Stop (synthesizing)": "Stoppen (synthetisiert)",
        "Stop preview": "Vorschau stoppen",
        "Play a sample": "Beispiel abspielen",
        "fixed mixed zh/en sentence": "fester gemischt chinesisch/englischer Satz",
        Playback: "Wiedergabe",
        "Part size sets how much text one synthesis covers; speed only changes playback, never pitch.": "Die Teilgröße bestimmt, wie viel Text eine Synthese umfasst; die Geschwindigkeit ändert nur die Wiedergabe, nie die Tonhöhe.",
        "Max per part": "Max. pro Teil",
        chars: "Zeichen",
        Speed: "Geschwindigkeit",
        "Auto-read": "Automatisches Vorlesen",
        "Turn these on to speak automatically; the speaker button still works with all of them off.": "Aktiviere diese, um automatisch vorzulesen; der Lautsprecher-Button funktioniert auch mit allem aus.",
        "Read replies": "Antworten vorlesen",
        "Read mid-turn output": "Zwischenausgaben vorlesen",
        "needs \"Read replies\"": "benötigt „Antworten vorlesen“",
        "Read questions": "Fragen vorlesen",
        "prompts that need your answer": "Fragen, die deine Antwort brauchen",
        "Read approvals": "Freigaben vorlesen",
        "requests that need your confirmation": "Anfragen, die deine Bestätigung brauchen",
        "Audio cache": "Audio-Cache",
        " files · ": " Dateien · ",
        "in memory: ": "im Speicher: ",
        " entries · ": " Einträge · ",
        "Only Host-synthesized engines (DeepSeek, custom API, system voices) are cached; browser speech never is.": "Nur Host-synthetisierte Engines (DeepSeek, eigene API, Systemstimmen) werden zwischengespeichert; Browser-Sprachausgabe nie.",
        Location: "Ort",
        "Disk (survives a restart)": "Festplatte (übersteht einen Neustart)",
        "Memory (cleared on restart, nothing written)": "Speicher (beim Neustart geleert, nichts wird geschrieben)",
        Limit: "Limit",
        Cleanup: "Bereinigung",
        "Cache cleared": "Cache geleert",
        "Clear cache": "Cache leeren",
        "Saves on Enter, blur, or release.": "Speichert bei Enter, Fokusverlust oder Loslassen.",
      },
      ru: {
        "the bridge failed": "мост чтения не сработал",
        "the browser confirmed receipt": "браузер подтвердил получение",
        "sent to the bridge tab, but no confirmation came back (closed tab, or an older page)": "отправлено на вкладку моста, но подтверждение не пришло (вкладка закрыта или старая страница)",
        "could not open a browser; the link is copied: ": "не удалось открыть браузер; ссылка скопирована: ",
        "no browser voices here": "здесь нет голосов браузера",
        "the browser needs one click on this page before it may speak; try again": "браузеру нужен один клик на этой странице, чтобы говорить; попробуйте ещё раз",
        "preview failed: ": "не удалось показать образец: ",
        "the cloud voice stayed silent for 8 s — it cannot reach its server; try a local voice": "облачный голос молчал 8 с — он не может связаться со своим сервером; попробуйте локальный голос",
        "no sound in 8 s; the browser may be blocking autoplay": "нет звука 8 с; возможно, браузер блокирует автовоспроизведение",
        "Speech synthesis failed": "синтез речи не удался",
        online: "онлайн",
        words: "слова",
        "browser speech is not available here": "чтение браузером здесь недоступно",
        "no sound from this cloud voice in 8 s; it cannot reach its server — pick a local voice": "этот облачный голос не издал звука за 8 с; он не может связаться с сервером — выберите локальный голос",
        "this desktop shell stayed silent; it now uses the bridge — press read again": "эта оболочка не издала звука; теперь используется мост — нажмите чтение ещё раз",
        "no sound in 8 s; the browser may be blocking autoplay — press read again": "нет звука 8 с; возможно, браузер блокирует автовоспроизведение — нажмите чтение ещё раз",
        "the browser needs one click on this page before it may speak; press read": "браузеру нужен один клик на этой странице, чтобы говорить; нажмите чтение",
        "browser speech failed: ": "чтение браузером не удалось: ",
        "nothing to read here": "здесь нечего читать",
        "could not read the session": "не удалось прочитать сессию",
        "Read aloud": "Читать вслух",
        "Stop reading": "Остановить чтение",
        "Previous paragraph": "Предыдущий абзац",
        "Pause / resume": "Пауза / продолжить",
        "Next paragraph": "Следующий абзац",
        "Playback speed": "Скорость воспроизведения",
        Paused: "Пауза",
        Resume: "Продолжить",
        Pause: "Пауза",
        "Sent to the browser": "Отправлено в браузер",
        "Playback failed": "Ошибка чтения",
        Dismiss: "Закрыть",
        "Read request": "Читать запрос",
        "Read question": "Читать вопрос",
        "Waiting for the current read": "Ожидание текущего чтения",
        "Reading the previous item — click to cut in and read this now": "Читается предыдущий элемент — нажмите, чтобы прервать и прочитать это",
        Stop: "Стоп",
        "Click to stop": "Нажмите, чтобы остановить",
        "Synthesizing…": "Синтез…",
        "Click to stop (the floating window pauses and steps)": "Нажмите, чтобы остановить (в плавающем окне можно ставить паузу и менять абзац)",
        "Paused — resume from the floating window": "Пауза — продолжите из плавающего окна",
        "Play again (cached)": "Повторить (из кэша)",
        "Read this reply aloud (the paragraphs around the selection)": "Прочитать этот ответ (абзацы вокруг выделения)",
        "Speech bridge (read in a browser)": "Мост чтения (читать в браузере)",
        "Reads in your default browser through the bridge page: no key, nothing cached; it follows the app theme and language.": "Читает в браузере по умолчанию через страницу моста: без ключа, без кэша; страница следует теме и языку приложения.",
        "desktop only": "только для десктопа",
        "Install Piper offline": "Установить Piper офлайн",
        Close: "Закрыть",
        "This plugin only plays audio; the Piper program and voice models are not bundled. Set them up once and synthesis stays offline and free.": "Этот плагин только воспроизводит звук; программа Piper и голосовые модели не входят в комплект. Настройте их один раз — синтез останется офлайн и бесплатным.",
        "Program: get a piper executable. For Huayan alone the 2023 self-contained build is enough (about 37 MB, unzip and run); Chaowen / Xiao_ya need the pip build on Python 3.9–3.12: pip install \"piper-tts[zh]\".": "Программа: возьмите исполняемый файл piper. Только для Huayan достаточно автономной сборки 2023 года (около 37 МБ, распаковать и запустить); Chaowen / Xiao_ya требуют pip-сборку на Python 3.9–3.12: pip install \"piper-tts[zh]\".",
        "Voice: a voice is an .onnx plus its same-named .json in one folder (about 60 MB each). Chaowen / Xiao_ya also need g2pW/ (about 260 MB) and the BERT tokenizer (about 0.1 MB) in that folder.": "Голос: голос — это .onnx и одноимённый .json в одной папке (около 60 МБ каждый). Chaowen / Xiao_ya также требуют g2pW/ (около 260 МБ) и токенизатор BERT (около 0,1 МБ) в этой папке.",
        "Fill it in: pick \"Local Piper\" above, set the program and voice model paths; once the status reads ready, the speaker button works offline.": "Заполните: выберите «Локальный Piper» выше, укажите пути к программе и голосовой модели; когда состояние станет «готово», кнопка динамика будет работать офлайн.",
        "Disk: Huayan ≈ 97 MB (37 program + 60 model); Chaowen / Xiao_ya ≈ 660 MB including g2pW and the tokenizer.": "Диск: Huayan ≈ 97 МБ (37 программа + 60 модель); Chaowen / Xiao_ya ≈ 660 МБ с g2pW и токенизатором.",
        "Program: ": "Программа: ",
        "; the older build works too: ": "; старая версия тоже подходит: ",
        "Voices: ": "Голоса: ",
        "; from mainland China use the HF_ENDPOINT=https://hf-mirror.com mirror.": "; в материковом Китае используйте зеркало HF_ENDPOINT=https://hf-mirror.com.",
        "Piper and espeak-ng are GPL-3.0 and each voice model has its own terms; this plugin does not redistribute them.": "Piper и espeak-ng распространяются по GPL-3.0, у каждой голосовой модели свои условия; этот плагин их не распространяет.",
        "Save failed": "Не удалось сохранить",
        Saved: "Сохранено",
        "Loading…": "Загрузка…",
        "The official DeepSeek TTS API: billed per use against your own balance; needs a key and network.": "Официальный TTS API DeepSeek: оплата по факту использования с вашего баланса; нужны ключ и сеть.",
        "The browser speaks the paragraphs itself: no key, nothing cached, no Host round-trip; speed is the engine rate.": "Браузер сам читает абзацы: без ключа, без кэша, без обращений к Host; скорость — скорость движка.",
        "Voices that ship with the operating system: offline, no download, fine at mixed Chinese/English, but synthetic.": "Голоса операционной системы: офлайн, без загрузки, нормально читают смесь китайского и английского, но звучат синтетично.",
        "Any OpenAI-compatible /v1/audio/speech endpoint: hosted services bill your own account, local ones are free. The key stays on this machine and is never sent back to the page.": "Любой эндпоинт /v1/audio/speech, совместимый с OpenAI: облачные сервисы списывают с вашего аккаунта, локальные бесплатны. Ключ остаётся на этой машине и никогда не возвращается на страницу.",
        ready: "готово",
        "key missing": "нет ключа",
        "no browser voices": "нет голосов браузера",
        "no voices": "нет голосов",
        unsupported: "не поддерживается",
        "needs setup": "нужна настройка",
        Chinese: "Китайский",
        Japanese: "Японский",
        Korean: "Корейский",
        Cantonese: "Кантонский",
        Auto: "Авто",
        Engine: "Движок синтеза",
        "DeepSeek cloud (online)": "DeepSeek Cloud (онлайн)",
        "Browser speech (hand off to a browser)": "Чтение браузером (передать браузеру)",
        "Browser speech (no voices here)": "Чтение браузером (здесь нет голосов)",
        "System voices (offline)": "Системные голоса (офлайн)",
        "Custom API (online)": "Свой API (онлайн)",
        Voice: "Голос",
        female: "женский",
        male: "мужской",
        "Configured · DEEPSEEK_API_KEY": "Настроено · DEEPSEEK_API_KEY",
        "Not configured — set a key in Settings → Models": "Не настроено — укажите ключ в «Настройки → Модели»",
        "no system voices installed": "системные голоса не установлены",
        "not supported on this OS": "не поддерживается в этой ОС",
        Protocol: "Протокол",
        "OpenAI-compatible /v1/audio/speech": "Совместимо с OpenAI /v1/audio/speech",
        "GPT-SoVITS (api_v2 /tts)": "GPT-SoVITS (api_v2 /tts)",
        "Fish Audio (/v1/tts)": "Fish Audio (/v1/tts)",
        "Custom request template": "Свой шаблон запроса",
        "key required": "нужен ключ",
        "local, no key": "локально, без ключа",
        "invalid URL": "неверный URL",
        "Reference audio": "Референсное аудио",
        required: "обязательно",
        "Reference text": "Референсный текст",
        "what the reference audio says (optional)": "что говорит референсное аудио (необязательно)",
        "Text language": "Язык текста",
        "Prompt language": "Язык референса",
        Model: "Модель",
        Format: "Формат",
        "wav (recommended)": "wav (рекомендуется)",
        "pcm (24 kHz raw)": "pcm (24 кГц, сырой поток)",
        "Reference voice id": "ID референсного голоса",
        Method: "Метод",
        Path: "Путь",
        Headers: "Заголовки",
        "Body template": "Шаблон тела",
        "Audio type": "Тип аудио",
        "auto (sniff WAV)": "авто (определить WAV)",
        "PCM (24 kHz raw)": "PCM (24 кГц, сырой поток)",
        "configured — leave empty to keep": "настроено — оставьте пустым, чтобы сохранить",
        Clear: "Очистить",
        configured: "настроено",
        missing: "не задано",
        Preview: "Образец",
        "Stop (synthesizing)": "Остановить (идёт синтез)",
        "Stop preview": "Остановить образец",
        "Play a sample": "Прослушать образец",
        "fixed mixed zh/en sentence": "фиксированная фраза на смеси китайского и английского",
        Playback: "Воспроизведение",
        "Part size sets how much text one synthesis covers; speed only changes playback, never pitch.": "Размер части задаёт, сколько текста покрывает один синтез; скорость меняет только воспроизведение и не меняет тон.",
        "Max per part": "Максимум на часть",
        chars: "символов",
        Speed: "Скорость",
        "Auto-read": "Авточтение",
        "Turn these on to speak automatically; the speaker button still works with all of them off.": "Включите, чтобы читать автоматически; кнопка динамика работает и когда всё выключено.",
        "Read replies": "Читать ответы",
        "Read mid-turn output": "Читать промежуточный вывод",
        "needs \"Read replies\"": "нужно «Читать ответы»",
        "Read questions": "Читать вопросы",
        "prompts that need your answer": "вопросы, которым нужен ваш ответ",
        "Read approvals": "Читать подтверждения",
        "requests that need your confirmation": "запросы, которым нужно ваше подтверждение",
        "Audio cache": "Кэш аудио",
        " files · ": " файлов · ",
        "in memory: ": "в памяти: ",
        " entries · ": " записей · ",
        "Only Host-synthesized engines (DeepSeek, custom API, system voices) are cached; browser speech never is.": "Кэшируются только движки, синтезируемые Host (DeepSeek, свой API, системные голоса); чтение браузером — никогда.",
        Location: "Расположение",
        "Disk (survives a restart)": "Диск (сохраняется после перезапуска)",
        "Memory (cleared on restart, nothing written)": "Память (очищается при перезапуске, ничего не пишется)",
        Limit: "Предел",
        Cleanup: "Очистка",
        "Cache cleared": "Кэш очищен",
        "Clear cache": "Очистить кэш",
        "Saves on Enter, blur, or release.": "Сохраняется по Enter, при потере фокуса или отпускании.",
      },
      pt: {
        "the bridge failed": "o modo de leitura falhou",
        "the browser confirmed receipt": "o navegador confirmou o recebimento",
        "sent to the bridge tab, but no confirmation came back (closed tab, or an older page)": "enviado para a aba do modo de leitura, mas sem confirmação (aba fechada ou página antiga)",
        "could not open a browser; the link is copied: ": "não foi possível abrir o navegador; o link foi copiado: ",
        "no browser voices here": "não há vozes do navegador aqui",
        "the browser needs one click on this page before it may speak; try again": "o navegador precisa de um clique nesta página antes de falar; tente de novo",
        "preview failed: ": "a prévia falhou: ",
        "the cloud voice stayed silent for 8 s — it cannot reach its server; try a local voice": "a voz da nuvem ficou 8 s em silêncio — não alcança o servidor; tente uma voz local",
        "no sound in 8 s; the browser may be blocking autoplay": "sem som por 8 s; talvez o navegador esteja bloqueando a reprodução automática",
        "Speech synthesis failed": "falha na síntese de voz",
        online: "online",
        words: "palavras",
        "browser speech is not available here": "a leitura pelo navegador não está disponível aqui",
        "no sound from this cloud voice in 8 s; it cannot reach its server — pick a local voice": "esta voz da nuvem não emitiu som em 8 s; não alcança o servidor — escolha uma voz local",
        "this desktop shell stayed silent; it now uses the bridge — press read again": "este ambiente de desktop ficou em silêncio; agora usa o modo de leitura — pressione ler de novo",
        "no sound in 8 s; the browser may be blocking autoplay — press read again": "sem som por 8 s; talvez o navegador bloqueie a reprodução automática — pressione ler de novo",
        "the browser needs one click on this page before it may speak; press read": "o navegador precisa de um clique nesta página antes de falar; pressione ler",
        "browser speech failed: ": "falha na leitura pelo navegador: ",
        "nothing to read here": "não há nada para ler aqui",
        "could not read the session": "não foi possível ler a sessão",
        "Read aloud": "Ler em voz alta",
        "Stop reading": "Parar a leitura",
        "Previous paragraph": "Parágrafo anterior",
        "Pause / resume": "Pausar / continuar",
        "Next paragraph": "Próximo parágrafo",
        "Playback speed": "Velocidade de reprodução",
        Paused: "Pausado",
        Resume: "Continuar",
        Pause: "Pausar",
        "Sent to the browser": "Enviado ao navegador",
        "Playback failed": "Falha na leitura",
        Dismiss: "Fechar",
        "Read request": "Ler solicitação",
        "Read question": "Ler pergunta",
        "Waiting for the current read": "Aguardando a leitura atual",
        "Reading the previous item — click to cut in and read this now": "Lendo o item anterior — clique para interromper e ler isto",
        Stop: "Parar",
        "Click to stop": "Clique para parar",
        "Synthesizing…": "Sintetizando…",
        "Click to stop (the floating window pauses and steps)": "Clique para parar (a janela flutuante pausa e muda de parágrafo)",
        "Paused — resume from the floating window": "Pausado — continue pela janela flutuante",
        "Play again (cached)": "Reproduzir de novo (cache)",
        "Read this reply aloud (the paragraphs around the selection)": "Ler esta resposta (os parágrafos em torno da seleção)",
        "Speech bridge (read in a browser)": "Modo de leitura (ler num navegador)",
        "Reads in your default browser through the bridge page: no key, nothing cached; it follows the app theme and language.": "Lê no navegador padrão através da página do modo de leitura: sem chave, sem cache; a página segue o tema e o idioma do app.",
        "desktop only": "só no desktop",
        "Install Piper offline": "Instalar o Piper offline",
        Close: "Fechar",
        "This plugin only plays audio; the Piper program and voice models are not bundled. Set them up once and synthesis stays offline and free.": "Este plugin só reproduz áudio; o programa Piper e os modelos de voz não são incluídos. Configure uma vez e a síntese continua offline e gratuita.",
        "Program: get a piper executable. For Huayan alone the 2023 self-contained build is enough (about 37 MB, unzip and run); Chaowen / Xiao_ya need the pip build on Python 3.9–3.12: pip install \"piper-tts[zh]\".": "Programa: obtenha um executável do piper. Só com o Huayan basta a versão autônoma de 2023 (cerca de 37 MB, descompactar e executar); Chaowen / Xiao_ya exigem a versão pip no Python 3.9–3.12: pip install \"piper-tts[zh]\".",
        "Voice: a voice is an .onnx plus its same-named .json in one folder (about 60 MB each). Chaowen / Xiao_ya also need g2pW/ (about 260 MB) and the BERT tokenizer (about 0.1 MB) in that folder.": "Voz: uma voz é um .onnx e o .json de mesmo nome numa pasta (cerca de 60 MB cada). Chaowen / Xiao_ya também exigem g2pW/ (cerca de 260 MB) e o tokenizador BERT (cerca de 0,1 MB) nessa pasta.",
        "Fill it in: pick \"Local Piper\" above, set the program and voice model paths; once the status reads ready, the speaker button works offline.": "Preencha: escolha «Piper local» acima, informe os caminhos do programa e do modelo de voz; quando o status disser pronto, o botão de alto-falante funciona offline.",
        "Disk: Huayan ≈ 97 MB (37 program + 60 model); Chaowen / Xiao_ya ≈ 660 MB including g2pW and the tokenizer.": "Disco: Huayan ≈ 97 MB (37 programa + 60 modelo); Chaowen / Xiao_ya ≈ 660 MB com g2pW e o tokenizador.",
        "Program: ": "Programa: ",
        "; the older build works too: ": "; a versão antiga também funciona: ",
        "Voices: ": "Vozes: ",
        "; from mainland China use the HF_ENDPOINT=https://hf-mirror.com mirror.": "; na China continental use o espelho HF_ENDPOINT=https://hf-mirror.com.",
        "Piper and espeak-ng are GPL-3.0 and each voice model has its own terms; this plugin does not redistribute them.": "Piper e espeak-ng são GPL-3.0 e cada modelo de voz tem seus próprios termos; este plugin não os redistribui.",
        "Save failed": "Falha ao salvar",
        Saved: "Salvo",
        "Loading…": "Carregando…",
        "The official DeepSeek TTS API: billed per use against your own balance; needs a key and network.": "A API oficial de TTS da DeepSeek: cobrada por uso no seu próprio saldo; precisa de chave e rede.",
        "The browser speaks the paragraphs itself: no key, nothing cached, no Host round-trip; speed is the engine rate.": "O navegador lê os parágrafos: sem chave, sem cache, sem ida e volta ao Host; a velocidade é a do motor.",
        "Voices that ship with the operating system: offline, no download, fine at mixed Chinese/English, but synthetic.": "Vozes do sistema operacional: offline, sem download, boas em misturas de chinês e inglês, mas sintéticas.",
        "Any OpenAI-compatible /v1/audio/speech endpoint: hosted services bill your own account, local ones are free. The key stays on this machine and is never sent back to the page.": "Qualquer endpoint /v1/audio/speech compatível com OpenAI: serviços hospedados cobram na sua conta, locais são gratuitos. A chave fica nesta máquina e nunca volta para a página.",
        ready: "pronto",
        "key missing": "falta a chave",
        "no browser voices": "sem vozes do navegador",
        "no voices": "sem vozes",
        unsupported: "não suportado",
        "needs setup": "precisa de configuração",
        Chinese: "Chinês",
        Japanese: "Japonês",
        Korean: "Coreano",
        Cantonese: "Cantonês",
        Auto: "Automático",
        Engine: "Motor de síntese",
        "DeepSeek cloud (online)": "DeepSeek na nuvem (online)",
        "Browser speech (hand off to a browser)": "Leitura pelo navegador (entregar a um navegador)",
        "Browser speech (no voices here)": "Leitura pelo navegador (sem vozes aqui)",
        "System voices (offline)": "Vozes do sistema (offline)",
        "Custom API (online)": "API personalizada (online)",
        Voice: "Voz",
        female: "feminina",
        male: "masculina",
        "Configured · DEEPSEEK_API_KEY": "Configurado · DEEPSEEK_API_KEY",
        "Not configured — set a key in Settings → Models": "Não configurado — defina uma chave em Configurações → Modelos",
        "no system voices installed": "nenhuma voz do sistema instalada",
        "not supported on this OS": "não suportado neste sistema",
        Protocol: "Protocolo",
        "OpenAI-compatible /v1/audio/speech": "Compatível com OpenAI /v1/audio/speech",
        "GPT-SoVITS (api_v2 /tts)": "GPT-SoVITS (api_v2 /tts)",
        "Fish Audio (/v1/tts)": "Fish Audio (/v1/tts)",
        "Custom request template": "Modelo de requisição personalizado",
        "key required": "chave necessária",
        "local, no key": "local, sem chave",
        "invalid URL": "URL inválida",
        "Reference audio": "Áudio de referência",
        required: "obrigatório",
        "Reference text": "Texto de referência",
        "what the reference audio says (optional)": "o que o áudio de referência diz (opcional)",
        "Text language": "Idioma do texto",
        "Prompt language": "Idioma de referência",
        Model: "Modelo",
        Format: "Formato",
        "wav (recommended)": "wav (recomendado)",
        "pcm (24 kHz raw)": "pcm (24 kHz bruto)",
        "Reference voice id": "ID da voz de referência",
        Method: "Método",
        Path: "Caminho",
        Headers: "Cabeçalhos",
        "Body template": "Modelo do corpo",
        "Audio type": "Tipo de áudio",
        "auto (sniff WAV)": "auto (detectar WAV)",
        "PCM (24 kHz raw)": "PCM (24 kHz bruto)",
        "configured — leave empty to keep": "configurado — deixe vazio para manter",
        Clear: "Limpar",
        configured: "configurado",
        missing: "não definido",
        Preview: "Prévia",
        "Stop (synthesizing)": "Parar (sintetizando)",
        "Stop preview": "Parar prévia",
        "Play a sample": "Ouvir uma amostra",
        "fixed mixed zh/en sentence": "frase fixa mista de chinês/inglês",
        Playback: "Reprodução",
        "Part size sets how much text one synthesis covers; speed only changes playback, never pitch.": "O tamanho da parte define quanto texto uma síntese cobre; a velocidade muda só a reprodução, nunca o tom.",
        "Max per part": "Máximo por parte",
        chars: "caracteres",
        Speed: "Velocidade",
        "Auto-read": "Leitura automática",
        "Turn these on to speak automatically; the speaker button still works with all of them off.": "Ative para ler automaticamente; o botão de alto-falante continua funcionando com tudo desligado.",
        "Read replies": "Ler respostas",
        "Read mid-turn output": "Ler saída intermediária",
        "needs \"Read replies\"": "precisa de «Ler respostas»",
        "Read questions": "Ler perguntas",
        "prompts that need your answer": "perguntas que precisam da sua resposta",
        "Read approvals": "Ler autorizações",
        "requests that need your confirmation": "pedidos que precisam da sua confirmação",
        "Audio cache": "Cache de áudio",
        " files · ": " arquivos · ",
        "in memory: ": "na memória: ",
        " entries · ": " entradas · ",
        "Only Host-synthesized engines (DeepSeek, custom API, system voices) are cached; browser speech never is.": "Só os motores sintetizados pelo Host (DeepSeek, API personalizada, vozes do sistema) são armazenados; a leitura pelo navegador nunca.",
        Location: "Local",
        "Disk (survives a restart)": "Disco (sobrevive a um reinício)",
        "Memory (cleared on restart, nothing written)": "Memória (limpa no reinício, nada é escrito)",
        Limit: "Limite",
        Cleanup: "Limpeza",
        "Cache cleared": "Cache limpo",
        "Clear cache": "Limpar cache",
        "Saves on Enter, blur, or release.": "Salva com Enter, ao perder o foco ou ao soltar.",
      },
    }

    // The bridge is a separate page: it cannot see the app's theme, so the
    // palette is read here and pushed there. `ctx` is kept for a lazy lookup —
    // the theme service may mount after this plugin, and a one-shot read in
    // apply() would then answer "dark" forever.
    let appCtx = null
    /** The colour DSH actually paints. Reads the service first, the pixels second. */
    function currentScheme() {
      try {
        const theme = appCtx && typeof appCtx.get === 'function' ? appCtx.get('theme') : null
        const snapshot = theme && typeof theme.getTheme === 'function' ? theme.getTheme() : null
        const active = snapshot && snapshot.active
        const scheme = active && typeof active.colorScheme === 'string' ? active.colorScheme : ''
        if (scheme === 'light' || scheme === 'dark') return scheme
      } catch {}
      // No service (older Host): the painted background is the truth, and it is
      // the only signal that also follows a theme the service does not report.
      const painted = paintedScheme()
      if (painted) return painted
      return 'dark'
    }

    /** light/dark from the first opaque background between <body> and <html>. */
    function paintedScheme() {
      if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return ''
      const parse = (value) => {
        const match = /^rgba?\(([^)]+)\)$/.exec(String(value || ''))
        if (!match) return null
        const parts = match[1].split(/[,\s/]+/).filter(Boolean).map(Number)
        if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n))) return null
        const alpha = parts.length > 3 && Number.isFinite(parts[3]) ? parts[3] : 1
        return { r: parts[0], g: parts[1], b: parts[2], a: alpha }
      }
      let node = document.body || document.documentElement
      while (node) {
        let color = null
        try { color = parse(getComputedStyle(node).backgroundColor) } catch {}
        if (color && color.a >= 0.5) {
          const luminance = (0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b) / 255
          return luminance > 0.5 ? 'light' : 'dark'
        }
        node = node.parentElement
      }
      return ''
    }

    // Theme and language are pushed on their own, and only once the bridge has
    // been used: a page that never opened one does not need the traffic.
    let bridgeUsed = false
    let lastPrefs = { scheme: '', lang: '' }
    let prefsTimer = 0

    function schedulePrefsPush() {
      if (!bridgeUsed) return
      if (prefsTimer) clearTimeout(prefsTimer)
      // One push per burst: a theme switch can repaint several times.
      prefsTimer = setTimeout(() => {
        prefsTimer = 0
        void sendPrefs()
      }, 150)
    }

    async function sendPrefs() {
      if (!bridgeUsed) return
      const scheme = currentScheme()
      const lang = currentLang()
      const body = {}
      if (scheme !== lastPrefs.scheme) body.scheme = scheme
      if (lang !== lastPrefs.lang) body.lang = lang
      if (!body.scheme && !body.lang) return
      lastPrefs = { scheme, lang }
      try {
        await fetch(BRIDGE_PREFS_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          keepalive: true,
        })
      } catch {}
    }

    // The bridge reports what it is doing; the app mirrors it on the buttons.
    function noteBridgeState(payload) {
      const key = String(payload.key || '')
      if (!key) return
      const phase = String(payload.phase || '')
      if (phase === 'finished' || phase === 'stopped') {
        if (!bridgeStates.has(key)) return
        bridgeStates.delete(key)
      } else {
        bridgeStates.set(key, {
          phase: phase === 'paused' ? 'paused' : phase === 'queued' ? 'queued' : 'playing',
          unit: Number(payload.unit) || 0,
          total: Number(payload.total) || 0,
          queued: Number(payload.queued) || 0,
          at: Date.now(),
        })
      }
      setPlayback({})
    }

    /** The bridge's state for one button, dropped once it is too old to trust. */
    function liveBridgeState(key) {
      const state = bridgeStates.get(key)
      if (!state) return null
      if (Date.now() - (state.at || 0) > 10 * 60 * 1000) {
        bridgeStates.delete(key)
        return null
      }
      return state
    }

    /** Theme/language changes, plus a DOM fallback for a Host without the service. */
    function watchBridgePrefs(ctx) {
      ctx.effect(() => {
        const offTheme = typeof ctx.on === 'function' ? ctx.on('theme/change', () => schedulePrefsPush()) : null
        const offLocale = typeof ctx.on === 'function' ? ctx.on('locale/change', () => schedulePrefsPush()) : null
        return () => {
          try { offTheme && offTheme() } catch {}
          try { offLocale && offLocale() } catch {}
        }
      }, 'dsh-tts-reader: bridge prefs')
      ctx.effect(() => {
        if (typeof window === 'undefined' || typeof document === 'undefined') return
        let last = currentScheme()
        let pending = 0
        const check = () => {
          pending = 0
          const next = currentScheme()
          if (next === last) return
          last = next
          schedulePrefsPush()
        }
        const onChange = () => {
          if (pending) return
          pending = setTimeout(check, 120)
        }
        let observer = null
        try {
          if (typeof MutationObserver === 'function') {
            observer = new MutationObserver(onChange)
            observer.observe(document.documentElement, {
              attributes: true,
              attributeFilter: ['class', 'style', 'data-theme', 'data-color-scheme'],
            })
          }
        } catch { observer = null }
        let media = null
        try {
          media = window.matchMedia('(prefers-color-scheme: dark)')
          if (media && typeof media.addEventListener === 'function') media.addEventListener('change', onChange)
        } catch { media = null }
        return () => {
          if (pending) clearTimeout(pending)
          try { observer && observer.disconnect() } catch {}
          try {
            if (media && typeof media.removeEventListener === 'function') media.removeEventListener('change', onChange)
          } catch {}
        }
      }, 'dsh-tts-reader: scheme watch')
    }

    // Re-render a component when the app language changes.
    function useLocaleTick() {
      const [, force] = React.useReducer((value) => value + 1, 0)
      React.useEffect(() => {
        localeListeners.push(force)
        return () => {
          localeListeners = localeListeners.filter(entry => entry !== force)
        }
      }, [])
    }

    function watchLocale(ctx) {
      try {
        if (typeof ctx.locale.subscribe !== 'function') return
        ctx.effect(() => ctx.locale.subscribe(() => {
          for (const force of localeListeners.slice()) {
            try { force() } catch {}
          }
        }), 'dsh-tts-reader: locale')
      } catch {}
    }

    // Messages that have been read at least once: the speaker button uses this
    // only to know it can offer "play again (cached)".
    const playedMessages = new Set()
    // Replies the browser bridge finished reading: their buttons show a check.
    // The Host owns the record (it survives a reload); this is the page's copy.
    const bridgeStates = new Map()
    // The rendered read button per message: the only handle on the message DOM,
    // and auto-read has no click to carry one, so it is kept for later lookups.
    const actionAnchors = new Map()
    let current = null // { key, controller, context }
    let playback = { key: null, phase: 'idle', error: '', queued: null }
    const listeners = new Set()

    // Speech waiting for the audio before it, in arrival order: [{ key, speak }].
    let speechQueue = []

    // Auto-read state, kept in sync with the Host settings.
    let autoRead = false
    let autoReadInterim = false
    let speakQuestions = true
    let speakApprovals = true
    // Playback rate: 1 is unchanged. Applied client-side as a pitch-preserving
    // time-stretch — the TTS API has no speed parameter.
    let speed = 1
    // Which synthesizer the Host is configured with. `browser` never reaches the
    // Host: the page speaks the paragraphs itself.
    let engineMode = 'deepseek'
    let activeSessionId = null
    const autoPlayed = new Set()
    let eventSource = null

    // The replay button polls the Host for the pending question / approval, so
    // it shows up even if a particular page instance missed the event.
    const PENDING_PATH = '/api/dsh-tts/pending'
    const BRIDGE_PATH = '/api/dsh-tts/bridge'
    const SPEECH_VOICE_KEY = 'dsh-tts-reader:speech-voice'
    const SPEECH_FIRST_TIMEOUT_MS = 8000

    // ---------------------------------------------------------- browser speech
    // A real browser ships speech voices; a desktop shell (Electron) exposes the
    // API but no engine, so it needs the bridge to a browser.
    function speechSynth() {
      try {
        if (typeof window === 'undefined') return null
        return window.speechSynthesis && typeof window.SpeechSynthesisUtterance === 'function'
          ? window.speechSynthesis
          : null
      } catch { return null }
    }

    let speechVoices = []
    const speechListeners = new Set()

    function refreshSpeechVoices() {
      const synth = speechSynth()
      let list = []
      try { list = (synth && synth.getVoices()) || [] } catch { list = [] }
      const changed = list.length !== speechVoices.length
        || list.some((voice, index) => (speechVoices[index] && speechVoices[index].voiceURI) !== voice.voiceURI)
      speechVoices = list
      if (changed) {
        for (const listener of speechListeners) {
          try { listener(speechVoices) } catch {}
        }
      }
      return speechVoices
    }

    function subscribeSpeechVoices(listener) {
      speechListeners.add(listener)
      return () => { speechListeners.delete(listener) }
    }

    const isDesktopShell = (() => {
      try {
        const ua = String((typeof navigator !== 'undefined' && navigator.userAgent) || '')
        if (/Electron/i.test(ua)) return true
        // The packaged shell could strip the token from the UA; the renderer's
        // own process object is the second tell.
        const proc = typeof window !== 'undefined' ? window.process : null
        return !!(proc && proc.versions && proc.versions.electron)
      } catch { return false }
    })()

    // The bridge is an engine of its own now, not a voice inside the browser
    // engine: a desktop shell cannot use its own voices at all.
    const LEGACY_BRIDGE_TARGET = 'bridge'
    const usesBridge = () => engineMode === 'bridge'
    // A saved pre-bridge engine pair ("browser" + the bridge voice) becomes the
    // bridge engine once, so an existing setup keeps reading in the browser.
    const needsBridgeMigration = () => isDesktopShell
      && engineMode === 'browser'
      && storedSpeechVoice() === LEGACY_BRIDGE_TARGET
    const speechTargetValue = () => {
      const stored = storedSpeechVoice()
      if (stored === LEGACY_BRIDGE_TARGET) return ''
      return stored || ((pickSpeechVoice() || {}).voiceURI || '')
    }

    const speechCapable = () => speechVoices.length > 0

    function storedSpeechVoice() {
      try { return window.localStorage.getItem(SPEECH_VOICE_KEY) || '' } catch { return '' }
    }

    function rememberSpeechVoice(uri) {
      try {
        if (uri) window.localStorage.setItem(SPEECH_VOICE_KEY, uri)
        else window.localStorage.removeItem(SPEECH_VOICE_KEY)
      } catch {}
    }

    function isCloudVoice(voice) { return voice && voice.localService === false }

    /**
     * Which voice reads by default. The remembered one wins; otherwise a
     * "Natural" voice in the app language is best — Edge's Online (Natural)
     * voices sound like speech and do report word boundaries. They are still
     * network voices, so plain cloud voices (Chrome's "Google …", which can hang
     * without ever starting) rank below the local engines.
     */
    function pickSpeechVoice() {
      const wanted = storedSpeechVoice()
      if (wanted) {
        const remembered = speechVoices.find((voice) => voice.voiceURI === wanted)
        if (remembered) return remembered
      }
      const zh = (voice) => /^zh/i.test(voice.lang || '')
      const natural = (voice) => /natural/i.test(voice.name || '')
      const local = (voice) => !isCloudVoice(voice)
      const best = [
        (voice) => zh(voice) && natural(voice),
        (voice) => zh(voice) && local(voice),
        zh,
        natural,
        local,
      ]
      for (const test of best) {
        const found = speechVoices.find(test)
        if (found) return found
      }
      return speechVoices[0] || null
    }

    /**
     * Ask the Host to hand this text to the default browser. The desktop shell
     * has no speech engine, so this is how it reads aloud at all.
     */
    async function openBridge(target) {
      const payload = {}
      // Auto-read stays quiet: a toast per auto-sent paragraph would bury the
      // conversation, and a failed auto hand-off is not the user's problem.
      const quiet = !!(target && target.quiet)
      if (target && target.sessionId) payload.sessionId = target.sessionId
      if (target && target.messageId) payload.messageId = target.messageId
      if (target && target.text) payload.text = target.text
      // The bridge reads at the speed set on the settings page.
      payload.speed = Number(speed) || 1
      // Its voice list is ordered by the app's language, not the browser's.
      payload.lang = currentLang()
      // The bridge paints itself in the app's palette, not the OS preference.
      payload.scheme = currentScheme()
      // The app's own key for this read: the bridge echoes it with its state so
      // the app can show a wave on the button that started it.
      if (target && target.stateKey) payload.key = String(target.stateKey)
      try {
        const response = await fetch(BRIDGE_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
        const body = await response.json().catch(() => null)
        if (!response.ok || !body || body.ok !== true) {
          throw new Error(hostErrorText(body) || (body && body.error) || t('朗读桥失败', 'the bridge failed'))
        }
        const value = body.value || {}
        // From here on theme/language changes are worth pushing to it.
        bridgeUsed = true
        lastPrefs = { scheme: payload.scheme, lang: payload.lang }
        if (value.delivered > 0) {
          // A bridge tab was already listening: nothing new was opened. It also
          // confirms receipt, so "sent" and "received" are no longer the same
          // claim: an unconfirmed hand-off usually means the tab was closed.
          if (!quiet) {
            showFailureToast(value.acked
              ? t('浏览器已确认收到', 'the browser confirmed receipt')
              : t('已发到那个朗读页，但没等到它的确认（多半是页面已关或是旧版页面）',
                'sent to the bridge tab, but no confirmation came back (closed tab, or an older page)'),
            value.acked ? 'ok' : undefined)
          }
        } else if (!value.launched && value.url) {
          try { await navigator.clipboard.writeText(value.url) } catch {}
          if (!quiet) showFailureToast(t('没能自动打开浏览器，链接已复制到剪贴板：', 'could not open a browser; the link is copied: ') + value.url)
        }
        return value
      } catch (error) {
        if (!quiet) showFailureToast((error && error.message) || String(error))
        return null
      }
    }

    function applyRemoteConfig(value) {
      if (!value || typeof value !== 'object') return
      autoRead = value.autoRead === true
      autoReadInterim = value.autoReadInterim === true
      speakQuestions = value.speakQuestions !== false
      speakApprovals = value.speakApprovals !== false
      if (typeof value.engine === 'string') engineMode = value.engine
      const nextSpeed = Number(value.speed)
      const resolved = Number.isFinite(nextSpeed) && nextSpeed > 0 ? Math.min(2, Math.max(0.5, nextSpeed)) : 1
      if (resolved === speed) return
      speed = resolved
      // A speed change from settings applies to the audio in flight right away.
      if (player) {
        playerRerender(player, speed)
        playerView({ speed })
      }
    }

    let configLoaded = false
    function loadConfigOnce() {
      if (configLoaded) return
      configLoaded = true
      fetch(CONFIG_PATH, { headers: { accept: 'application/json' } })
        .then((res) => res.json())
        .then((body) => { if (body && body.ok) applyRemoteConfig(body.value) })
        .catch(() => {})
    }

    /** Persist one engine change from a non-settings path (the watchdog). */
    function saveEngine(engine) {
      return fetch(CONFIG_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ engine }),
      })
        .then((res) => res.json())
        .then((body) => { if (body && body.ok) applyRemoteConfig(body.value) })
        .catch(() => {})
    }

    function ensureEvents(ctx) {
      if (eventSource || typeof EventSource === 'undefined') return
      try {
        eventSource = new EventSource(EVENTS_PATH)
      } catch {
        eventSource = null
        return
      }
      eventSource.onmessage = (event) => {
        let payload = null
        try { payload = JSON.parse(event.data) } catch { return }
        if (!payload) return
        if (payload.type === 'question' || payload.type === 'approval') {
          // Speech for these comes from the /pending probe below, so one page
          // instance owns it even when the feed reconnects.
          return
        }
        if (payload.type === 'question-closed' || payload.type === 'approval-closed') {
          // Answered or withdrawn: stop its audio now instead of waiting for the
          // next poll. Both key spellings are tried because the close line only
          // carries the id.
          const id = String(payload.id || '')
          if (id) {
            for (const key of ['prompt:' + id, 'prompt:approval:' + id]) {
              if (current && current.key === key) stopCurrentOnly()
              dropQueued(key)
            }
          }
          return
        }
        if (payload.type === 'bridge-state') {
          // The browser bridge reports what it is reading: mirror it on the
          // message (or prompt) button that started that read.
          noteBridgeState(payload)
          return
        }
        if (payload.type !== 'assistant') return
        handleAssistant(payload.sessionId, payload.messageId, payload.final)
      }
      eventSource.onerror = () => {
        // Reconnect later instead of a tight retry loop.
        try { eventSource.close() } catch {}
        eventSource = null
        setTimeout(() => { if (!eventSource) ensureEvents(ctx) }, 5000)
      }
      ctx.effect(() => () => {
        try { eventSource && eventSource.close() } catch {}
        eventSource = null
      }, 'dsh-tts-reader: events')
    }

    // One assistant message from either transport (SSE or the polling
    // fallback). Interim output is opt-in; the turn's last output always plays.
    function handleAssistant(sessionId, messageId, final) {
      if (!autoRead) return
      if (final !== true && !autoReadInterim) return
      const sid = String(sessionId || '')
      const mid = String(messageId || '')
      if (!sid || !mid) return
      if (!activeSessionId || sid !== activeSessionId) return
      autoReadMessage(sid, mid)
    }

    // Polling fallback for the assistant feed: the page's EventSource can drop
    // silently (no error, no reconnect), and auto-read must not depend on it.
    // The first successful poll only establishes the cursor, so a page load
    // never replays the backlog.
    let recentCursor = null
    function pollRecent() {
      const query = recentCursor === null ? '' : '?after=' + String(recentCursor)
      fetch(RECENT_PATH + query, { headers: { accept: 'application/json' } })
        .then((res) => res.json())
        .then((body) => {
          if (!body || !body.ok || !body.value) return
          const items = Array.isArray(body.value.items) ? body.value.items : []
          const seq = Number(body.value.seq)
          if (recentCursor === null) {
            recentCursor = Number.isFinite(seq) ? seq : 0
            return
          }
          for (const item of items) {
            if (!item) continue
            const value = Number(item.seq)
            if (Number.isFinite(value) && value > recentCursor) recentCursor = value
            handleAssistant(item.sessionId, item.messageId, item.final)
          }
          if (Number.isFinite(seq) && seq > recentCursor) recentCursor = seq
        })
        .catch(() => {})
    }

    function setPlayback(patch) {
      playback = { ...playback, ...patch }
      for (const listener of listeners) {
        try { listener(playback) } catch {}
      }
    }

    function usePlayback() {
      const [value, setValue] = React.useState(playback)
      React.useEffect(() => {
        listeners.add(setValue)
        setValue(playback)
        return () => { listeners.delete(setValue) }
      }, [])
      return value
    }

    // Abort only what is audible; the waiting queue is untouched. Starting the
    // next queued item uses this, so draining never discards the rest.
    function stopCurrentOnly() {
      playerStop()
      current = null
      setPlayback({ key: null, phase: 'idle', error: '' })
    }

    // A user stop: silence now AND drop everything waiting.
    function stopPlayback() {
      clearQueue()
      stopCurrentOnly()
    }

    function clearQueue() {
      if (speechQueue.length === 0 && playback.queued === null) return
      speechQueue = []
      setPlayback({ queued: null })
    }

    const queueHead = () => (speechQueue.length > 0 ? speechQueue[0].key : null)
    const isQueued = (key) => speechQueue.some(item => item.key === key)

    // Strict FIFO: an approval arriving while a mid-turn read is playing waits
    // its turn behind both the current audio and the reads already queued.
    function enqueueSpeech(key, speak) {
      if (speechQueue.some(item => item.key === key)) return
      speechQueue.push({ key, speak })
      setPlayback({ queued: queueHead() })
    }

    function dropQueued(key) {
      const next = speechQueue.filter(item => item.key !== key)
      if (next.length === speechQueue.length) return
      speechQueue = next
      setPlayback({ queued: queueHead() })
    }

    function drainQueue() {
      const next = speechQueue.shift()
      setPlayback({ queued: queueHead() })
      if (next) {
        try { next.speak() } catch {}
      }
    }

    // Auto-read of one assistant message. Queues instead of cutting in, so a
    // mid-turn read never truncates the question the user is hearing.
    function autoReadMessage(sessionId, messageId) {
      const key = sessionId + ':' + messageId
      if (autoPlayed.has(key)) return
      autoPlayed.add(key)
      // `auto` keeps a no-text mid-turn chunk (thinking, tool calls) silent: the
      // user asked for the whole turn to be spoken, not for a failure report on
      // every step that has no prose in it.
      const speak = () => { void startReadAloud(sessionId, messageId, key, { auto: true }) }
      if (current || speechQueue.length > 0) {
        enqueueSpeech(key, speak)
        return
      }
      speak()
    }

    // Speech for the pending question or approval. It waits for the current
    // audio and for the reads queued before it; the card button can cut in.
    function autoReadPrompt(key, text) {
      if (!text) return
      if ((current && current.key !== key) || speechQueue.length > 0) {
        enqueueSpeech(key, () => { void startReadAloud(null, null, key, { text, auto: true }) })
        return
      }
      void startReadAloud(null, null, key, { text, auto: true })
    }

    // A user gesture: cut whatever plays and speak this now.
    function speakNow(key, speak) {
      clearQueue()
      stopCurrentOnly()
      speak()
    }

    function toFloat32(bytes) {
      const samples = new Float32Array(bytes.length >> 1)
      const view = new DataView(bytes.buffer, bytes.byteOffset, samples.length * 2)
      for (let i = 0; i < samples.length; i += 1) {
        samples[i] = view.getInt16(i * 2, true) / 0x8000
      }
      return samples
    }

    function concatBytes(left, right) {
      if (left.length === 0) return new Uint8Array(right)
      const merged = new Uint8Array(left.length + right.length)
      merged.set(left)
      merged.set(right, left.length)
      return merged
    }

    function schedule(context, samples, startAt) {
      const buffer = context.createBuffer(1, samples.length, SAMPLE_RATE)
      buffer.copyToChannel(samples, 0)
      const source = context.createBufferSource()
      source.buffer = buffer
      source.connect(context.destination)
      source.start(startAt)
      return { source, end: startAt + buffer.duration }
    }

    const EMPTY = new Float32Array(0)

    // WSOLA (waveform-similarity overlap-add): changes duration without moving
    // the pitch, which is the only way to get playback speed here — the DeepSeek
    // TTS API has no speed parameter. Streaming: push() keeps the unfinished
    // tail and returns output as soon as enough of it is settled.
    class Stretcher {
      /** @param {number} durationRatio played length ÷ original length (= 1/speed). */
      constructor(durationRatio) {
        this.ratio = Math.min(4, Math.max(0.25, durationRatio))
        this.frame = 1024 // ~43 ms at 24 kHz
        this.hop = this.frame >> 1
        this.search = this.hop >> 1
        this.minOut = 2048
        this.window = new Float32Array(this.frame)
        for (let i = 0; i < this.frame; i += 1) {
          this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / this.frame)
        }
        this.input = EMPTY
        this.inputBase = 0
        this.out = new Float32Array(4096)
        this.outLen = 0
        this.outBase = 0
        this.frames = 0
        this.prevStart = -1
      }

      #targetAbs() {
        return Math.round((this.frames * this.hop) / this.ratio)
      }

      #grow(needed) {
        if (needed <= this.out.length) return
        let size = this.out.length
        while (size < needed) size *= 2
        const next = new Float32Array(size)
        next.set(this.out.subarray(0, this.outLen))
        this.out = next
      }

      // Nudge the frame start to the offset whose head best continues the
      // previous frame, which is what keeps the waveform from canceling itself.
      #frameStart(inputEnd) {
        const target = this.#targetAbs()
        if (this.prevStart < 0) return target
        const ref = this.prevStart + this.hop
        if (ref + this.hop > inputEnd) return target
        let best = target
        let bestScore = Infinity
        const from = Math.max(0, target - this.search)
        const to = target + this.search
        for (let candidate = from; candidate <= to; candidate += 1) {
          if (candidate + this.frame > inputEnd) break
          let score = 0
          for (let n = 0; n < this.hop; n += 1) {
            const diff = this.input[ref + n - this.inputBase] - this.input[candidate + n - this.inputBase]
            score += diff * diff
            if (score >= bestScore) break
          }
          if (score < bestScore) { bestScore = score; best = candidate }
        }
        return best
      }

      #take() {
        const readyAbs = this.frames * this.hop
        const ready = readyAbs - this.outBase
        if (ready < this.minOut) return EMPTY
        const output = this.out.slice(0, ready)
        const rest = this.out.slice(ready, this.outLen)
        this.out = new Float32Array(Math.max(rest.length + this.frame * 2, 4096))
        this.out.set(rest)
        this.outLen = rest.length
        this.outBase = readyAbs
        return output
      }

      push(samples) {
        if (!samples || samples.length === 0) return EMPTY
        const merged = new Float32Array(this.input.length + samples.length)
        merged.set(this.input)
        merged.set(samples, this.input.length)
        this.input = merged
        const inputEnd = this.inputBase + this.input.length
        for (;;) {
          const start = this.#frameStart(inputEnd)
          if (start + this.frame > inputEnd) break
          const at = this.frames * this.hop - this.outBase
          const local = start - this.inputBase
          this.#grow(at + this.frame)
          for (let n = 0; n < this.frame; n += 1) {
            this.out[at + n] += this.window[n] * this.input[local + n]
          }
          if (at + this.frame > this.outLen) this.outLen = at + this.frame
          this.prevStart = start
          this.frames += 1
          // Drop input that can no longer be reached by a future frame.
          const keepFrom = Math.max(0, this.#targetAbs() - this.search - this.hop)
          if (keepFrom > this.inputBase) {
            this.input = this.input.slice(keepFrom - this.inputBase)
            this.inputBase = keepFrom
          }
        }
        return this.#take()
      }

      flush() {
        if (this.outLen <= 0) return EMPTY
        const output = this.out.slice(0, this.outLen)
        this.out = new Float32Array(4096)
        this.outLen = 0
        this.outBase += output.length
        return output
      }
    }

    // Settings preview: one fixed sentence through the current engine and voice,
    // using the same Host route as a normal read so the sample is cached and the
    // second click is instant. It keeps its own AudioContext, so the read-aloud
    // button state stays untouched.
    const PREVIEW_TEXT = '你好，这是一段语音试听，用来确认音色。Hello, this is a preview.'
    const previewListeners = new Set()
    let previewPhase = 'idle'
    let preview = null

    function setPreviewPhase(phase) {
      if (previewPhase === phase) return
      previewPhase = phase
      for (const listener of previewListeners) {
        try { listener(phase) } catch {}
      }
    }

    function subscribePreview(listener) {
      previewListeners.add(listener)
      return () => { previewListeners.delete(listener) }
    }

    function stopPreview() {
      const active = preview
      preview = null
      if (active) {
        active.cancelled = true
        try { active.controller.abort() } catch {}
        if (active.timer) clearTimeout(active.timer)
        try { if (active.context) active.context.close() } catch {}
        if (active.speech) {
          try { const synth = speechSynth(); if (synth) synth.cancel() } catch {}
        }
      }
      setPreviewPhase('idle')
    }

    function createPreviewScheduler(context, active) {
      const durationRatio = speed > 0 ? 1 / speed : 1
      const stretcher = Math.abs(durationRatio - 1) > 0.01 ? new Stretcher(durationRatio) : null
      let nextTime = 0
      let last = null
      const emit = (samples) => {
        if (!samples || samples.length === 0) return
        const startAt = last ? Math.max(nextTime, context.currentTime) : context.currentTime + START_DELAY
        const scheduled = schedule(context, samples, startAt)
        active.sources.push(scheduled.source)
        nextTime = scheduled.end
        last = scheduled.source
      }
      return {
        feed(samples) {
          if (stretcher) emit(stretcher.push(samples))
          else emit(samples)
        },
        finish() {
          if (stretcher) emit(stretcher.flush())
          return { last, end: nextTime }
        },
      }
    }

    /** Preview through Web Speech: no Host round-trip, no cache, no AudioContext. */
    function playPreviewSpeech() {
      const synth = speechSynth()
      refreshSpeechVoices()
      if (!synth || !speechCapable()) {
        showFailureToast(t('这台环境没有浏览器语音，无法试听', 'no browser voices here'))
        return
      }
      const active = { speech: true, timer: 0, cancelled: false }
      preview = active
      setPreviewPhase('loading')
      const utter = new window.SpeechSynthesisUtterance(PREVIEW_TEXT)
      const voice = pickSpeechVoice()
      if (voice) { utter.voice = voice; utter.lang = voice.lang }
      utter.rate = Math.min(2, Math.max(0.5, speed))
      let started = false
      const done = () => {
        if (preview !== active) return
        preview = null
        if (active.timer) clearTimeout(active.timer)
        setPreviewPhase('idle')
      }
      utter.onstart = () => {
        if (preview !== active) return
        started = true
        setPreviewPhase('playing')
      }
      utter.onend = done
      utter.onerror = (event) => {
        const reason = (event && event.error) || 'unknown'
        if (preview !== active) return
        done()
        if (reason === 'interrupted' || reason === 'canceled') return
        if (reason === 'not-allowed') {
          showFailureToast(t('浏览器要求页面上先有一次点击才允许发声：请再点一次试听',
            'the browser needs one click on this page before it may speak; try again'))
          return
        }
        showFailureToast(t('试听失败：', 'preview failed: ') + reason)
      }
      active.timer = setTimeout(() => {
        if (started || preview !== active) return
        try { synth.cancel() } catch {}
        done()
        showFailureToast(isCloudVoice(voice)
          ? t('这个云端音色 8 秒内没有出声，多半连不上厂商服务器；换成 ⌂ 本地音色试试',
            'the cloud voice stayed silent for 8 s — it cannot reach its server; try a local voice')
          : t('浏览器 8 秒内没有出声，可能被自动播放策略挡住', 'no sound in 8 s; the browser may be blocking autoplay'))
      }, SPEECH_FIRST_TIMEOUT_MS)
      try { synth.speak(utter) } catch (error) {
        done()
        showFailureToast((error && error.message) || String(error))
      }
    }

    async function playPreview() {
      if (preview) { stopPreview(); return }
      if (engineMode === 'bridge' || (engineMode === 'browser' && usesBridge())) {
        void openBridge({ text: PREVIEW_TEXT })
        return
      }
      if (engineMode === 'browser') {
        playPreviewSpeech()
        return
      }
      const active = { context: null, controller: new AbortController(), sources: [], timer: 0, cancelled: false }
      preview = active
      setPreviewPhase('loading')
      try {
        // Created inside the click: browsers only allow sound from a gesture.
        const context = new AudioContext({ sampleRate: SAMPLE_RATE })
        active.context = context
        void context.resume().catch(() => {})
        const response = await fetch(READ_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: PREVIEW_TEXT }),
          signal: active.controller.signal,
        })
        const type = String(response.headers.get('content-type') || '')
        if (type.indexOf('application/json') !== -1) {
          let payload = null
          try { payload = await response.json() } catch {}
          throw new Error((payload && payload.error) || t('语音合成失败', 'Speech synthesis failed'))
        }
        if (!response.ok || !response.body) {
          throw new Error(t('语音合成失败', 'Speech synthesis failed') + ' (HTTP ' + response.status + ')')
        }
        if (preview === active) setPreviewPhase('playing')
        const reader = response.body.getReader()
        active.controller.signal.addEventListener('abort', () => { void reader.cancel().catch(() => {}) })
        const scheduler = createPreviewScheduler(context, active)
        let rest = new Uint8Array(0)
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (active.cancelled) return
          const merged = concatBytes(rest, value)
          const samples = toFloat32(merged)
          rest = merged.slice(samples.length * 2)
          if (samples.length === 0) continue
          scheduler.feed(samples)
        }
        if (active.cancelled) return
        const { last, end } = scheduler.finish()
        const reset = () => {
          if (preview !== active) return
          preview = null
          try { context.close() } catch {}
          setPreviewPhase('idle')
        }
        if (!last) { reset(); return }
        // Web Audio keeps playing after the stream ends; release it when the
        // scheduled tail is over.
        active.timer = setTimeout(reset, Math.max(0, (end - context.currentTime) * 1000) + 200)
      } catch (error) {
        if (active.cancelled) return
        if (preview === active) preview = null
        try { if (active.context) active.context.close() } catch {}
        setPreviewPhase('idle')
        showFailureToast((error && error.message) || String(error))
      }
    }

    // ------------------------------------------------------------- unit player
    // Playback is per paragraph: /plan lists the paragraphs, /read with a unit
    // index streams one of them. The floating window navigates them and a speed
    // change only re-renders the part that has not been heard yet.
    let player = null
    let playerWindowEl = null
    let speedSaveTimer = 0
    let lastBarPaint = 0
    const PLAYER_UNIT_GAP_MS = 60

    const previewOf = (unit) => {
      const text = unit && typeof unit.text === 'string' ? unit.text : ''
      const trimmed = text.replace(/\s+/g, ' ').trim()
      return trimmed.length > 28 ? trimmed.slice(0, 28) + '…' : trimmed
    }

    function concatFloat(chunks) {
      let length = 0
      for (const chunk of chunks) length += chunk.length
      const out = new Float32Array(length)
      let offset = 0
      for (const chunk of chunks) {
        out.set(chunk, offset)
        offset += chunk.length
      }
      return out
    }

    function playerClampSpeed(value) {
      const number = Number(value)
      return Number.isFinite(number) ? Math.min(2, Math.max(0.5, Math.round(number * 100) / 100)) : 1
    }

    function playerStopSources(session) {
      for (const source of session.sources) {
        try { source.onended = null } catch {}
        try { source.stop() } catch {}
        try { source.disconnect() } catch {}
      }
      session.sources = []
      session.last = null
      session.nextTime = 0
      session.startTime = 0
    }

    function playerStop() {
      const session = player
      player = null
      if (session && session.kind === 'speech') {
        // Browser speech owns no AudioContext: cancel the queue and drop timers.
        if (session.timer) clearTimeout(session.timer)
        if (session.watchdog) clearTimeout(session.watchdog)
        try { const synth = speechSynth(); if (synth) synth.cancel() } catch {}
        highlightStop()
        current = null
        updatePlayerWindow()
        return
      }
      if (session) {
        if (session.pendingNext) clearTimeout(session.pendingNext)
        if (session.prefetch) { try { session.prefetch.controller.abort() } catch {} }
        if (session.req) { try { session.req.abort() } catch {} }
        try { session.controller.abort() } catch {}
        playerStopSources(session)
        try { session.context.close() } catch {}
        highlightStop()
      }
      current = null
      updatePlayerWindow()
    }

    function playerEnsureStretcher(session) {
      const ratio = session.renderSpeed > 0 ? 1 / session.renderSpeed : 1
      session.stretcher = Math.abs(ratio - 1) > 0.01 ? new Stretcher(ratio) : null
    }

    function playerSchedule(session, samples, gen) {
      if (!samples || samples.length === 0) return
      const context = session.context
      if (!context) return
      const now = context.currentTime
      const startAt = session.last ? Math.max(session.nextTime, now) : now + START_DELAY
      if (!session.last) session.startTime = startAt
      const scheduled = schedule(context, samples, startAt)
      session.sources.push(scheduled.source)
      session.nextTime = scheduled.end
      session.last = scheduled.source
      session.gen = gen
    }

    function playerFeedSamples(session, samples, gen) {
      if (!samples || samples.length === 0) return
      session.chunks.push(samples)
      session.totalSamples += samples.length
      if (session.stretcher) playerSchedule(session, session.stretcher.push(samples), gen)
      else playerSchedule(session, samples, gen)
    }

    /** Re-render everything after a speed change, starting where the ear is. */
    function playerRerender(session, nextSpeed) {
      const context = session.context
      if (!context) return
      const now = context.currentTime
      const flat = concatFloat(session.chunks)
      const elapsed = session.last ? Math.max(0, now - session.startTime) : 0
      const played = Math.min(flat.length, Math.round(elapsed * session.renderSpeed * SAMPLE_RATE))
      const gen = session.gen
      playerStopSources(session)
      session.speed = nextSpeed
      session.renderSpeed = nextSpeed
      playerEnsureStretcher(session)
      session.startTime = now - (played / SAMPLE_RATE) / Math.max(0.01, nextSpeed)
      const remainder = flat.subarray(played)
      const fed = session.stretcher ? session.stretcher.push(remainder) : remainder
      if (fed.length) playerSchedule(session, fed, gen)
      // The unit already finished streaming: flush the stretcher now, or the
      // re-render would leave its buffered tail unscheduled.
      if (session.ended && session.stretcher) {
        const tail = session.stretcher.flush()
        if (tail.length) playerSchedule(session, tail, gen)
      }
      if (session.ended && session.last) {
        session.last.onended = () => { if (player === session && session.gen === gen) playerAdvance(session, gen) }
      }
    }

    function playerApplySpeed(nextSpeed) {
      const next = playerClampSpeed(nextSpeed)
      const session = player
      if (session && session.kind === 'speech') {
        // A running utterance keeps its old rate, so restart the current
        // paragraph from the last word boundary to make the change audible now.
        session.speed = next
        playerView({ speed: next })
        if (!session.desiredPaused) speakSpeechQueue(session, session.unit, session.skip || 0)
      } else if (session) {
        playerRerender(session, next)
        playerView({ speed: next })
      }
      if (next === speed) return
      speed = next
      // Persist for later reads, but never twice per drag.
      if (speedSaveTimer) clearTimeout(speedSaveTimer)
      speedSaveTimer = setTimeout(() => {
        speedSaveTimer = 0
        void fetch(CONFIG_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ speed: next }),
        }).catch(() => {})
      }, 350)
    }

    function playerTogglePause() {
      const session = player
      if (!session) return
      if (session.phase === 'paused') playerResume()
      else playerPause()
    }

    function playerPause() {
      const session = player
      if (!session) return
      if (session.kind === 'speech') {
        session.desiredPaused = true
        session.phase = 'paused'
        try { const synth = speechSynth(); if (synth) synth.pause() } catch {}
        setPlayback({ phase: 'paused' })
        playerView({ phase: 'paused' })
        return
      }
      if (!session.context) return
      session.desiredPaused = true
      session.phase = 'paused'
      try { void session.context.suspend().catch(() => {}) } catch {}
      setPlayback({ phase: 'paused' })
      playerView({ phase: 'paused' })
    }

    function playerResume() {
      const session = player
      if (!session) return
      if (session.kind === 'speech') {
        session.desiredPaused = false
        session.phase = 'playing'
        try { const synth = speechSynth(); if (synth) synth.resume() } catch {}
        setPlayback({ phase: 'playing' })
        playerView({ phase: 'playing' })
        return
      }
      if (!session.context) return
      session.desiredPaused = false
      session.phase = 'playing'
      try { void session.context.resume().catch(() => {}) } catch {}
      setPlayback({ phase: 'playing' })
      playerView({ phase: 'playing' })
    }

    function playerStep(delta) {
      const session = player
      if (!session) return
      const target = session.unit + delta
      if (target < 0 || target >= session.units.length) return
      if (session.kind === 'speech') speakSpeechQueue(session, target, 0)
      else void playerPlayUnit(session, target)
    }

    function playerAdvance(session, gen) {
      if (player !== session || session.gen !== gen) return
      if (session.unit + 1 >= session.units.length) {
        playerFinish()
        return
      }
      session.pendingNext = setTimeout(() => {
        session.pendingNext = 0
        if (player === session) void playerPlayUnit(session, session.unit + 1)
      }, PLAYER_UNIT_GAP_MS)
    }

    function playerFinish() {
      playerStop()
      setPlayback({ key: null, phase: 'idle', error: '' })
      drainQueue()
    }

    function playerEndUnit(session, gen) {
      if (player !== session || session.gen !== gen) return
      session.ended = true
      if (!session.last) { playerAdvance(session, gen); return }
      // Synthesis may have finished before the audio did; then advance right away.
      if (session.nextTime <= session.context.currentTime + 0.02) { playerAdvance(session, gen); return }
      session.last.onended = () => { if (player === session && session.gen === gen) playerAdvance(session, gen) }
    }

    function playerUnitRequest(session, index, signal) {
      const unit = session.units[index]
      const body = {
        unit: index,
        unitTotal: session.units.length,
        // The plan already has this paragraph, so the Host can synthesize it
        // without reading the session again — that read is the slowest local step.
        unitText: unit && typeof unit.text === 'string' ? unit.text : '',
      }
      if (!body.unitText) delete body.unitText
      if (session.sessionId && session.messageId) {
        body.sessionId = session.sessionId
        body.messageId = session.messageId
      }
      // Fallback for a Host that does not understand unitText: a selection
      // re-resolves to the same plan, so `unit` still addresses it.
      if (session.selection) body.text = session.selection
      return fetch(READ_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      })
    }

    /**
     * Synthesize the next paragraph in the background while this one plays. Its
     * audio is buffered, or handed to the player once it becomes current, so a
     * paragraph boundary no longer waits for the whole next paragraph: a long
     * one starts from whatever is buffered and keeps streaming as it plays.
     */
    function playerPrefetch(session, index) {
      if (!session || index < 0 || index >= session.units.length) return
      if (session.prefetch && session.prefetch.index === index) return
      if (session.prefetch) { try { session.prefetch.controller.abort() } catch {} }
      const controller = new AbortController()
      let finish = () => {}
      let failPrefetch = () => {}
      const record = {
        index,
        controller,
        chunks: [],
        consumer: null,
        done: false,
        error: null,
        finished: new Promise((resolve) => { finish = resolve }),
        failed: new Promise((_resolve, reject) => { failPrefetch = reject }),
      }
      record.failed.catch(() => {})
      session.prefetch = record
      void (async () => {
        try {
          const response = await playerUnitRequest(session, index, controller.signal)
          const type = String(response.headers.get('content-type') || '')
          if (type.indexOf('application/json') !== -1) {
            let payload = null
            try { payload = await response.json() } catch {}
            throw new Error((payload && payload.error) || t('语音合成失败', 'Speech synthesis failed'))
          }
          if (!response.ok || !response.body) {
            throw new Error(t('语音合成失败', 'Speech synthesis failed') + ' (HTTP ' + response.status + ')')
          }
          const reader = response.body.getReader()
          controller.signal.addEventListener('abort', () => { void reader.cancel().catch(() => {}) })
          let rest = new Uint8Array(0)
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            const merged = concatBytes(rest, value)
            const samples = toFloat32(merged)
            rest = merged.slice(samples.length * 2)
            if (samples.length === 0) continue
            if (record.consumer) record.consumer(samples)
            else record.chunks.push(samples)
            if (record.chunks.length > 512) record.chunks.splice(0, record.chunks.length - 512)
          }
          record.done = true
          finish()
        } catch (error) {
          record.done = true
          if (controller.signal.aborted) { finish(); return }
          record.error = error
          failPrefetch(error)
          finish()
        }
      })()
    }

    async function playerPlayUnit(session, index) {
      if (player !== session) return
      const target = Math.max(0, Math.min(index, session.units.length - 1))
      session.unit = target
      session.gen += 1
      const gen = session.gen
      session.ended = false
      session.chunks = []
      session.totalSamples = 0
      session.stretcher = null
      session.speed = speed
      session.renderSpeed = speed
      playerStopSources(session)
      if (session.req) { try { session.req.abort() } catch {} }
      if (session.pendingNext) { clearTimeout(session.pendingNext); session.pendingNext = 0 }
      // A prefetched paragraph is already being synthesized, so its buffered
      // audio plays at once and the rest is handed over as it arrives.
      const prefetched = session.prefetch && session.prefetch.index === target ? session.prefetch : null
      if (prefetched) session.prefetch = null
      const controller = prefetched ? prefetched.controller : new AbortController()
      session.req = controller
      session.phase = session.desiredPaused ? 'paused' : 'loading'
      playerView({ unit: target, phase: session.phase, speed: session.speed, preview: previewOf(session.units[target]) })
      setPlayback({ key: session.key, phase: session.phase })
      if (session.desiredPaused) {
        try { void session.context.suspend().catch(() => {}) } catch {}
      }
      highlightParagraph(session, target)

      try {
        if (prefetched) {
          const record = prefetched
          playerEnsureStretcher(session)
          for (const chunk of record.chunks) playerFeedSamples(session, chunk, gen)
          record.chunks = []
          if (session.chunks.length > 0 && !session.desiredPaused) {
            session.phase = 'playing'
            playerView({ phase: 'playing' })
            setPlayback({ phase: 'playing' })
          }
          record.consumer = (samples) => {
            if (player !== session || session.gen !== gen) return
            if (session.phase === 'loading') {
              session.phase = 'playing'
              playerView({ phase: 'playing' })
              setPlayback({ phase: 'playing' })
            }
            playerFeedSamples(session, samples, gen)
          }
          playerPrefetch(session, target + 1)
          await record.finished
          if (player !== session || session.gen !== gen) return
          record.consumer = null
          if (controller.signal.aborted) return
          if (record.error) { fail(session.key, record.error); return }
          if (session.stretcher) {
            const tail = session.stretcher.flush()
            if (tail.length) playerSchedule(session, tail, gen)
          }
          playerEndUnit(session, gen)
          return
        }

        const response = await playerUnitRequest(session, target, controller.signal)
        const type = String(response.headers.get('content-type') || '')
        if (type.indexOf('application/json') !== -1) {
          let payload = null
          try { payload = await response.json() } catch {}
          throw new Error((payload && payload.error) || t('语音合成失败', 'Speech synthesis failed'))
        }
        if (!response.ok || !response.body) {
          throw new Error(t('语音合成失败', 'Speech synthesis failed') + ' (HTTP ' + response.status + ')')
        }
        if (player !== session || session.gen !== gen) return
        // The next paragraph is opened while this one plays.
        playerPrefetch(session, target + 1)
        const reader = response.body.getReader()
        controller.signal.addEventListener('abort', () => { void reader.cancel().catch(() => {}) })
        playerEnsureStretcher(session)
        let rest = new Uint8Array(0)
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (player !== session || session.gen !== gen) return
          const merged = concatBytes(rest, value)
          const samples = toFloat32(merged)
          rest = merged.slice(samples.length * 2)
          if (samples.length === 0) continue
          if (session.phase === 'loading') {
            session.phase = 'playing'
            playerView({ phase: 'playing' })
            setPlayback({ phase: 'playing' })
          }
          playerFeedSamples(session, samples, gen)
        }
        if (player !== session || session.gen !== gen) return
        if (session.stretcher) {
          const tail = session.stretcher.flush()
          if (tail.length) playerSchedule(session, tail, gen)
        }
        playerEndUnit(session, gen)
      } catch (error) {
        if (player !== session || session.gen !== gen) return
        if (controller.signal.aborted) return
        fail(session.key, error)
      }
    }

    // ------------------------------------------------ browser speech playback
    // Web Speech hands back no samples: there is nothing to cache, and the only
    // speed control is the utterance rate. The same floating window drives it.
    function speechTimersOff(session) {
      if (!session) return
      if (session.timer) { clearTimeout(session.timer); session.timer = 0 }
      if (session.watchdog) { clearTimeout(session.watchdog); session.watchdog = 0 }
    }

    // ------------------------------------------------------ reading highlight
    // Two layers painted over the message itself: the paragraph being read and
    // the word inside it. The CSS Custom Highlight API paints live Ranges, so
    // nothing is inserted into a React-rendered message where the next render
    // would wipe it.
    const HIGHLIGHT_STYLE_ID = 'dsh-tts-reader-highlight-style'
    const PARA_HIGHLIGHT = 'dsh-tts-para'
    const WORD_HIGHLIGHT = 'dsh-tts-word'
    const PARA_FALLBACK_CLASS = 'dsh-tts-reading'
    let highlightState = null
    let lastUserScroll = 0
    let scrollWatchInstalled = false

    function installScrollWatch() {
      if (scrollWatchInstalled || typeof window === 'undefined') return
      scrollWatchInstalled = true
      // Only a real gesture counts: our own scrollIntoView must not look like
      // the reader taking the scroll position over.
      const mark = () => { lastUserScroll = performance.now() }
      for (const name of ['wheel', 'touchmove', 'keydown', 'pointerdown']) {
        try { window.addEventListener(name, mark, { passive: true }) } catch {}
      }
    }

    function ensureHighlightStyle() {
      if (typeof document === 'undefined' || !document.head) return false
      if (!document.getElementById(HIGHLIGHT_STYLE_ID)) {
        const style = document.createElement('style')
        style.id = HIGHLIGHT_STYLE_ID
        style.textContent = [
          '::highlight(' + PARA_HIGHLIGHT + '){background-color:rgba(88,140,255,.15)}',
          // Yellow, the way a highlighter pen works: the word has to stand out
          // from the blue paragraph wash, on both light and dark surfaces.
          '::highlight(' + WORD_HIGHLIGHT + '){background-color:#f5c542;color:#241a00}',
          '.' + PARA_FALLBACK_CLASS + '{background-color:rgba(88,140,255,.15);border-radius:4px}',
        ].join('')
        document.head.appendChild(style)
      }
      installScrollWatch()
      return true
    }

    /** The Host's whitespace collapsing (index.js normalizeForMatch), client copy. */
    function normalizeProbe(value) {
      return String(value || '')
        .replace(/[\u2022\u25e6\u25cf\u00b7]\s*/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    }

    /** Leaf block tags: one rendered paragraph, list item, heading or cell. */
    const BLOCK_TAGS = new Set(['P', 'LI', 'TD', 'TH', 'DT', 'DD', 'BLOCKQUOTE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'FIGCAPTION'])

    /**
     * Which leaf block every text node belongs to. A unit of speech starts at a
     * block start, so this is what tells a real paragraph match from the same
     * words happening to appear inside another paragraph.
     */
    function blockMapOf(root) {
      const owners = new Map()
      const hasBlock = new Map()
      const tagOf = (el) => String((el && el.tagName) || '').toUpperCase()
      const scan = (el) => {
        let found = false
        for (const child of el.children || []) {
          if (BLOCK_TAGS.has(tagOf(child)) || scan(child)) found = true
        }
        hasBlock.set(el, found)
        return found
      }
      scan(root)
      const assign = (el, owner) => {
        const own = BLOCK_TAGS.has(tagOf(el)) && !hasBlock.get(el) ? el : owner
        for (const child of el.childNodes || []) {
          if (child.nodeType === 3) owners.set(child, own)
          else if (child.nodeType === 1) assign(child, own)
        }
      }
      assign(root, null)
      return owners
    }

    /**
     * The message's visible text, collapsed the way the Host collapses it, plus
     * where every kept character lives in the DOM and where each block starts.
     */
    function buildMessageIndex(root) {
      const chars = []
      const nodes = []
      const offsets = []
      const blockStarts = new Set()
      const owners = blockMapOf(root)
      let pendingSpace = false
      let currentOwner = null
      let first = true
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const parent = node.parentElement
          if (!parent) return NodeFilter.FILTER_REJECT
          const tag = String(parent.tagName || '').toUpperCase()
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'SVG') return NodeFilter.FILTER_REJECT
          return NodeFilter.FILTER_ACCEPT
        },
      })
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const owner = owners.get(node) || node.parentElement || null
        const value = node.nodeValue || ''
        for (let index = 0; index < value.length; index += 1) {
          const ch = value[index]
          if (ch === '\u2022' || ch === '\u25e6' || ch === '\u25cf' || ch === '\u00b7' || /\s/.test(ch)) {
            pendingSpace = true
            continue
          }
          if (pendingSpace && chars.length > 0) {
            chars.push(' ')
            nodes.push(node)
            offsets.push(index)
          }
          pendingSpace = false
          if (owner !== currentOwner) {
            currentOwner = owner
            // The leading space belongs to the block break, not to the block:
            // record the offset of the block's first real character.
            if (!first) blockStarts.add(chars.length)
            first = false
          }
          chars.push(ch)
          nodes.push(node)
          offsets.push(index)
        }
      }
      return { text: chars.join(''), nodes, offsets, blockStarts }
    }

    /** Where each unit's text sits inside that index; null when it cannot be found. */
    function locateUnits(index, units) {
      const spans = []
      const text = index.text
      const starts = index.blockStarts
      // A unit begins a rendered block, or continues the one before it when a
      // long paragraph was cut in two. Anything else is a false positive: the
      // same words can appear inside another paragraph ("这里是代码块" is also a
      // phrase a reply may quote), and accepting it would push the cursor past
      // every paragraph in between.
      let cursor = 0
      const find = (needle, from, continuation) => {
        let at = text.indexOf(needle, from)
        while (at !== -1) {
          if (!starts || starts.size === 0 || starts.has(at) || at === continuation) return at
          at = text.indexOf(needle, at + 1)
        }
        return -1
      }
      for (const unit of units) {
        const exact = normalizeProbe(unit && unit.text)
        const continuation = cursor
        let at = exact ? find(exact, cursor, continuation) : -1
        let size = exact.length
        if (at === -1 && exact.length > 40) {
          // Markdown may rewrite the middle of a paragraph (code fences, table
          // cells), so anchor on the head and grow while the text still matches.
          size = 40
          at = find(exact.slice(0, size), cursor, continuation)
          if (at !== -1) {
            while (size < exact.length && text[at + size] === exact[size]) size += 1
          }
        }
        if (at === -1) { spans.push(null); continue }
        cursor = at + size
        spans.push({ start: at, end: at + size })
      }
      return spans
    }

    function domRangeOf(index, span) {
      if (!span || span.end <= span.start) return null
      const first = index.nodes[span.start]
      const last = index.nodes[span.end - 1]
      if (!first || !last) return null
      try {
        const range = document.createRange()
        range.setStart(first, index.offsets[span.start])
        range.setEnd(last, index.offsets[span.end - 1] + 1)
        return range
      } catch { return null }
    }

    /** The smallest ancestor that holds the reply, not just the action row. */
    function messageRootOf(button, units) {
      if (!button || typeof document === 'undefined') return null
      const last = units[units.length - 1]
      const first = units[0]
      const probes = [normalizeProbe(last && last.text).slice(0, 24), normalizeProbe(first && first.text).slice(0, 24)]
        .filter((probe) => probe.length >= 4)
      if (probes.length === 0) return null
      // A message that ends with a code block or a table ends with a placeholder
      // ("这里是代码块") that no rendered text contains, so the last probe alone
      // would never match: fall back to "holds most of the reply's text".
      const total = units.reduce((sum, unit) => sum + normalizeProbe(unit && unit.text).length, 0)
      let node = button
      for (let depth = 0; node && depth < 16; depth += 1, node = node.parentElement) {
        if (node === document.body || node === document.documentElement) break
        const text = normalizeProbe(node.textContent)
        if (probes.every((probe) => text.indexOf(probe) !== -1)) return node
        if (total > 0 && text.length >= total * 0.6 && probes.some((probe) => text.indexOf(probe) !== -1)) return node
      }
      return null
    }

    function highlightDetach() {
      const state = highlightState
      highlightState = null
      try {
        if (window.CSS && window.CSS.highlights) {
          window.CSS.highlights.delete(PARA_HIGHLIGHT)
          window.CSS.highlights.delete(WORD_HIGHLIGHT)
        }
      } catch {}
      if (state && state.marker) { try { state.marker.classList.remove(PARA_FALLBACK_CLASS) } catch {} }
    }

    function highlightStop() {
      highlightDetach()
    }

    function highlightAttach(session, anchor, units) {
      highlightDetach()
      if (!anchor || typeof document === 'undefined' || !units || units.length === 0) return
      if (!ensureHighlightStyle()) return
      const root = messageRootOf(anchor, units)
      if (!root) return
      const index = buildMessageIndex(root)
      if (!index.text) return
      const spans = locateUnits(index, units)
      if (spans.every((span) => !span)) return
      const supported = !!(window.CSS && window.CSS.highlights && typeof window.Highlight === 'function')
      highlightState = {
        session, index, spans,
        domRanges: spans.map((span) => domRangeOf(index, span)),
        raw: units.map((unit) => String((unit && unit.text) || '')),
        supported, marker: null, paintedUnit: -1,
      }
    }

    function followParagraph(state, unit) {
      const range = state.domRanges && state.domRanges[unit]
      if (!range) return
      if (typeof performance !== 'undefined' && performance.now() - lastUserScroll < 3000) return
      const node = range.startContainer && range.startContainer.parentElement
      if (!node || typeof node.getBoundingClientRect !== 'function') return
      const rect = node.getBoundingClientRect()
      const height = window.innerHeight || 0
      if (rect.top >= 0 && rect.bottom <= height) return
      try { node.scrollIntoView({ block: 'center', behavior: 'smooth' }) } catch {
        try { node.scrollIntoView() } catch {}
      }
    }

    function highlightParagraph(session, unit) {
      const state = highlightState
      if (!state || state.session !== session) return
      if (state.paintedUnit === unit) return
      state.paintedUnit = unit
      // The word layer belongs to the paragraph that just ended.
      clearWordHighlight()
      if (state.supported) {
        const range = state.domRanges[unit]
        try {
          if (range) window.CSS.highlights.set(PARA_HIGHLIGHT, new window.Highlight(range))
          else window.CSS.highlights.delete(PARA_HIGHLIGHT)
        } catch {}
      } else {
        // No Highlight API: a class on the block element that starts the paragraph.
        const span = state.spans[unit]
        const node = span ? state.index.nodes[span.start] : null
        const parent = node && node.parentElement
        const block = parent ? parent.closest('p,li,td,th,pre,blockquote,h1,h2,h3,h4,h5,h6,div') : null
        if (state.marker && state.marker !== block) { try { state.marker.classList.remove(PARA_FALLBACK_CLASS) } catch {} }
        state.marker = block || null
        if (block) { try { block.classList.add(PARA_FALLBACK_CLASS) } catch {} }
      }
      followParagraph(state, unit)
    }

    function paintWord(state, unit, at, size) {
      const span = state.spans[unit]
      if (!span) return
      const start = Math.max(span.start, Math.min(at, span.end - 1))
      const end = Math.max(start + 1, Math.min(span.end, start + Math.max(1, size || 1)))
      const range = domRangeOf(state.index, { start, end })
      try {
        if (range) window.CSS.highlights.set(WORD_HIGHLIGHT, new window.Highlight(range))
        else window.CSS.highlights.delete(WORD_HIGHLIGHT)
      } catch {}
    }

    /**
     * The word inside the current paragraph, fed by a boundary event. Only a
     * voice that reports word boundaries ever calls this: without them the
     * paragraph layer is the whole story, and a guessed word position would be
     * a lie rather than a reading aid.
     */
    function highlightWord(session, unit, inUnit, length) {
      const state = highlightState
      if (!state || state.session !== session || !state.supported) return
      const raw = state.raw[unit] || ''
      const span = state.spans[unit]
      if (!raw || !span) return
      const from = Math.max(0, Math.min(Number(inUnit) || 0, raw.length - 1))
      const width = Math.max(1, Math.min(24, Number(length) || 8))
      const needle = normalizeProbe(raw.slice(from, from + width))
      if (!needle) return
      // The same word can appear several times in one paragraph. Picking the
      // first copy makes the mark jump back to it on every repeat, so the copy
      // nearest the engine's own character offset wins; on a tie the later one
      // does, because the reading only moves forward.
      const target = span.start + Math.max(0, Math.min(span.end - span.start - 1, from))
      let at = -1
      let gap = Infinity
      let found = state.index.text.indexOf(needle, span.start)
      while (found !== -1 && found + needle.length <= span.end) {
        const distance = Math.abs(found - target)
        if (distance < gap || (distance === gap && found > at)) {
          at = found
          gap = distance
        }
        found = state.index.text.indexOf(needle, found + 1)
      }
      if (at === -1) at = Math.min(target, span.end - 1)
      paintWord(state, unit, at, needle.length)
    }

    /** Drop the word layer when the paragraph changes or the read stops. */
    function clearWordHighlight() {
      try {
        if (window.CSS && window.CSS.highlights) window.CSS.highlights.delete(WORD_HIGHLIGHT)
      } catch {}
    }

    /** Short "which voice · which signals" label for the floating window. */
    function speechLabel(session) {
      const name = String(session.voiceName || '')
      const short = name
        .replace(/^Microsoft\s+/i, '')
        .replace(/\s+Online$/i, ' ' + t('在线', 'online'))
        .replace(/\s+Desktop$/i, '')
      const bits = []
      if (short) bits.push((session.voiceCloud ? '☁ ' : '⌂ ') + short)
      if (session.boundarySeen) bits.push(t('逐词', 'words'))
      return bits.join(' · ')
    }

    /**
     * Queue one utterance per paragraph in a single call: the engine plays them
     * back to back, so nothing waits on us between paragraphs, and each
     * `onstart` says exactly which paragraph is being read — no word timings
     * needed (network voices never send them).
     */
    function speakSpeechQueue(session, startUnit, startSkip) {
      if (player !== session) return
      const synth = speechSynth()
      if (!synth) {
        fail(session.key, new Error(t('这个环境没有浏览器朗读能力', 'browser speech is not available here')))
        return
      }
      if (session.units.length === 0) return
      // Character offsets per paragraph: what the progress bar measures against.
      let chars = 0
      session.charStarts = []
      for (let index = 0; index < session.units.length; index += 1) {
        session.charStarts[index] = chars
        chars += String((session.units[index] && session.units[index].text) || '').length
      }
      session.totalChars = chars
      const from = Math.max(0, Math.min(Number(startUnit) || 0, session.units.length - 1))
      const firstText = String((session.units[from] && session.units[from].text) || '')
      const skip = Math.max(0, Math.min(Number(startSkip) || 0, Math.max(0, firstText.length - 1)))
      session.gen += 1
      const gen = session.gen
      speechTimersOff(session)
      try { synth.cancel() } catch {}
      session.phase = session.desiredPaused ? 'paused' : 'loading'
      session.unit = from
      session.skip = skip
      session.boundary = skip
      playerView({ unit: from, phase: session.phase, speed: session.speed, preview: previewOf(session.units[from]) })
      setPlayback({ key: session.key, phase: session.phase })
      highlightParagraph(session, from)

      const voice = pickSpeechVoice()
      session.voiceName = voice ? String(voice.name || '') : ''
      session.voiceCloud = isCloudVoice(voice)
      session.boundarySeen = false
      let started = false
      const items = []
      for (let index = from; index < session.units.length; index += 1) {
        const text = String((session.units[index] && session.units[index].text) || '')
        const begin = index === from ? skip : 0
        const rest = text.slice(begin)
        if (!rest) continue
        items.push({ index, begin, rest })
      }

      // A cloud voice that cannot reach its vendor never fires onstart and never
      // fires onerror, so silence is the only signal.
      session.watchdog = setTimeout(() => {
        session.watchdog = 0
        if (started || player !== session) return
        const cloud = isCloudVoice(voice)
        // A desktop shell that stayed silent switches itself to the bridge, so
        // the next click does not wait eight seconds again.
        if (isDesktopShell) rememberSpeechVoice(LEGACY_BRIDGE_TARGET)
        // Persist the switch, or the next read starts the same dead engine again.
        if (isDesktopShell) void saveEngine('bridge')
        fail(session.key, new Error(cloud
          ? t('这个云端音色 8 秒内没有出声（多半连不上厂商服务器），请换成 ⌂ 本地音色',
            'no sound from this cloud voice in 8 s; it cannot reach its server — pick a local voice')
          : isDesktopShell
            ? t('这个桌面外壳没能出声，已切换到朗读桥：再点一次朗读会在浏览器里读',
              'this desktop shell stayed silent; it now uses the bridge — press read again')
            : t('浏览器 8 秒内没有出声，可能被自动播放策略挡住，请再点一次朗读',
              'no sound in 8 s; the browser may be blocking autoplay — press read again')))
      }, SPEECH_FIRST_TIMEOUT_MS)

      // Chrome drops speak() calls issued in the same tick as cancel(): yield,
      // then hand the whole reply to the engine at once.
      session.timer = setTimeout(() => {
        session.timer = 0
        if (player !== session || session.gen !== gen) return
        for (const item of items) {
          const utter = new window.SpeechSynthesisUtterance(item.rest)
          if (voice) { utter.voice = voice; utter.lang = voice.lang }
          utter.rate = Math.min(2, Math.max(0.5, Number(session.speed) || 1))
          utter.pitch = 1
          utter.volume = 1
          utter.onstart = () => {
            if (player !== session || session.gen !== gen) return
            started = true
            if (session.watchdog) { clearTimeout(session.watchdog); session.watchdog = 0 }
            session.unit = item.index
            session.skip = item.begin
            session.boundary = item.begin
            session.phase = session.desiredPaused ? 'paused' : 'playing'
            playerView({ unit: item.index, phase: session.phase, preview: previewOf(session.units[item.index]) })
            setPlayback({ phase: session.phase })
            highlightParagraph(session, item.index)
          }
          utter.onboundary = (event) => {
            if (player !== session || session.gen !== gen) return
            if (!event || typeof event.charIndex !== 'number') return
            // Relative to this paragraph's utterance, which starts at `begin`.
            const at = item.begin + event.charIndex
            session.skip = at
            session.boundary = at
            highlightWord(session, item.index, at, event.charLength || 1)
            if (!session.boundarySeen) {
              // Only the first one repaints the window: this flips a label once.
              session.boundarySeen = true
              lastBarPaint = Date.now()
              playerView({})
            } else if (Date.now() - lastBarPaint > 150) {
              // Word boundaries are frequent; the bar only needs a few repaints.
              lastBarPaint = Date.now()
              playerView({})
            }
          }
          utter.onend = () => {
            if (player !== session || session.gen !== gen) return
            if (item.index + 1 < session.units.length) return
            speechTimersOff(session)
            playerFinish()
          }
          utter.onerror = (event) => {
            if (player !== session || session.gen !== gen) return
            const reason = (event && event.error) || 'unknown'
            if (reason === 'interrupted' || reason === 'canceled') return
            speechTimersOff(session)
            // Autoplay policy: speech driven by an event (auto-read) may be
            // blocked until the page sees a click. Say so instead of "failed".
            if (reason === 'not-allowed') {
              fail(session.key, new Error(t('浏览器要求页面上先有一次点击才允许发声：请点一下朗读按钮。',
                'the browser needs one click on this page before it may speak; press read')))
              return
            }
            fail(session.key, new Error(t('浏览器朗读失败：', 'browser speech failed: ') + reason))
          }
          try { synth.speak(utter) } catch (error) { fail(session.key, error); return }
        }
      }, 30)
    }

    async function startSpeechReadAloud(sessionId, messageId, stateKey, selection, root, auto) {
      refreshSpeechVoices()
      if (!speechCapable()) {
        fail(stateKey, new Error(t('这台环境没有浏览器语音', 'no browser voices here')), auto)
        return
      }
      stopCurrentOnly()
      const session = {
        kind: 'speech',
        key: stateKey, sessionId, messageId, selection: selection || '', auto,
        units: [], unit: 0, total: 0, phase: 'loading', desiredPaused: false,
        speed, boundary: 0, gen: 0, watchdog: 0, timer: 0,
        skip: 0, root: root || null,
        view: { open: true, unit: 0, total: 0, phase: 'loading', speed, preview: '' },
      }
      player = session
      current = { key: stateKey }
      playedMessages.add(stateKey)
      setPlayback({ key: stateKey, phase: 'loading', error: '' })
      updatePlayerWindow()
      try {
        const response = await fetch(PLAN_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...(sessionId && messageId ? { sessionId, messageId } : {}),
            ...(selection ? { text: selection } : {}),
          }),
        })
        const payload = await response.json().catch(() => null)
        if (player !== session) return
        if (!response.ok || !payload || payload.ok !== true) {
          throw new Error(hostErrorText(payload) || (payload && payload.error) || t('这条消息没有可朗读的文字', 'nothing to read here'))
        }
        const units = Array.isArray(payload.value && payload.value.units) ? payload.value.units : []
        if (units.length === 0) throw new Error(t('这条消息没有可朗读的文字', 'nothing to read here'))
        session.units = units
        session.total = units.length
        session.view.total = units.length
        session.view.preview = previewOf(units[0])
        updatePlayerWindow()
        highlightAttach(session, session.root, units)
        speakSpeechQueue(session, 0, 0)
      } catch (error) {
        if (player !== session) return
        fail(stateKey, error)
      }
    }

    async function startReadAloud(sessionId, messageId, stateKey, options) {
      const selection = options && options.text ? String(options.text) : ''
      // Auto-read speaks whatever a turn produces; a step with no prose is
      // normal, so it must not surface as a failure.
      const auto = !!(options && options.auto)
      // A click carries its own button; auto-read falls back to the one the
      // action registered for that message.
      const root = (options && options.root) || actionAnchors.get(stateKey) || null
      // The bridge engine hands the text to a real browser; a desktop shell has
      // no voices of its own, so this path needs no voice list at all.
      if (engineMode === 'bridge' || (engineMode === 'browser' && usesBridge())) {
        setPlayback({ key: null, phase: 'idle', error: '' })
        // A selection read has no message id, so the text itself goes along.
        void openBridge({ sessionId, messageId, text: selection || undefined, quiet: auto, stateKey })
        return
      }
      if (engineMode === 'browser') {
        refreshSpeechVoices()
        if (!speechCapable() && isDesktopShell) {
          setPlayback({ key: null, phase: 'idle', error: '' })
          void openBridge({ sessionId, messageId, text: selection || undefined, quiet: auto, stateKey })
          return
        }
        if (!speechCapable()) {
          fail(stateKey, new Error(t('这个环境没有浏览器语音', 'no browser voices here')), auto)
          return
        }
        await startSpeechReadAloud(sessionId, messageId, stateKey, selection, root, auto)
        return
      }
      // Only the audible item is replaced: the waiting queue must survive, or
      // draining one entry would throw away the rest.
      stopCurrentOnly()
      // Must be created synchronously inside the click: the browser only lets a
      // gesture-created AudioContext produce sound.
      const context = new AudioContext({ sampleRate: SAMPLE_RATE })
      // Created on a path that may not follow a gesture (SSE-driven auto-read);
      // resume is a no-op once the page is allowed to play.
      void context.resume().catch(() => {})
      const controller = new AbortController()
      const session = {
        key: stateKey, sessionId, messageId, selection,
        context, controller, root, auto,
        units: [], unit: 0, total: 0, standalone: false,
        phase: 'loading', desiredPaused: false, gen: 0,
        chunks: [], totalSamples: 0, sources: [], last: null,
        nextTime: 0, startTime: 0, stretcher: null,
        speed, renderSpeed: speed, ended: false, pendingNext: 0, prefetch: null, req: null,
        view: { open: true, unit: 0, total: 0, phase: 'loading', speed, preview: '' },
      }
      player = session
      current = { key: stateKey, controller, context }
      playedMessages.add(stateKey)
      setPlayback({ key: stateKey, phase: 'loading', error: '' })
      updatePlayerWindow()
      try {
        const response = await fetch(PLAN_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...(sessionId && messageId ? { sessionId, messageId } : {}),
            ...(selection ? { text: selection } : {}),
          }),
          signal: controller.signal,
        })
        const payload = await response.json().catch(() => null)
        if (!response.ok || !payload || payload.ok !== true) {
          throw new Error(hostErrorText(payload) || (payload && payload.error) || t('这条消息没有可朗读的文字', 'nothing to read here'))
        }
        if (player !== session) return
        const value = payload.value || {}
        const units = Array.isArray(value.units) ? value.units : []
        if (units.length === 0) throw new Error(t('这条消息没有可朗读的文字', 'nothing to read here'))
        session.units = units
        session.total = units.length
        session.standalone = value.standalone === true
        session.view.total = units.length
        session.view.preview = previewOf(units[0])
        updatePlayerWindow()
        highlightAttach(session, session.root, units)
        await playerPlayUnit(session, 0)
      } catch (error) {
        if (player !== session) return
        if (controller.signal.aborted) return
        fail(stateKey, error)
      }
    }

    // ------------------------------------------------------- floating window
    function playerView(patch) {
      if (!player) return
      Object.assign(player.view, patch)
      updatePlayerWindow()
    }

    const PLAYER_POS_KEY = 'dsh-tts-reader:player-pos'

    function storedPlayerPos() {
      try {
        const raw = window.localStorage.getItem(PLAYER_POS_KEY)
        if (!raw) return null
        const parsed = JSON.parse(raw)
        if (parsed && Number.isFinite(parsed.left) && Number.isFinite(parsed.top)) return parsed
      } catch {}
      return null
    }

    function savePlayerPos(left, top) {
      try { window.localStorage.setItem(PLAYER_POS_KEY, JSON.stringify({ left, top })) } catch {}
    }

    function makePlayerButton(text, title) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = text
      button.title = title
      button.style.cssText = 'box-sizing:border-box;height:26px;min-width:30px;padding:0 6px;'
        + 'border:1px solid var(--dsw-alias-border-l2,#3a3a3a);border-radius:8px;background:transparent;'
        + 'color:inherit;font-size:13px;line-height:1;font-family:inherit;cursor:pointer'
      return button
    }

    function buildPlayerWindow() {
      if (playerWindowEl) return playerWindowEl
      if (typeof document === 'undefined' || !document.body) return null
      const wrap = document.createElement('div')
      try { wrap.setAttribute('popover', 'manual') } catch {}
      wrap.style.cssText = 'position:fixed;inset:auto 20px 20px auto;margin:0;padding:0;z-index:2147483645;display:none;'
        + 'border:1px solid var(--dsw-alias-border-l2,#3a3a3a);border-radius:12px;background:var(--dsw-alias-bg-layer-2,#1c1c1c);'
        + 'color:var(--dsw-alias-label-primary,#eee);box-shadow:0 10px 30px rgba(0,0,0,.4);font-size:12px;'
        + 'font-family:inherit;box-sizing:border-box;width:322px;user-select:none'
      const head = document.createElement('div')
      head.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:move;'
        + 'border-bottom:1px solid var(--dsw-alias-border-l2,#3a3a3a);touch-action:none'
      const title = document.createElement('span')
      title.style.cssText = 'flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600'
      title.textContent = t('语音朗读', 'Read aloud')
      const close = document.createElement('button')
      close.type = 'button'
      close.textContent = '×'
      close.title = t('停止朗读', 'Stop reading')
      close.style.cssText = 'padding:2px 6px;border:0;background:transparent;color:inherit;font-size:16px;line-height:1;cursor:pointer;opacity:.7'
      close.onclick = () => stopPlayback()
      head.append(title, close)

      const progressTrack = document.createElement('div')
      progressTrack.style.cssText = 'margin:6px 10px 0;height:3px;border-radius:2px;'
        + 'background:var(--dsw-alias-border-l2,#3a3a3a);overflow:hidden'
      const progressFill = document.createElement('div')
      progressFill.style.cssText = 'height:100%;width:0;background:var(--dsw-alias-state-business-primary,#3b82f6);'
        + 'transition:width .25s linear'
      progressTrack.appendChild(progressFill)
      const controls = document.createElement('div')
      controls.style.cssText = 'display:flex;align-items:center;gap:6px;padding:8px 10px'
      const prev = makePlayerButton('⏮', t('上一段', 'Previous paragraph'))
      const play = makePlayerButton('⏸', t('暂停 / 继续', 'Pause / resume'))
      const next = makePlayerButton('⏭', t('下一段', 'Next paragraph'))
      prev.onclick = () => playerStep(-1)
      next.onclick = () => playerStep(1)
      play.onclick = () => playerTogglePause()

      const speedBox = document.createElement('div')
      speedBox.style.cssText = 'display:flex;align-items:center;gap:4px;margin-left:auto'
      const speedInput = document.createElement('input')
      speedInput.type = 'range'
      speedInput.min = '0.5'
      speedInput.max = '2'
      speedInput.step = '0.05'
      speedInput.title = t('播放速度', 'Playback speed')
      // A class instead of inline accent-color: the default track is invisible on
      // a light theme, and only stylesheet rules reach the track pseudo-elements.
      speedInput.className = 'dsh-tts-range'
      speedInput.style.cssText = 'width:88px;margin:0'
      const speedValue = document.createElement('span')
      speedValue.style.cssText = 'width:38px;text-align:right;font-variant-numeric:tabular-nums'
      speedInput.oninput = () => {
        // Dragging only previews the number: re-queuing speech on every pixel
        // would stutter, and the window repaints would fight the thumb.
        speedValue.textContent = playerClampSpeed(speedInput.value).toFixed(2) + '×'
      }
      speedInput.onchange = () => {
        playerApplySpeed(playerClampSpeed(speedInput.value))
      }
      speedBox.append(speedInput, speedValue)
      controls.append(prev, play, next, speedBox)

      // Drag by the header; the position survives reloads.
      let drag = null
      head.addEventListener('pointerdown', (event) => {
        if (event.target === close) return
        const rect = wrap.getBoundingClientRect()
        drag = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top }
        try { head.setPointerCapture(event.pointerId) } catch {}
        event.preventDefault()
      })
      head.addEventListener('pointermove', (event) => {
        if (!drag) return
        const left = Math.max(8, Math.min(Math.max(8, window.innerWidth - 120), drag.left + event.clientX - drag.x))
        const top = Math.max(8, Math.min(Math.max(8, window.innerHeight - 80), drag.top + event.clientY - drag.y))
        wrap.style.left = left + 'px'
        wrap.style.top = top + 'px'
        wrap.style.right = 'auto'
        wrap.style.bottom = 'auto'
      })
      const endDrag = () => {
        if (!drag) return
        drag = null
        const rect = wrap.getBoundingClientRect()
        savePlayerPos(rect.left, rect.top)
      }
      head.addEventListener('pointerup', endDrag)
      head.addEventListener('pointercancel', endDrag)

      wrap.append(head, progressTrack, controls)
      document.body.appendChild(wrap)
      try { if (typeof wrap.showPopover === 'function') wrap.showPopover() } catch {
        try { wrap.removeAttribute('popover') } catch {}
      }
      playerWindowEl = wrap
      wrap.__parts = { wrap, title, progressFill, prev, play, next, speedInput, speedValue }
      const saved = storedPlayerPos()
      if (saved) {
        wrap.style.left = saved.left + 'px'
        wrap.style.top = saved.top + 'px'
        wrap.style.right = 'auto'
        wrap.style.bottom = 'auto'
      }
      return wrap
    }

    /**
     * How much of the reply is behind the ear. A voice that reports word
     * boundaries gives an exact character position; every other engine only
     * knows which paragraph it is reading, so the bar steps per paragraph.
     */
    function playerProgressRatio(session) {
      if (!session) return 0
      const view = session.view || {}
      const totalChars = session.totalChars || 0
      if (session.kind === 'speech' && session.boundarySeen && totalChars > 0) {
        const start = (session.charStarts && session.charStarts[session.unit]) || 0
        return Math.max(0, Math.min(1, (start + (session.skip || 0)) / totalChars))
      }
      const count = view.total || 0
      if (!count) return 0
      return Math.max(0, Math.min(1, (Math.min(view.unit, count - 1) + 1) / count))
    }

    function updatePlayerWindow() {
      const wrap = buildPlayerWindow()
      if (!wrap) return
      if (!player) {
        wrap.style.display = 'none'
        return
      }
      const parts = wrap.__parts
      const view = player.view
      // An auto-read opens before its text is known. Showing the bar for every
      // mid-turn chunk that turns out to hold only tool calls would flash it on
      // each step; it appears once there is something to read.
      if (player.auto && view.total === 0 && view.phase === 'loading') {
        wrap.style.display = 'none'
        return
      }
      wrap.style.display = 'block'
      try {
        if (typeof wrap.showPopover === 'function' && !wrap.matches(':popover-open')) wrap.showPopover()
      } catch {}
      const title = view.phase === 'paused' ? t('已暂停', 'Paused') : t('语音朗读', 'Read aloud')
      // Which voice is actually speaking, and whether it reports word positions:
      // the two things a wrong highlight has to be blamed on.
      const talker = player.kind === 'speech' ? speechLabel(player) : ''
      parts.title.textContent = talker ? title + ' · ' + talker : title
      // The bar replaces the old "3/19 · paragraph text…" line: progress, not prose.
      parts.progressFill.style.width = (playerProgressRatio(player) * 100).toFixed(2) + '%'
      parts.progressFill.parentElement.title = view.total > 1
        ? (Math.min(view.unit + 1, view.total) + '/' + view.total + (view.preview ? ' · ' + view.preview : ''))
        : (view.preview || '')
      parts.play.textContent = view.phase === 'paused' ? '▶' : '⏸'
      parts.play.title = view.phase === 'paused' ? t('继续', 'Resume') : t('暂停', 'Pause')
      parts.play.disabled = view.phase === 'loading'
      parts.prev.disabled = view.unit <= 0
      parts.next.disabled = view.unit >= view.total - 1
      const speedText = (Number(view.speed) || 1)
      // Never move the thumb out from under the pointer: while the slider has
      // focus it owns the value, and boundary-driven repaints must not snap it
      // back to the running session's speed.
      const held = typeof document !== 'undefined' && document.activeElement === parts.speedInput
      if (!held) {
        parts.speedInput.value = String(speedText)
        parts.speedValue.textContent = speedText.toFixed(2) + '×'
      }
    }

    function fail(key, error, auto) {
      if (!player || player.key !== key) return
      // Auto-read speaks a whole turn; most of its steps (thinking, tool calls)
      // carry no prose at all. Those are not failures, so they must not toast
      // and must not leave an error behind on the read button.
      const silent = auto === true || player.auto === true
      const message = (error && error.message) || String(error)
      playerStop()
      setPlayback({ key, phase: 'idle', error: silent ? '' : message })
      if (!silent) {
        // The button only keeps the text in a tooltip, which is gone as soon as
        // the pointer moves; put the failure where it can be read and copied.
        console.warn('[dsh-tts-reader] playback failed:', message)
        showFailureToast(message)
      }
      drainQueue()
    }

    // A dismissible top-layer card for playback failures. Popover keeps it above
    // modals and transforms, the same trick the request-card button uses.
    let toastEl = null
    let toastTimer = 0

    function hideFailureToast() {
      if (toastTimer) { clearTimeout(toastTimer); toastTimer = 0 }
      const node = toastEl
      toastEl = null
      if (!node) return
      try { if (node.matches && node.matches(':popover-open')) node.hidePopover() } catch {}
      try { node.remove() } catch {}
    }

    function showFailureToast(message, tone) {
      if (typeof document === 'undefined' || !document.body) return
      const ok = tone === 'ok'
      hideFailureToast()
      const node = document.createElement('div')
      try { node.setAttribute('popover', 'manual') } catch {}
      node.setAttribute('role', 'alert')
      node.style.cssText = 'position:fixed;inset:auto 16px 16px auto;margin:0;z-index:2147483646;'
        + 'max-width:min(420px,calc(100vw - 32px));padding:11px 34px 12px 13px;border-radius:10px;'
        + 'border:1px solid var(--dsw-alias-border-l2,#3a3a3a);background:var(--dsw-alias-bg-layer-2,#1c1c1c);'
        + 'color:var(--dsw-alias-label-primary,#eee);font-size:12px;line-height:1.5;'
        + 'box-shadow:0 8px 28px rgba(0,0,0,.38);font-family:inherit'
      const title = document.createElement('div')
      title.textContent = ok ? t('已交给浏览器', 'Sent to the browser') : t('朗读失败', 'Playback failed')
      title.style.cssText = 'font-weight:600;margin-bottom:4px;color:' + (ok ? '#30a46c' : '#e5484d')
      const body = document.createElement('div')
      body.textContent = String(message || '')
      body.style.cssText = 'white-space:pre-wrap;word-break:break-word;user-select:text;cursor:text'
      const close = document.createElement('button')
      close.type = 'button'
      close.textContent = '×'
      close.setAttribute('aria-label', t('关闭', 'Dismiss'))
      close.style.cssText = 'position:absolute;top:3px;right:4px;padding:2px 6px;border:0;background:transparent;'
        + 'color:inherit;font-size:16px;line-height:1;cursor:pointer;opacity:.7'
      close.onclick = hideFailureToast
      node.append(title, body, close)
      document.body.appendChild(node)
      try { if (typeof node.showPopover === 'function') node.showPopover() } catch {
        // Without the top layer the fixed position still works, but a popover
        // left unshown would stay display:none.
        try { node.removeAttribute('popover') } catch {}
      }
      toastEl = node
      toastTimer = setTimeout(hideFailureToast, ok ? 5000 : 30000)
    }

    function SpeakerIcon() {
      // Rounded speaker + two arcs, adapted from Lucide's volume-2 icon (ISC,
      // see THIRD_PARTY.md); the web client renders the same shape.
      return h('svg', {
        width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      },
        h('path', {
          d: 'M11 4.7a.7.7 0 0 0-1.2-.5L6.4 7.6A1.4 1.4 0 0 1 5.4 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.4a1.4 1.4 0 0 1 1 .4l3.4 3.4a.7.7 0 0 0 1.2-.5z',
          key: 'body',
        }),
        h('path', { d: 'M16 9a5 5 0 0 1 0 6', key: 'wave-1' }),
        h('path', { d: 'M19.4 18.4a9 9 0 0 0 0-12.8', key: 'wave-2' }),
      )
    }

    // Reading is a waveform, waiting is a spinner, paused is the pause glyph:
    // one SVG each, so every surface (message button, request card) agrees.
    function WaveIcon({ paused }) {
      return h('svg', {
        className: 'dsh-tts-wave' + (paused ? ' is-paused' : ''),
        width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': true,
        children: [0, 1, 2, 3].map((index) => h('rect', {
          key: index, x: 1.5 + index * 3.6, y: 3, width: 2, height: 10, rx: 1,
          style: { animationDelay: (index * 0.12) + 's' },
        })),
      })
    }

    function SpinnerIcon() {
      return h('svg', {
        className: 'dsh-tts-spin', width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': true,
      }, h('circle', {
        cx: 8, cy: 8, r: 5.5, fill: 'none', stroke: 'currentColor',
        strokeWidth: 2, strokeLinecap: 'round', strokeDasharray: '22 12',
      }))
    }

    function PauseIcon() {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': true },
        h('rect', { x: 4, y: 3.5, width: 2.6, height: 9, rx: 1, fill: 'currentColor' }),
        h('rect', { x: 9.4, y: 3.5, width: 2.6, height: 9, rx: 1, fill: 'currentColor' }))
    }

    function ReadingIcon({ mode }) {
      if (mode === 'loading' || mode === 'queued') return h(SpinnerIcon)
      if (mode === 'paused') return h(PauseIcon)
      return h(WaveIcon)
    }

    function SessionTracker(props) {
      const sessionId = props && props.sessionId
      const previous = React.useRef(null)
      React.useEffect(() => {
        if (!sessionId) return
        const next = String(sessionId)
        // Leaving the session must not keep speaking into the new one.
        if (previous.current !== null && previous.current !== next) {
          stopPlayback()
        }
        previous.current = next
        activeSessionId = next
      }, [sessionId])
      return null
    }

    // Floating replay button for a pending question or approval. The request
    // dialog covers the composer, so this lives on the frame-wide overlay and
    // stays clickable above it.
    function subscribePlayback(fn) {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    }

    // Replay button for a pending question or approval. It is mounted straight
    // into the request card's own header row, so it neither floats over the card
    // nor depends on either UI package; the top-layer fallback only covers a
    // native modal <dialog>, which makes everything outside it inert.
    function mountPromptButton() {
      if (typeof document === 'undefined' || !document.body) return () => {}
      // Two mount modes. Inside a request card the button is an ordinary child
      // of the card's header row (no top layer needed, no overlap). Otherwise it
      // floats in the browser top layer so a native modal <dialog> cannot cover
      // it — the popover UA stylesheet sets `inset: 0`, hence explicit sides.
      const FLOAT_STYLE = 'position:fixed;left:auto;bottom:auto;z-index:2147483647;display:none;'
        + 'margin:0;padding:0;border:0;background:transparent;overflow:visible'
      const CARD_STYLE = 'position:static;top:auto;right:auto;display:none;z-index:auto;'
        + 'margin:0 0 0 auto;padding:0;border:0;background:transparent;overflow:visible;'
        + 'align-self:center;flex:0 0 auto'
      const BUTTON_BASE = 'display:inline-flex;align-items:center;gap:6px;white-space:nowrap;'
        + 'border:1px solid var(--dsw-alias-border-l2,#3a3a3a);'
        + 'background:var(--dsw-alias-bg-layer-2,#1c1c1c);color:var(--dsw-alias-label-primary,#eee);'
        + 'font-size:12px;font-family:inherit;cursor:pointer'

      const wrap = document.createElement('div')
      try { wrap.setAttribute('popover', 'manual') } catch {}
      wrap.style.cssText = FLOAT_STYLE
      const button = document.createElement('button')
      button.type = 'button'
      button.style.cssText = BUTTON_BASE
      const styleButton = (compact) => {
        button.style.height = compact ? '24px' : '28px'
        button.style.padding = compact ? '0 8px' : '0 10px'
        button.style.borderRadius = compact ? '12px' : '14px'
        button.style.boxShadow = compact ? 'none' : '0 2px 8px rgba(0,0,0,.32)'
      }
      styleButton(false)
      const iconEl = document.createElement('span')
      iconEl.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;'
      // One glyph per state, inline SVG so the animated wave and spinner share
      // the page's own keyframes (the button lives outside React).
      const ICON = {
        speaker: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4.7a.7.7 0 0 0-1.2-.5L6.4 7.6A1.4 1.4 0 0 1 5.4 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.4a1.4 1.4 0 0 1 1 .4l3.4 3.4a.7.7 0 0 0 1.2-.5z"/></svg>',
        wave: '<svg class="dsh-tts-wave" width="14" height="14" viewBox="0 0 16 16"><rect x="1.5" y="3" width="2" height="10" rx="1"/><rect x="5.1" y="3" width="2" height="10" rx="1"/><rect x="8.7" y="3" width="2" height="10" rx="1"/><rect x="12.3" y="3" width="2" height="10" rx="1"/></svg>',
        paused: '<svg width="14" height="14" viewBox="0 0 16 16"><rect x="4" y="3.5" width="2.6" height="9" rx="1" fill="currentColor"/><rect x="9.4" y="3.5" width="2.6" height="9" rx="1" fill="currentColor"/></svg>',
        spinner: '<svg class="dsh-tts-spin" width="14" height="14" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="22 12"/></svg>',
      }
      iconEl.innerHTML = ICON.speaker
      const labelEl = document.createElement('span')
      button.appendChild(iconEl)
      button.appendChild(labelEl)
      wrap.appendChild(button)
      document.body.appendChild(wrap)
      let removed = false

      // Request surfaces are NOT native <dialog> elements: an approval or a
      // question takes over the composer seat and renders as ordinary DOM with
      // a stable data hook. Neither package exposes an extension slot inside the
      // card (approval has only the single `conversation.approval.detail` seat
      // that the command detail already owns; the question card renders none),
      // so the button is mounted as a real child of the card's header row.
      const ANCHOR_ROOTS = ['[data-approval-key]', '[data-question-key]']
      const CORNER_INSET = 10
      const BUTTON_LIFT = 32
      const EDGE_MIN = 8

      // Fixed offsets resolve against the nearest ancestor with a transform,
      // filter, perspective or contain — not the viewport. Return that box so a
      // measured card rect can be converted into the right coordinate space.
      const offsetBase = () => {
        let node = wrap.parentElement
        while (node && node !== document.documentElement && node !== document.body) {
          let style
          try { style = getComputedStyle(node) } catch { style = null }
          if (style) {
            const contain = String(style.contain || '')
            if ((style.transform && style.transform !== 'none')
              || (style.filter && style.filter !== 'none')
              || (style.perspective && style.perspective !== 'none')
              || String(style.willChange || '').includes('transform')
              || /paint|layout|strict|content/.test(contain)) {
              return node.getBoundingClientRect()
            }
          }
          node = node.parentElement
        }
        return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
      }

      const anchorRoot = () => {
        for (const selector of ANCHOR_ROOTS) {
          let root = null
          try { root = document.querySelector(selector) } catch { root = null }
          if (root && !wrap.contains(root)) return root
        }
        return null
      }

      // The visible card inside an anchor root. Takeover roots are full-width
      // centering wrappers, so the card is usually the first element child; a
      // screen-filling wrapper needs the largest child instead.
      const cardElement = (root) => {
        const rect = root.getBoundingClientRect()
        if (rect.width < 80 || rect.height < 60) return null
        const viewport = Math.max(window.innerWidth * window.innerHeight, 1)
        if (rect.width * rect.height > viewport * 0.85) {
          let best = null
          let bestArea = 0
          for (const child of root.querySelectorAll('section,div,form,article')) {
            if (wrap.contains(child)) continue
            const r = child.getBoundingClientRect()
            if (r.width < 200 || r.height < 60) continue
            if (r.width * r.height > viewport * 0.85) continue
            const area = r.width * r.height
            if (area > bestArea) { best = child; bestArea = area }
          }
          if (best) return best
        }
        const child = root.firstElementChild
        if (child && !wrap.contains(child)) {
          const r = child.getBoundingClientRect()
          if (r.width >= 200 && r.height >= 60) return child
        }
        return root
      }

      const anchorCard = () => {
        const root = anchorRoot()
        return root ? cardElement(root) : null
      }

      // The header row of a request card: question cards use <header> and end
      // with their icon buttons; approval cards lead with a status strip.
      const headerRow = (card) => {
        let header = null
        try { header = card.querySelector('header') } catch { header = null }
        if (!header) {
          const first = card.firstElementChild
          if (!first) return null
          const rect = first.getBoundingClientRect()
          if (rect.height <= 0 || rect.height > 64) return null
          header = first
        }
        // Sit left of the card's own icon cluster when there is one, so the
        // button never lands after the close control. A header whose only child
        // is that cluster appends instead.
        const last = header.lastElementChild
        if (last && last !== wrap) {
          const cluster = last.children.length > 0 && last.getBoundingClientRect().width < 160
          if (cluster && header.children.length > 1) return { row: header, before: last }
        }
        return { row: header, before: null }
      }

      const applyMode = (mode) => {
        if (mode === 'card') {
          wrap.style.cssText = CARD_STYLE
          styleButton(true)
          return
        }
        wrap.style.cssText = FLOAT_STYLE
        try { if (!wrap.hasAttribute('popover')) wrap.setAttribute('popover', 'manual') } catch {}
        styleButton(false)
      }

      // True when the button now lives inside the card's header row.
      const seatInCard = (card) => {
        const seat = headerRow(card)
        if (!seat) return false
        if (wrap.parentNode !== seat.row) {
          try { if (wrap.hasAttribute('popover')) wrap.removeAttribute('popover') } catch {}
          if (seat.before) seat.row.insertBefore(wrap, seat.before)
          else seat.row.appendChild(wrap)
          applyMode('card')
          return true
        }
        if (seat.before && wrap.nextElementSibling !== seat.before) {
          seat.row.insertBefore(wrap, seat.before)
        }
        return true
      }

      let placeFrame = 0
      const place = () => {
        placeFrame = 0
        if (removed) return
        // In-card placement is ordinary flow layout; only the floating fallback
        // needs computed coordinates.
        if (!wrap.hasAttribute('popover')) return
        const base = offsetBase()
        const card = anchorCard()
        const cardRect = card ? card.getBoundingClientRect() : null
        // Offsets are relative to `base`, which is the viewport for a plain
        // fixed element but an ancestor box when that ancestor creates a
        // containing block, so everything is measured against base.top/right.
        let top
        let right
        if (cardRect) {
          const cardTop = cardRect.top - base.top
          // Sit on the card's top edge, right-aligned; fall inside when the
          // card already touches the top of the screen.
          top = cardTop - BUTTON_LIFT
          if (top < EDGE_MIN) top = cardTop + EDGE_MIN
          right = base.right - cardRect.right + CORNER_INSET
        } else {
          top = 56
          right = CORNER_INSET + 8
        }
        const maxTop = Math.max((base.bottom - base.top) - 36, EDGE_MIN)
        top = Math.min(Math.max(top, EDGE_MIN), maxTop)
        right = Math.max(right, EDGE_MIN)
        wrap.style.top = Math.round(top) + 'px'
        wrap.style.right = Math.round(right) + 'px'
        wrap.style.left = 'auto'
        wrap.style.bottom = 'auto'
      }

      const schedulePlace = () => {
        if (placeFrame) return
        try { placeFrame = requestAnimationFrame(place) } catch { placeFrame = 0; place() }
      }

      // Request dialogs animate in, so the corner keeps moving for a moment
      // after they appear: poll the position briefly instead of trusting one
      // measurement.
      let settleTimer = 0
      const settlePlace = () => {
        try { clearInterval(settleTimer) } catch {}
        let ticks = 12
        settleTimer = setInterval(() => {
          place()
          if (--ticks <= 0) { try { clearInterval(settleTimer) } catch {} settleTimer = 0 }
        }, 50)
      }

      let sizeObserver = null
      let observedElement = null
      const watchLayout = () => {
        if (removed) return
        const target = anchorCard()
        if (target === observedElement) return
        if (sizeObserver) { try { sizeObserver.disconnect() } catch {} sizeObserver = null }
        observedElement = target
        if (!target || typeof ResizeObserver !== 'function') return
        try {
          sizeObserver = new ResizeObserver(() => schedulePlace())
          sizeObserver.observe(target)
        } catch { sizeObserver = null }
      }

      const onViewportChange = () => { watchLayout(); schedulePlace() }
      window.addEventListener('resize', onViewportChange)
      document.addEventListener('scroll', schedulePlace, true)

      let pending = null
      let lastSpoken = null
      let raisedFor = null
      let spokenFor = null

      const keyOf = (value) => 'prompt:' + (value.kind === 'approval' ? 'approval:' : '') + value.id
      const isPlaying = () => !!(current && pending && current.key === keyOf(pending))

      const raisePopover = () => {
        if (!wrap.hasAttribute('popover')) return
        try {
          if (typeof wrap.hidePopover === 'function') wrap.hidePopover()
        } catch {}
        try {
          if (typeof wrap.showPopover === 'function') wrap.showPopover()
        } catch {}
      }
      const dropPopover = () => {
        if (!wrap.hasAttribute('popover')) return
        try { if (typeof wrap.hidePopover === 'function') wrap.hidePopover() } catch {}
      }

      // Preferred mount: a real child of the request card's header row. Fallback
      // (no card, e.g. a native modal dialog): float in the top layer, and live
      // inside the dialog when one is open because it makes the rest inert.
      const adopt = () => {
        try {
          const card = anchorCard()
          if (card && seatInCard(card)) { watchLayout(); return }
        } catch {}
        try {
          applyMode('float')
          const dialog = document.querySelector('dialog[open]')
          const target = dialog || document.body
          if (wrap.parentNode !== target) target.appendChild(wrap)
          // A popover that is not open is display:none by UA rule, so entering
          // the floating mode has to reopen it.
          let open = false
          try { open = typeof wrap.matches === 'function' && wrap.matches(':popover-open') } catch { open = false }
          if (!open) raisePopover()
          settlePlace()
          watchLayout()
        } catch {}
      }

      const render = () => {
        if (removed) return
        if (!pending || !pending.text) { wrap.style.display = 'none'; dropPopover(); return }
        wrap.style.display = 'flex'
        const key = keyOf(pending)
        const remote = liveBridgeState(key)
        // The bridge (browser engine) reports its own phase; the local player
        // reports through `current`.
        const playing = isPlaying() || !!(remote && remote.phase === 'playing')
        // A queued request waits behind the audio that is already playing;
        // clicking cuts in and starts it immediately.
        const waiting = !playing && (isQueued(key) || !!(remote && remote.phase === 'queued'))
        const label = pending.kind === 'approval' ? t('朗读授权', 'Read request') : t('朗读问题', 'Read question')
        const waitingLabel = t('等待上条朗读完成', 'Waiting for the current read')
        if (waiting) {
          iconEl.innerHTML = ICON.spinner
          labelEl.textContent = waitingLabel
          button.title = t('正在朗读上一条，点击可切断并立即朗读这一条', 'Reading the previous item — click to cut in and read this now')
        } else {
          iconEl.innerHTML = playing
            ? (remote && remote.phase === 'paused' ? ICON.paused : ICON.wave)
            : ICON.speaker
          labelEl.textContent = playing ? t('停止', 'Stop') : label
          button.title = playing ? t('点击停止', 'Click to stop') : label
        }
        schedulePlace()
      }

      const tick = () => {
        fetch(PENDING_PATH, { headers: { accept: 'application/json' } })
          .then((res) => res.json())
          .then((body) => {
            if (removed || !body || !body.ok) return
            pending = body.value || null
            // The request is over once it leaves /pending: an answered approval
            // or question must not keep talking.
            const nextKey = pending && pending.text ? keyOf(pending) : null
            if (spokenFor !== null && spokenFor !== nextKey) {
              if (current && current.key === spokenFor) stopCurrentOnly()
              dropQueued(spokenFor)
            }
            spokenFor = nextKey
            adopt()
            // The takeover card can mount a beat after the request exists, so
            // re-resolve the anchor on every poll.
            watchLayout()
            if (pending && pending.text) {
              // Re-raise on every new request: the dialog may have opened since.
              if (pending.id !== raisedFor) { raisePopover(); raisedFor = pending.id; settlePlace() }
              if (pending.id !== lastSpoken) {
                const enabled = pending.kind === 'approval' ? speakApprovals : speakQuestions
                if (enabled) {
                  lastSpoken = pending.id
                  // Queues behind the audio already playing; the button cuts in.
                  autoReadPrompt(keyOf(pending), pending.text)
                }
              }
            } else {
              raisedFor = null
            }
            render()
          })
          .catch(() => {})
      }

      button.addEventListener('click', () => {
        if (!pending) return
        const key = keyOf(pending)
        // Waiting state: cut the current audio and speak this request now.
        if (isQueued(key)) {
          speakNow(key, () => { void startReadAloud(null, null, key, { text: pending.text }) })
          return
        }
        if (isPlaying()) { stopPlayback(); render(); return }
        speakNow(key, () => { void startReadAloud(null, null, key, { text: pending.text }) })
        setTimeout(render, 60)
      })

      const timer = setInterval(tick, 2000)
      const off = subscribePlayback(render)
      // The button lives outside React, so it subscribes to language changes
      // itself.
      const localeListener = () => render()
      localeListeners.push(localeListener)
      tick()
      return () => {
        removed = true
        clearInterval(timer)
        localeListeners = localeListeners.filter(entry => entry !== localeListener)
        try { clearInterval(settleTimer) } catch {}
        if (placeFrame) { try { cancelAnimationFrame(placeFrame) } catch {} placeFrame = 0 }
        if (sizeObserver) { try { sizeObserver.disconnect() } catch {} sizeObserver = null }
        try { window.removeEventListener('resize', onViewportChange) } catch {}
        try { document.removeEventListener('scroll', schedulePlace, true) } catch {}
        try { off() } catch {}
        try { wrap.remove() } catch {}
      }
    }

    function ReadAloudAction(props) {
      const messageId = props && props.messageId
      const sessionId = props && props.sessionId
      const key = String(sessionId) + ':' + String(messageId)
      const state = usePlayback()
      const selectionRef = React.useRef('')
      const anchorRef = React.useRef(null)
      useLocaleTick()
      React.useEffect(() => {
        if (sessionId) activeSessionId = String(sessionId)
      }, [sessionId])
      React.useEffect(() => {
        if (anchorRef.current) actionAnchors.set(key, anchorRef.current)
        return () => { actionAnchors.delete(key) }
      }, [key])
      const mine = state.key === key
      const localPhase = mine ? state.phase : 'idle'
      const error = mine ? state.error : ''
      const cached = playedMessages.has(key)
      // The bridge reads in a separate browser; its live state decides the icon
      // here. Finished reads just go back to the plain speaker.
      const remote = liveBridgeState(key)
      const phase = remote ? remote.phase : localPhase

      const title = error
        ? error
        : phase === 'loading' || phase === 'queued'
          ? t('正在合成…', 'Synthesizing…')
          : phase === 'playing'
            ? t('点击停止（悬浮窗可暂停、前后翻段）', 'Click to stop (the floating window pauses and steps)')
            : phase === 'paused'
              ? t('已暂停；点悬浮窗继续', 'Paused — resume from the floating window')
              : cached
                ? t('再次播放（本地缓存）', 'Play again (cached)')
                : t('朗读这条回复（选中文字则读它所在的整段）', 'Read this reply aloud (the paragraphs around the selection)')

      return h('button', {
        type: 'button',
        ref: anchorRef,
        title,
        'aria-label': title,
        // Capture the selection before mousedown clears it.
        onMouseDown: () => {
          try { selectionRef.current = String(window.getSelection() || '').trim() } catch { selectionRef.current = '' }
        },
        onClick: (event) => {
          if (phase === 'loading' || phase === 'playing' || phase === 'paused') { stopPlayback(); return }
          const selected = selectionRef.current.slice(0, 4000)
          // The button is the only handle on the rendered message; the highlight
          // walks up from it once the plan has the paragraph texts.
          const root = event && event.currentTarget ? event.currentTarget : null
          // A manual read is a deliberate override: it drops the queue.
          speakNow(key, () => {
            void startReadAloud(sessionId, messageId, key, Object.assign({ root }, selected ? { text: selected } : {}))
          })
        },
        style: {
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          height: '24px', minWidth: '22px', padding: '0 3px', border: 'none',
          background: 'transparent', cursor: 'pointer', borderRadius: '4px',
          color: error ? '#e5484d' : 'var(--dsw-alias-label-secondary)',
          opacity: phase === 'idle' && !cached ? 0.9 : 1,
        },
        children: [
          phase === 'idle' ? h(SpeakerIcon, { key: 'icon' }) : h(ReadingIcon, { mode: phase, key: 'bars' }),
          error ? h('span', { key: 'mark' }, '!') : null,
          finished && !error ? h('span', {
            key: 'done',
            style: { color: '#30a46c', fontSize: '10px', lineHeight: 1, marginLeft: '1px' },
          }, '✓') : null,
        ],
      })
    }

    // Numeric settings commit on Enter or blur, never per keystroke: typing
    // "512" used to send three saves (5, 51, 512), each of which reset the
    // client cache and refetched the config.
    function NumberInput(props) {
      const value = props && props.value
      const min = props && typeof props.min === 'number' ? props.min : 0
      const max = props && typeof props.max === 'number' ? props.max : 999999
      const onCommit = props && props.onCommit
      const [draft, setDraft] = React.useState(null)

      const commit = () => {
        const raw = draft
        setDraft(null)
        if (raw === null || String(raw).trim() === '') return
        const parsed = Number(String(raw).trim())
        if (!Number.isFinite(parsed)) return
        const next = Math.min(max, Math.max(min, Math.floor(parsed)))
        if (next === value || typeof onCommit !== 'function') return
        onCommit(next)
      }

      return h('input', {
        className: props.className,
        type: 'number', min: min, max: max, step: props.step, disabled: props.disabled,
        value: draft === null ? (value === undefined || value === null ? '' : value) : draft,
        onChange: (event) => setDraft(event.target.value),
        onBlur: commit,
        onKeyDown: (event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
            try { event.currentTarget.blur() } catch {}
          } else if (event.key === 'Escape') {
            setDraft(null)
            try { event.currentTarget.blur() } catch {}
          }
        },
      })
    }

    // Text fields commit on Enter or blur, like the numeric ones: typing a path
    // must not POST the settings file on every keystroke.
    function TextInput(props) {
      const value = props && typeof props.value === 'string' ? props.value : ''
      const onCommit = props && props.onCommit
      const [draft, setDraft] = React.useState(null)

      const commit = () => {
        const raw = draft
        setDraft(null)
        if (raw === null) return
        const next = String(raw).trim()
        if (next === value || typeof onCommit !== 'function') return
        onCommit(next)
      }

      return h('input', {
        className: props.className,
        type: props.type === 'password' ? 'password' : 'text',
        placeholder: props.placeholder,
        spellCheck: false,
        disabled: props.disabled,
        value: draft === null ? value : draft,
        onChange: (event) => setDraft(event.target.value),
        onBlur: commit,
        onKeyDown: (event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
            try { event.currentTarget.blur() } catch {}
          } else if (event.key === 'Escape') {
            setDraft(null)
            try { event.currentTarget.blur() } catch {}
          }
        },
      })
    }

    // Multi-line companion to TextInput for JSON headers/bodies. It commits on
    // blur only: Enter has to stay available for newlines.
    function TextAreaInput(props) {
      const value = typeof props.value === 'string' ? props.value : ''
      const onCommit = props.onCommit
      const [draft, setDraft] = React.useState(null)

      const commit = () => {
        const raw = draft
        setDraft(null)
        if (raw === null) return
        const next = String(raw).trim()
        if (next === value || typeof onCommit !== 'function') return
        onCommit(next)
      }

      return h('textarea', {
        className: props.className,
        rows: props.rows || 3,
        placeholder: props.placeholder,
        spellCheck: false,
        disabled: props.disabled,
        value: draft === null ? value : draft,
        onChange: (event) => setDraft(event.target.value),
        onBlur: commit,
        onKeyDown: (event) => {
          if (event.key === 'Escape') {
            setDraft(null)
            try { event.currentTarget.blur() } catch {}
          }
        },
      })
    }

    // Offline installation guide. A native <dialog> keeps it in the browser top
    // layer, so the settings pane's own scroll box cannot clip it, and Escape or
    // a backdrop click close it without extra listeners.
    function InstallGuide(props) {
      const open = props && props.open === true
      const onClose = props && typeof props.onClose === 'function' ? props.onClose : () => {}
      const ref = React.useRef(null)

      React.useEffect(() => {
        const node = ref.current
        if (!node) return
        if (open) {
          try { if (!node.open && typeof node.showModal === 'function') node.showModal() } catch {}
        } else {
          try { if (node.open) node.close() } catch {}
        }
      }, [open])

      if (!open) return null

      const link = (key, href, text) => h('a', { key, href, target: '_blank', rel: 'noreferrer noopener' }, text)

      return h('dialog', {
        ref,
        className: 'dsh-tts-dialog',
        onClose,
        // A backdrop click lands on the <dialog> element itself.
        onClick: (event) => { if (event.target === event.currentTarget) onClose() },
      },
        h('div', { className: 'dsh-tts-dialog-head', key: 'head' },
          h('span', { className: 'dsh-tts-dialog-title', key: 'title' }, t('离线安装 Piper', 'Install Piper offline')),
          h('button', { key: 'close', className: 'dsh-tts-close', type: 'button', 'aria-label': t('关闭', 'Close'), onClick: onClose }, '×'),
        ),
        h('div', { className: 'dsh-tts-dialog-body', key: 'body' },
          h('div', { key: 'intro' }, t(
            '插件只负责朗读，不含 Piper 程序和语音模型。装好一次之后，合成完全离线、不花钱。',
            'This plugin only plays audio; the Piper program and voice models are not bundled. Set them up once and synthesis stays offline and free.')),
          h('ol', { key: 'steps' },
            h('li', { key: 's1' }, t(
              '准备程序：取一个 piper 可执行文件。只用「花颜」的话，2023 版自包含包即可（约 37 MB，解压即用）；要用「超文 / 小雅」得装 Python 3.9–3.12 的 pip 版：pip install "piper-tts[zh]"。',
              'Program: get a piper executable. For Huayan alone the 2023 self-contained build is enough (about 37 MB, unzip and run); Chaowen / Xiao_ya need the pip build on Python 3.9–3.12: pip install "piper-tts[zh]".')),
            h('li', { key: 's2' }, t(
              '准备音色：一个音色是「.onnx + 同名 .json」两个文件，放进同一个目录（各约 60 MB）。超文 / 小雅 还要求该目录下有 g2pW/（约 260 MB）和 BERT 分词器（约 0.1 MB）。',
              'Voice: a voice is an .onnx plus its same-named .json in one folder (about 60 MB each). Chaowen / Xiao_ya also need g2pW/ (about 260 MB) and the BERT tokenizer (about 0.1 MB) in that folder.')),
            h('li', { key: 's3' }, t(
              '填路径：回到上方，引擎选「本地 Piper」，填好「程序」与「音色模型」，状态变成「已就绪」就能离线朗读。',
              'Fill it in: pick "Local Piper" above, set the program and voice model paths; once the status reads ready, the speaker button works offline.')),
          ),
          h('div', { className: 'dsh-tts-kv', key: 'size' }, t(
            '占用参考：花颜 ≈ 97 MB（程序 37 + 模型 60）；超文 / 小雅 ≈ 660 MB（再加 g2pW 与分词器）。',
            'Disk: Huayan ≈ 97 MB (37 program + 60 model); Chaowen / Xiao_ya ≈ 660 MB including g2pW and the tokenizer.')),
          h('div', { className: 'dsh-tts-dialog-foot', key: 'links' },
            t('程序：', 'Program: '), link('piper', 'https://github.com/OHF-Voice/piper1-gpl', 'piper1-gpl'),
            t('，旧版也能用：', '; the older build works too: '), link('rhasspy', 'https://github.com/rhasspy/piper', 'rhasspy/piper'),
            h('br', { key: 'br' }),
            t('模型：', 'Voices: '), link('voices', 'https://huggingface.co/rhasspy/piper-voices', 'rhasspy/piper-voices'),
            t('，国内可用镜像 HF_ENDPOINT=https://hf-mirror.com。', '; from mainland China use the HF_ENDPOINT=https://hf-mirror.com mirror.'),
          ),
          h('div', { className: 'dsh-tts-dialog-foot', key: 'legal' }, t(
            'Piper 与 espeak-ng 是 GPL-3.0，语音模型各自另有限制条款；本插件不分发这些文件。',
            'Piper and espeak-ng are GPL-3.0 and each voice model has its own terms; this plugin does not redistribute them.')),
        ),
      )
    }

    function TtsSettings() {
      const [config, setConfig] = React.useState(null)
      const [notice, setNotice] = React.useState('')
      const [failure, setFailure] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      // The speed slider previews while dragging and only saves on release, so
      // one drag is one write instead of dozens.
      const [speedDraft, setSpeedDraft] = React.useState(null)
      const [guideOpen, setGuideOpen] = React.useState(false)
      const [previewState, setPreviewState] = React.useState(previewPhase)
      // Browser voices arrive asynchronously (voiceschanged); re-render when they do.
      const [voices, setVoices] = React.useState(() => refreshSpeechVoices().slice())
      useLocaleTick()

      React.useEffect(() => {
        const sync = () => setVoices(refreshSpeechVoices().slice())
        sync()
        const synth = speechSynth()
        if (!synth) return
        const timer = setTimeout(sync, 900)
        try { synth.addEventListener('voiceschanged', sync) } catch {}
        return () => {
          clearTimeout(timer)
          try { synth.removeEventListener('voiceschanged', sync) } catch {}
        }
      }, [])

      const load = React.useCallback(() => {
        fetch(CONFIG_PATH, { headers: { accept: 'application/json' } })
          .then((res) => res.json())
          .then((body) => { if (body && body.ok) { setConfig(body.value); applyRemoteConfig(body.value) } })
          .catch(() => {})
      }, [])

      React.useEffect(() => { load() }, [load])
      // The preview button follows the module-level player, and leaving the page
      // stops a sample that is still playing.
      React.useEffect(() => subscribePreview(setPreviewState), [])
      React.useEffect(() => () => { stopPreview() }, [])

      const save = async (patch) => {
        setBusy(true); setNotice(''); setFailure('')
        try {
          const response = await fetch(CONFIG_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch),
          })
          const body = await response.json()
          if (!body || body.ok !== true) throw new Error((body && body.error) || t('保存失败', 'Save failed'))
          setConfig(body.value)
          applyRemoteConfig(body.value)
          playedMessages.clear()
          setNotice(t('已保存', 'Saved'))
          // The sample was rendered by the previous settings; do not keep playing.
          stopPreview()
        } catch (error) {
          setFailure(error && error.message ? error.message : String(error))
        } finally {
          setBusy(false)
        }
      }

      const MIN_CACHE_MB = 50
      const MAX_CACHE_MB = 4096

      // One-time move: an old "browser + bridge voice" setup becomes the bridge
      // engine, since the bridge is no longer a voice in that list.
      const migrated = React.useRef(false)
      React.useEffect(() => {
        if (!config || migrated.current || busy) return
        if (!needsBridgeMigration()) return
        migrated.current = true
        void save({ engine: 'bridge' })
      }, [config, busy])

      const commitSpeed = () => {
        const raw = speedDraft
        setSpeedDraft(null)
        if (raw === null) return
        const parsed = Number(raw)
        if (!Number.isFinite(parsed)) return
        const next = Math.round(Math.min(2, Math.max(0.5, parsed)) * 100) / 100
        if (config && next === config.speed) return
        void save({ speed: next })
      }

      if (!config) return h('div', { style: { padding: '4px 0', fontSize: '13px', color: 'var(--dsw-alias-label-secondary)' } }, t('加载中…', 'Loading…'))

      const cacheMb = (config.cache && config.cache.bytes ? config.cache.bytes / 1048576 : 0).toFixed(1)
      const cacheLimit = config.cacheMaxMb || 200
      const cachePct = Math.min(100, Math.round(((config.cache && config.cache.bytes ? config.cache.bytes : 0) / (cacheLimit * 1048576)) * 100))
      // Where the synthesized audio lives: the cache folder, or RAM only.
      const cacheMode = config.cacheMode === 'memory' ? 'memory' : 'disk'
      const memCache = (config.cache && config.cache.memory) || { files: 0, bytes: 0, limitBytes: 134217728 }
      const memMb = (memCache.bytes / 1048576).toFixed(1)
      const memLimitMb = ((memCache.limitBytes || 134217728) / 1048576).toFixed(0)
      const memPct = Math.min(100, Math.round((memCache.bytes / (memCache.limitBytes || 134217728)) * 100))
      const piper = config.piper || { exe: false, model: false, modelEn: false, sampleRate: 0, voices: [] }
      const localVoices = Array.isArray(piper.voices) ? piper.voices : []
      const system = config.system || { supported: false, voices: [] }
      const systemVoices = Array.isArray(system.voices) ? system.voices : []
      const custom = config.custom || {
        protocol: 'openai', baseUrl: '', endpoint: '', effectiveUrl: '', requiresKey: true,
        model: '', voice: '', format: 'wav', keyConfigured: false, ready: false,
      }
      const protocol = custom.protocol === 'gpt-sovits' || custom.protocol === 'fish' || custom.protocol === 'template'
        ? custom.protocol
        : 'openai'
      const engine = config.engine || 'deepseek'
      // Piper is no longer offered (browser speech replaces it); the Host also
      // downgrades a saved `piper` value, so this stays false on purpose.
      const localEngine = false
      const cloudEngine = engine === 'deepseek'
      const browserEngine = engine === 'browser'
      const bridgeEngine = engine === 'bridge'
      const systemEngine = engine === 'system'
      const customEngine = engine === 'custom'
      const systemReady = system.supported === true && systemVoices.length > 0
      const customReady = custom.ready === true
      const browserReady = voices.length > 0
      const bridgeReady = isDesktopShell
      const engineReady = bridgeEngine ? bridgeReady
        : cloudEngine ? config.keyConfigured === true
        // A desktop shell can always hand the text to a browser, voices or not.
        : browserEngine ? (browserReady || isDesktopShell)
          : systemEngine ? systemReady
            : customReady
      const engineHint = bridgeEngine
        ? t('交给默认浏览器朗读：不用 Key、不落盘；那个页面跟随 DSH 的主题与语言。',
          'Reads in your default browser through the bridge page: no key, nothing cached; it follows the app theme and language.')
        : cloudEngine
          ? t('DeepSeek 官方 TTS：在线合成按量计费，用你自己的 API 余额；需要 Key 和网络。',
            'The official DeepSeek TTS API: billed per use against your own balance; needs a key and network.')
          : browserEngine
            ? t('用浏览器自带的语音朗读：不用 Key、不落盘、不走 Host；语速就是语音引擎自身的语速。',
              'The browser speaks the paragraphs itself: no key, nothing cached, no Host round-trip; speed is the engine rate.')
            : systemEngine
              ? t('操作系统自带的语音，离线、零下载；中英混读正常，但音色偏机械。',
                'Voices that ship with the operating system: offline, no download, fine at mixed Chinese/English, but synthetic.')
              : t('任何 OpenAI 兼容的 /v1/audio/speech 端点；在线服务按量计费、消耗你账户的余额，本机服务免费。Key 只存本机，不回传给页面。',
                'Any OpenAI-compatible /v1/audio/speech endpoint: hosted services bill your own account, local ones are free. The key stays on this machine and is never sent back to the page.')
      const engineStatus = engineReady
        ? t('已就绪', 'ready')
        : cloudEngine ? t('需配置 Key', 'key missing')
          : bridgeEngine ? t('需要桌面端', 'desktop only')
            : browserEngine ? t('这个环境没有浏览器语音', 'no browser voices')
              : systemEngine ? (system.supported ? t('没有语音', 'no voices') : t('系统不支持', 'unsupported'))
                : t('需要配置', 'needs setup')

      // One card head: title, optional right-hand status, one explanatory line.
      const head = (key, title, hint, extra) => h('div', { className: 'dsh-tts-head', key },
        h('div', { className: 'dsh-tts-headrow', key: 'title' },
          h('span', { className: 'dsh-tts-h1', key: 'h' }, title),
          extra || null),
        hint ? h('div', { className: 'dsh-tts-hint', key: 'hint' }, hint) : null,
      )

      // Two columns only: a fixed label gutter and one control column that every
      // control fills, so selects, inputs and buttons share the same edges.
      const row = (key, label, control) => h('div', { className: 'dsh-tts-row', key },
        h('span', { className: 'dsh-tts-label', key: 'label' }, label),
        h('span', { className: 'dsh-tts-grow', key: 'control' }, control),
      )

      const badge = (key, ok, text) => h('span', { className: 'dsh-tts-badge ' + (ok ? 'ok' : 'warn'), key }, text)

      // GPT-SoVITS accepts the same language set for text and prompt.
      const langOptions = () => [
        h('option', { value: 'zh', key: 'zh' }, t('中文', 'Chinese')),
        h('option', { value: 'en', key: 'en' }, 'English'),
        h('option', { value: 'ja', key: 'ja' }, t('日语', 'Japanese')),
        h('option', { value: 'ko', key: 'ko' }, t('韩语', 'Korean')),
        h('option', { value: 'yue', key: 'yue' }, t('粤语', 'Cantonese')),
        h('option', { value: 'auto', key: 'auto' }, t('自动', 'Auto')),
      ]

      const check = (key, field, text, hint, checked) => h('label', { className: 'dsh-tts-check', key },
        h('input', {
          type: 'checkbox', checked: checked, disabled: busy,
          onChange: (event) => save({ [field]: event.target.checked }),
        }),
        h('span', { className: 'dsh-tts-check-text' }, text),
        hint ? h('span', { className: 'dsh-tts-hint' }, hint) : null,
      )

      return h('div', { className: 'dsh-tts-settings' },
        h('div', { className: 'dsh-tts-card', key: 'engine' },
          // The setting comes first: the hint and the readiness badge describe
          // whatever the select is set to, so they read after it.
          h('div', { className: 'dsh-tts-head', key: 'head' },
            h('div', { className: 'dsh-tts-headrow', key: 'title' },
              h('span', { className: 'dsh-tts-h1', key: 'h' }, t('合成引擎', 'Engine')))),
          row('engine', t('引擎', 'Engine'),
            h('select', {
              className: 'dsh-tts-select', value: engine, disabled: busy,
              onChange: (event) => save({ engine: event.target.value }),
              children: [
                h('option', { value: 'deepseek', key: 'deepseek' }, t('DeepSeek 云（在线）', 'DeepSeek cloud (online)')),
                isDesktopShell ? h('option', { value: 'bridge', key: 'bridge' },
                  t('朗读桥（在浏览器中朗读）', 'Speech bridge (read in a browser)')) : null,
                h('option', { value: 'browser', key: 'browser', disabled: !browserReady && !isDesktopShell },
                  browserReady
                    ? t('浏览器朗读（本机 ' + voices.length + ' 个语音）', 'Browser speech (' + voices.length + ' voices)')
                    : isDesktopShell
                      ? t('浏览器朗读（交给浏览器）', 'Browser speech (hand off to a browser)')
                      : t('浏览器朗读（这个环境没有语音）', 'Browser speech (no voices here)')),
                h('option', { value: 'system', key: 'system' }, t('系统语音（离线）', 'System voices (offline)')),
                h('option', { value: 'custom', key: 'custom' }, t('自定义 API（在线）', 'Custom API (online)')),
              ].filter(Boolean),
            }),
          ),
          h('div', { className: 'dsh-tts-hint', key: 'hint' }, engineHint),
          h('div', { className: 'dsh-tts-headrow', key: 'status' }, badge('status', engineReady, engineStatus)),
          browserEngine ? row('speech-voice', t('语音', 'Voice'), (voices.length > 0 || isDesktopShell)
            ? h('select', {
                className: 'dsh-tts-select',
                value: speechTargetValue(),
                disabled: busy,
                onChange: (event) => { rememberSpeechVoice(event.target.value); setVoices(refreshSpeechVoices().slice()) },
                children: voices.map((voice) => h('option', {
                  value: voice.voiceURI, key: voice.voiceURI,
                }, (isCloudVoice(voice) ? '☁ ' : '⌂ ') + voice.name + ' · ' + voice.lang)),
              })
            : badge('state', false, t('这个环境没有浏览器语音', 'no browser voices here'))) : null,
          cloudEngine ? row('voice', t('音色', 'Voice'),
            h('select', {
              className: 'dsh-tts-select', value: config.voice, disabled: busy,
              onChange: (event) => save({ voice: event.target.value }),
              children: [
                h('option', { value: 'stella', key: 'stella' }, 'stella · ' + t('女声', 'female')),
                h('option', { value: 'tide', key: 'tide' }, 'tide · ' + t('男声', 'male')),
              ],
            }),
          ) : null,
          cloudEngine ? row('key', 'API Key',
            badge('state', config.keyConfigured === true, config.keyConfigured
              ? t('已配置（DEEPSEEK_API_KEY）', 'Configured · DEEPSEEK_API_KEY')
              : t('未配置，请到 设置 → 模型 填 Key', 'Not configured — set a key in Settings → Models')),
          ) : null,
          systemEngine ? row('system-voice', t('语音', 'Voice'), systemVoices.length > 0
            ? h('select', {
                className: 'dsh-tts-select', value: config.systemVoice || (systemVoices[0] && systemVoices[0].id) || '', disabled: busy,
                onChange: (event) => save({ systemVoice: event.target.value }),
                children: systemVoices.map((voice) => h('option', { value: voice.id, key: voice.id },
                  voice.name
                  + (voice.language ? ' · ' + voice.language : '')
                  + (voice.gender ? ' · ' + voice.gender : ''))),
              })
            : badge('state', false, system.supported
              ? t('没有可用的系统语音', 'no system voices installed')
              : t('当前系统不支持系统语音', 'not supported on this OS'))) : null,
          customEngine ? row('custom-protocol', t('协议', 'Protocol'),
            h('select', {
              className: 'dsh-tts-select', value: protocol, disabled: busy,
              onChange: (event) => save({ customProtocol: event.target.value }),
              children: [
                h('option', { value: 'openai', key: 'openai' }, t('OpenAI 兼容 /v1/audio/speech', 'OpenAI-compatible /v1/audio/speech')),
                h('option', { value: 'gpt-sovits', key: 'gpt-sovits' }, t('GPT-SoVITS（api_v2 /tts）', 'GPT-SoVITS (api_v2 /tts)')),
                h('option', { value: 'fish', key: 'fish' }, t('Fish Audio（/v1/tts）', 'Fish Audio (/v1/tts)')),
                h('option', { value: 'template', key: 'template' }, t('自定义请求模板', 'Custom request template')),
              ],
            })) : null,
          customEngine ? row('custom-url', 'Base URL', [
            h(TextInput, {
              key: 'input',
              className: 'dsh-tts-input wide', value: config.customBaseUrl, disabled: busy,
              placeholder: protocol === 'gpt-sovits' ? 'http://127.0.0.1:9880'
                : protocol === 'fish' ? 'https://api.fish.audio'
                  : protocol === 'template' ? 'http://127.0.0.1:8080'
                    : 'https://api.openai.com/v1',
              onCommit: (value) => void save({ customBaseUrl: value }),
            }),
            custom.effectiveUrl
              ? badge('state', true, custom.requiresKey
                ? t('需要 Key', 'key required')
                : t('本机服务，免 Key', 'local, no key'))
              : (config.customBaseUrl
                ? badge('state', false, t('地址无效', 'invalid URL'))
                : null),
          ]) : null,
          customEngine && protocol === 'gpt-sovits' ? row('sovits-ref', t('参考音频', 'Reference audio'), [
            h(TextInput, {
              key: 'input',
              className: 'dsh-tts-input wide', value: config.sovitsRefAudio, disabled: busy,
              placeholder: 'C:\\voices\\ref.wav（服务端本机路径）',
              onCommit: (value) => void save({ sovitsRefAudio: value }),
            }),
            config.sovitsRefAudio ? null : badge('state', false, t('必填', 'required')),
          ]) : null,
          customEngine && protocol === 'gpt-sovits' ? row('sovits-prompt', t('参考文本', 'Reference text'),
            h(TextInput, {
              className: 'dsh-tts-input wide', value: config.sovitsPromptText, disabled: busy,
              placeholder: t('参考音频里说的话（可留空）', 'what the reference audio says (optional)'),
              onCommit: (value) => void save({ sovitsPromptText: value }),
            })) : null,
          customEngine && protocol === 'gpt-sovits' ? row('sovits-text-lang', t('文本语言', 'Text language'),
            h('select', {
              className: 'dsh-tts-select', value: custom.lang || 'zh', disabled: busy,
              onChange: (event) => save({ sovitsTextLang: event.target.value }),
              children: langOptions(),
            })) : null,
          customEngine && protocol === 'gpt-sovits' ? row('sovits-prompt-lang', t('参考语言', 'Prompt language'),
            h('select', {
              className: 'dsh-tts-select', value: custom.promptLang || 'zh', disabled: busy,
              onChange: (event) => save({ sovitsPromptLang: event.target.value }),
              children: langOptions(),
            })) : null,
          customEngine && protocol === 'openai' ? row('custom-model', t('模型', 'Model'),
            h(TextInput, {
              className: 'dsh-tts-input wide', value: config.customModel, disabled: busy,
              placeholder: 'tts-1',
              onCommit: (value) => void save({ customModel: value }),
            })) : null,
          customEngine && protocol === 'openai' ? row('custom-voice', t('音色', 'Voice'),
            h(TextInput, {
              className: 'dsh-tts-input wide', value: config.customVoice, disabled: busy,
              placeholder: 'alloy',
              onCommit: (value) => void save({ customVoice: value }),
            })) : null,
          customEngine && protocol === 'openai' ? row('custom-format', t('返回格式', 'Format'),
            h('select', {
              className: 'dsh-tts-select', value: config.customFormat === 'pcm' ? 'pcm' : 'wav', disabled: busy,
              onChange: (event) => save({ customFormat: event.target.value }),
              children: [
                h('option', { value: 'wav', key: 'wav' }, t('wav（推荐）', 'wav (recommended)')),
                h('option', { value: 'pcm', key: 'pcm' }, t('pcm（24 kHz 裸流）', 'pcm (24 kHz raw)')),
              ],
            })) : null,
          customEngine && protocol === 'fish' ? row('fish-model', t('模型', 'Model'),
            h(TextInput, {
              className: 'dsh-tts-input wide', value: config.customModel, disabled: busy,
              placeholder: 's2-pro',
              onCommit: (value) => void save({ customModel: value }),
            })) : null,
          customEngine && protocol === 'fish' ? row('fish-voice', t('参考音色 ID', 'Reference voice id'),
            h(TextInput, {
              className: 'dsh-tts-input wide', value: config.customVoice, disabled: busy,
              placeholder: 'reference_id',
              onCommit: (value) => void save({ customVoice: value }),
            })) : null,
          customEngine && protocol === 'template' ? row('tpl-method', t('方法', 'Method'),
            h('select', {
              className: 'dsh-tts-select', value: config.customMethod === 'GET' ? 'GET' : 'POST', disabled: busy,
              onChange: (event) => save({ customMethod: event.target.value }),
              children: [
                h('option', { value: 'POST', key: 'POST' }, 'POST'),
                h('option', { value: 'GET', key: 'GET' }, 'GET'),
              ],
            })) : null,
          customEngine && protocol === 'template' ? row('tpl-path', t('路径', 'Path'),
            h(TextInput, {
              className: 'dsh-tts-input wide', value: config.customPath, disabled: busy,
              placeholder: '/tts',
              onCommit: (value) => void save({ customPath: value }),
            })) : null,
          customEngine && protocol === 'template' ? row('tpl-headers', t('请求头', 'Headers'),
            h(TextAreaInput, {
              className: 'dsh-tts-area', rows: 2, value: config.customHeaders, disabled: busy,
              placeholder: '{"x-api-key": "..."}',
              onCommit: (value) => void save({ customHeaders: value }),
            })) : null,
          customEngine && protocol === 'template' ? row('tpl-body', t('请求体模板', 'Body template'),
            h(TextAreaInput, {
              className: 'dsh-tts-area', rows: 3, value: config.customBody, disabled: busy,
              placeholder: '{"text": "{{text}}", "voice": "{{voice}}"}',
              onCommit: (value) => void save({ customBody: value }),
            })) : null,
          customEngine && protocol === 'template' ? row('tpl-audio', t('音频类型', 'Audio type'),
            h('select', {
              className: 'dsh-tts-select', value: config.customAudioType || 'auto', disabled: busy,
              onChange: (event) => save({ customAudioType: event.target.value }),
              children: [
                h('option', { value: 'auto', key: 'auto' }, t('自动识别（先嗅探 WAV）', 'auto (sniff WAV)')),
                h('option', { value: 'wav', key: 'wav' }, 'WAV'),
                h('option', { value: 'pcm', key: 'pcm' }, t('PCM（24 kHz 裸流）', 'PCM (24 kHz raw)')),
              ],
            })) : null,
          customEngine && (custom.requiresKey !== false || custom.keyConfigured) ? row('custom-key', 'API Key', [
            h(TextInput, {
              key: 'input',
              type: 'password',
              className: 'dsh-tts-input wide', value: '', disabled: busy,
              placeholder: custom.keyConfigured
                ? t('已配置，留空不改', 'configured — leave empty to keep')
                : 'sk-...',
              onCommit: (value) => void save({ customApiKey: value }),
            }),
            custom.keyConfigured
              ? h('button', {
                  key: 'clear', className: 'dsh-tts-btn', type: 'button', disabled: busy,
                  onClick: () => void save({ customApiKey: '' }),
                  children: t('清除', 'Clear'),
                })
              : null,
            badge('state', custom.keyConfigured === true, custom.keyConfigured ? t('已配置', 'configured') : t('未配置', 'missing')),
          ]) : null,
          row('preview', t('试听', 'Preview'), [
            h('button', {
              key: 'btn', className: 'dsh-tts-btn', type: 'button', disabled: busy,
              onClick: () => { if (previewState === 'idle') void playPreview(); else stopPreview() },
              children: previewState === 'loading'
                ? t('停止（正在合成）', 'Stop (synthesizing)')
                : previewState === 'playing'
                  ? t('停止试听', 'Stop preview')
                  : t('试听一下', 'Play a sample'),
            }),
            h('span', { key: 'hint', className: 'dsh-tts-hint' }, t('固定一句中英混读', 'fixed mixed zh/en sentence')),
          ]),
        ),
        h('div', { className: 'dsh-tts-card', key: 'speech' },
          head('head', t('朗读', 'Playback'),
            t('每段字数决定一次合成多长；速度只改播放快慢，不改音调。',
              'Part size sets how much text one synthesis covers; speed only changes playback, never pitch.')),
          row('chars', t('每段上限', 'Max per part'), [
            h(NumberInput, {
              key: 'input',
              className: 'dsh-tts-input num', min: 100, max: 4000, step: 100,
              value: config.maxChars, disabled: busy,
              onCommit: (value) => void save({ maxChars: value }),
            }),
            h('span', { className: 'dsh-tts-unit', key: 'unit' }, t('字', 'chars')),
          ]),
          row('speed', t('速度', 'Speed'), [
            h('input', {
              key: 'range',
              className: 'dsh-tts-range', type: 'range', min: 0.5, max: 2, step: 0.05,
              value: speedDraft === null ? config.speed : speedDraft,
              disabled: busy,
              'aria-label': t('朗读速度', 'Playback speed'),
              onChange: (event) => setSpeedDraft(event.target.value),
              onPointerUp: commitSpeed,
              onKeyUp: commitSpeed,
              onBlur: commitSpeed,
            }),
            h('span', { className: 'dsh-tts-value', key: 'value' }, (Number(speedDraft === null ? config.speed : speedDraft) || 1).toFixed(2) + '×'),
          ]),
        ),
        h('div', { className: 'dsh-tts-card', key: 'when' },
          head('head', t('自动朗读', 'Auto-read'),
            t('打开后自动念出对应内容；全关掉也还能点每条回复的喇叭。',
              'Turn these on to speak automatically; the speaker button still works with all of them off.')),
          // Every switch here is auto-reading; the label only names the source,
          // so the old "when to speak" framing is gone.
          check('auto', 'autoRead', t('读回复', 'Read replies'), t('回合结束的整条回复', "the turn's final reply"), config.autoRead === true),
          check('interim', 'autoReadInterim', t('读中途输出', 'Read mid-turn output'), t('需先开启「读回复」', 'needs "Read replies"'), config.autoReadInterim === true),
          check('q', 'speakQuestions', t('读提问', 'Read questions'), t('需要你作答的问题', 'prompts that need your answer'), config.speakQuestions !== false),
          check('ap', 'speakApprovals', t('读授权', 'Read approvals'), t('需要你确认的授权请求', 'requests that need your confirmation'), config.speakApprovals !== false),
        ),
        h('div', { className: 'dsh-tts-card', key: 'cache' },
          h('div', { className: 'dsh-tts-head', key: 'head' },
            h('div', { className: 'dsh-tts-headrow', key: 'title' },
              h('span', { className: 'dsh-tts-h1', key: 'h' }, t('音频缓存', 'Audio cache')),
            ),
            h('div', { className: 'dsh-tts-hint', key: 'hint' },
              cacheMode === 'disk'
                ? ((config.cache ? config.cache.files : 0) + t(' 个文件 · ', ' files · ') + cacheMb + ' MB / ' + cacheLimit + ' MB'
                  + (config.cache && config.cache.pinned && config.cache.pinned.files > 0
                    ? t('（固定提示语 ' + config.cache.pinned.files + ' 个，不参与淘汰）',
                      ' (' + config.cache.pinned.files + ' pinned, never evicted)')
                    : ''))
                : (t('内存中 ', 'in memory: ') + memCache.files + t(' 段 · ', ' entries · ') + memMb + ' MB / ' + memLimitMb + ' MB')),
            h('div', { className: 'dsh-tts-hint', key: 'note' },
              t('只缓存走 Host 合成的引擎（DeepSeek / 自定义 API / 系统语音）；浏览器朗读不产生缓存。',
                'Only Host-synthesized engines (DeepSeek, custom API, system voices) are cached; browser speech never is.')),
            h('div', { className: 'dsh-tts-meter', key: 'meter' },
              h('i', { style: { width: (cacheMode === 'disk' ? cachePct : memPct) + '%' } })),
          ),
          row('mode', t('位置', 'Location'),
            h('select', {
              className: 'dsh-tts-select', value: cacheMode, disabled: busy,
              onChange: (event) => void save({ cacheMode: event.target.value }),
              children: [
                h('option', { value: 'disk', key: 'disk' }, t('硬盘（重启后仍在）', 'Disk (survives a restart)')),
                h('option', { value: 'memory', key: 'memory' }, t('内存（重启即清空，不写盘）', 'Memory (cleared on restart, nothing written)')),
              ],
            })),
          cacheMode === 'disk' ? row('limit', t('上限', 'Limit'), [
            h(NumberInput, {
              key: 'input',
              className: 'dsh-tts-input num', min: MIN_CACHE_MB, max: MAX_CACHE_MB, step: 50,
              value: config.cacheMaxMb, disabled: busy,
              onCommit: (value) => void save({ cacheMaxMb: value }),
            }),
            h('span', { className: 'dsh-tts-unit', key: 'unit' }, 'MB'),
          ]) : null,
          row('clear', t('清理', 'Cleanup'), [
            h('button', {
              key: 'clear',
              className: 'dsh-tts-btn danger', type: 'button', disabled: busy,
              onClick: async () => {
                try {
                  const response = await fetch(CLEAR_PATH, { method: 'POST' })
                  const body = await response.json()
                  if (body && body.ok) { playedMessages.clear(); load(); setNotice(t('缓存已清空', 'Cache cleared')) }
                } catch (error) {
                  setFailure(error && error.message ? error.message : String(error))
                }
              },
              children: t('清空缓存', 'Clear cache'),
            }),
          ]),
        ),
        h('div', { className: 'dsh-tts-foot', key: 'foot' }, t('回车、失焦或松手后保存。', 'Saves on Enter, blur, or release.')),
        notice ? h('div', { className: 'dsh-tts-toast ok', key: 'notice' }, notice) : null,
        failure ? h('div', { className: 'dsh-tts-toast err', key: 'failure' }, failure) : null,
        h(InstallGuide, { key: 'guide', open: guideOpen, onClose: () => setGuideOpen(false) }),
      )
    }

    const CSS = [
      '.dsh-tts-wave rect{fill:currentColor;transform-origin:center;transform-box:fill-box;'
        + 'animation:dsh-tts-wave .9s ease-in-out infinite}',
      '.dsh-tts-wave.is-paused rect{animation-play-state:paused}',
      '@keyframes dsh-tts-wave{0%,100%{transform:scaleY(.35)}50%{transform:scaleY(1)}}',
      '.dsh-tts-spin{animation:dsh-tts-spin .9s linear infinite;transform-origin:center}',
      '@keyframes dsh-tts-spin{to{transform:rotate(360deg)}}',
      '.dsh-tts-range{appearance:none;-webkit-appearance:none;background:transparent;height:18px;cursor:pointer}',
      '.dsh-tts-range::-webkit-slider-runnable-track{height:4px;border-radius:2px;'
        + 'background:var(--dsw-alias-border-l2,#3a3a3a)}',
      '.dsh-tts-range::-webkit-slider-thumb{-webkit-appearance:none;width:12px;height:12px;margin-top:-4px;'
        + 'border:0;border-radius:50%;background:var(--dsw-alias-state-business-primary,#3b82f6)}',
      '.dsh-tts-range::-moz-range-track{height:4px;border-radius:2px;background:var(--dsw-alias-border-l2,#3a3a3a)}',
      '.dsh-tts-range::-moz-range-thumb{width:12px;height:12px;border:0;border-radius:50%;'
        + 'background:var(--dsw-alias-state-business-primary,#3b82f6)}',
      // ---- settings page ----
      // One rhythm: card head (title + status + one hint) over rows built from a
      // fixed label gutter and one control column that every control fills, so
      // the page keeps its shape per row type and per language.
      '.dsh-tts-settings{display:flex;flex-direction:column;gap:16px;font-size:13px;padding:8px 2px 20px;color:var(--dsw-alias-label-primary)}',
      '.dsh-tts-card{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}',
      '.dsh-tts-head{display:flex;flex-direction:column;gap:4px;padding:14px 16px 12px}',
      '.dsh-tts-headrow{display:flex;align-items:center;justify-content:space-between;gap:10px;min-width:0}',
      '.dsh-tts-h1{font-size:13px;font-weight:600;line-height:1.4}',
      '.dsh-tts-hint{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-tts-head .dsh-tts-hint{font-size:12px;white-space:normal;overflow:visible}',
      '.dsh-tts-row{box-sizing:border-box;display:grid;grid-template-columns:96px minmax(0,1fr);align-items:center;column-gap:12px;min-height:48px;padding:6px 16px;border-top:1px solid var(--dsw-alias-border-l2)}',
      '.dsh-tts-label{font-size:12px;line-height:1.4;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-tts-grow{display:flex;align-items:center;gap:8px;min-width:0}',
      '.dsh-tts-unit{flex:0 0 auto;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-tts-input,.dsh-tts-select{box-sizing:border-box;height:30px;margin:0;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.2;font-family:inherit;outline:none}',
      '.dsh-tts-input:focus,.dsh-tts-select:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 1px var(--dsw-alias-state-business-primary)}',
      '.dsh-tts-input.num{flex:0 0 auto;width:96px;text-align:right;font-variant-numeric:tabular-nums}',
      '.dsh-tts-input.wide{flex:1 1 auto;width:auto;min-width:0;text-align:left}',
      '.dsh-tts-area{box-sizing:border-box;flex:1 1 auto;width:100%;min-height:56px;max-height:180px;margin:0;padding:6px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.5;font-family:inherit;resize:vertical;outline:none}',
      '.dsh-tts-area:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 1px var(--dsw-alias-state-business-primary)}',
      '.dsh-tts-input[type=number]::-webkit-inner-spin-button,.dsh-tts-input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}',
      '.dsh-tts-select{flex:1 1 auto;width:auto;min-width:0;max-width:100%;cursor:pointer}',
      '.dsh-tts-range{flex:1 1 auto;min-width:80px;height:4px;margin:0;appearance:none;-webkit-appearance:none;border-radius:2px;background:var(--dsw-alias-bg-layer-3);outline:none;cursor:pointer}',
      '.dsh-tts-range::-webkit-slider-thumb{appearance:none;-webkit-appearance:none;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-state-business-primary);border:2px solid var(--dsw-alias-bg-layer-2);cursor:pointer}',
      '.dsh-tts-range::-moz-range-thumb{width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-state-business-primary);border:2px solid var(--dsw-alias-bg-layer-2);cursor:pointer}',
      '.dsh-tts-range:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:3px}',
      '.dsh-tts-value{flex:0 0 46px;text-align:right;font-size:12px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}',
      '.dsh-tts-btn{box-sizing:border-box;height:30px;margin:0;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;line-height:1;font-family:inherit;cursor:pointer}',
      '.dsh-tts-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-3)}',
      '.dsh-tts-btn:disabled{opacity:.55;cursor:default}',
      '.dsh-tts-btn.push{margin-left:auto}',
      '.dsh-tts-btn.danger:hover:not(:disabled){border-color:#e5484d;color:#e5484d}',
      '.dsh-tts-check{box-sizing:border-box;display:grid;grid-template-columns:16px minmax(0,1fr) auto;align-items:center;column-gap:10px;min-height:48px;padding:6px 16px;border-top:1px solid var(--dsw-alias-border-l2);font-size:13px;line-height:1.4;color:var(--dsw-alias-label-primary);cursor:pointer}',
      '.dsh-tts-check input{box-sizing:border-box;width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer}',
      '.dsh-tts-check-text{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-tts-check .dsh-tts-hint{justify-self:end;max-width:220px}',
      '.dsh-tts-badge{box-sizing:border-box;display:inline-flex;align-items:center;flex:0 1 auto;max-width:100%;min-width:0;min-height:22px;padding:2px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);font-size:11px;line-height:1.35;white-space:normal;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary)}',
      '.dsh-tts-badge.ok{color:#30a46c;border-color:rgba(48,164,108,.5)}',
      '.dsh-tts-badge.warn{color:#e5484d;border-color:rgba(229,72,77,.5)}',
      '.dsh-tts-head .dsh-tts-meter{height:4px;margin-top:8px;border-radius:2px;background:var(--dsw-alias-bg-layer-3);overflow:hidden}',
      '.dsh-tts-meter i{display:block;height:100%;border-radius:2px;background:var(--dsw-alias-state-business-primary);transition:width .25s}',
      '.dsh-tts-foot{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);padding:0 2px}',
      '.dsh-tts-toast{font-size:12px;line-height:1.5;padding:0 2px}',
      '.dsh-tts-toast.ok{color:#30a46c}',
      '.dsh-tts-toast.err{color:#e5484d}',
      // ---- install guide dialog ----
      // A native <dialog> owns the top layer, the backdrop and Escape, so the
      // guide cannot be clipped by the settings pane's own scroll box.
      '.dsh-tts-dialog{box-sizing:border-box;width:min(560px,calc(100vw - 48px));max-height:min(82vh,720px);margin:auto;padding:0;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.6;box-shadow:0 18px 48px rgba(0,0,0,.45);overflow:auto}',
      '.dsh-tts-dialog::backdrop{background:rgba(0,0,0,.45)}',
      '.dsh-tts-dialog-head{position:sticky;top:0;z-index:1;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 16px;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}',
      '.dsh-tts-dialog-title{font-size:14px;font-weight:600;line-height:1.4}',
      '.dsh-tts-close{box-sizing:border-box;height:26px;min-width:26px;padding:0 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:1;font-family:inherit;cursor:pointer}',
      '.dsh-tts-close:hover{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}',
      '.dsh-tts-dialog-body{display:flex;flex-direction:column;gap:12px;padding:14px 16px 18px}',
      '.dsh-tts-dialog-body ol{display:flex;flex-direction:column;gap:8px;margin:0;padding-left:20px}',
      '.dsh-tts-dialog-body li{margin:0}',
      '.dsh-tts-kv{font-size:12px;line-height:1.6;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-3)}',
      '.dsh-tts-dialog-foot{font-size:11px;line-height:1.7;color:var(--dsw-alias-label-secondary)}',
      '.dsh-tts-dialog a{color:var(--dsw-alias-state-business-primary);text-decoration:none}',
      '.dsh-tts-dialog a:hover{text-decoration:underline}',
    ].join('\n')

    function injectStyles() {
      if (typeof document === 'undefined') return () => {}
      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-tts-reader'
      style.textContent = CSS
      document.head.appendChild(style)
      return () => { try { style.remove() } catch {} }
    }

    // Settings navigation glyph for this plugin's own section id; same adapted
    // Lucide volume-2 paths as SpeakerIcon (ISC, see THIRD_PARTY.md).
    function SettingsIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 16
      const active = props && props.active === true
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: active ? 2 : 1.8,
        strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, style: { opacity: active ? 1 : 0.85 },
      },
        h('path', {
          d: 'M11 4.7a.7.7 0 0 0-1.2-.5L6.4 7.6A1.4 1.4 0 0 1 5.4 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.4a1.4 1.4 0 0 1 1 .4l3.4 3.4a.7.7 0 0 0 1.2-.5z',
          key: 'body',
        }),
        h('path', { d: 'M16 9a5 5 0 0 1 0 6', key: 'wave-1' }),
        h('path', { d: 'M19.4 18.4a9 9 0 0 0 0-12.8', key: 'wave-2' }),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => injectStyles(), 'dsh-tts-reader: styles')
        localeCtx = ctx.locale
        // Kept for lazy lookups: `theme` may mount after this plugin, and the
        // bridge is told about theme/language changes as they happen.
        appCtx = ctx
        watchLocale(ctx)
        watchBridgePrefs(ctx)
        loadConfigOnce()
        ensureEvents(ctx)

        // Keep the feed alive: reconnect if it dropped, and re-check on focus.
        ctx.effect(() => {
          const timer = setInterval(() => {
            if (!eventSource) ensureEvents(ctx)
            else if (typeof EventSource !== 'undefined'
              && (eventSource.readyState === EventSource.CLOSED || eventSource.readyState === EventSource.CONNECTING)) {
              try { eventSource.close() } catch {}
              eventSource = null
              ensureEvents(ctx)
            }
          }, 5000)
          const onFocus = () => { if (!eventSource) ensureEvents(ctx) }
          const onVisible = () => {
            if (document.visibilityState !== 'visible') return
            if (!eventSource) ensureEvents(ctx)
            pollRecent()
          }
          try { window.addEventListener('focus', onFocus) } catch {}
          try { document.addEventListener('visibilitychange', onVisible) } catch {}
          return () => {
            clearInterval(timer)
            try { window.removeEventListener('focus', onFocus) } catch {}
            try { document.removeEventListener('visibilitychange', onVisible) } catch {}
          }
        }, 'dsh-tts-reader: watchdog')

        // The assistant feed also has a pull path, so a silently dropped
        // EventSource cannot stop auto-read.
        ctx.effect(() => {
          const timer = setInterval(pollRecent, 2500)
          pollRecent()
          return () => { clearInterval(timer) }
        }, 'dsh-tts-reader: recent poll')

        // Follows the visible session even before it has any assistant message,
        // so auto-read always compares against the right session id.
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'tts-reader-session',
          order: 900,
        }, SessionTracker))

        // Mounted on document.body instead of a slot: request dialogs can cover
        // every slot-rendered surface.
        ctx.effect(() => mountPromptButton(), 'dsh-tts-reader: prompt button')

        ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
          name: 'conversation.chat.assistant-actions',
          id: 'tts-reader',
          order: 40,
          // A thunk: the owner re-reads it per projection, so the label follows
          // the app language without re-registering.
          label: () => t('朗读', 'Read aloud'),
        }, ReadAloudAction))

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'tts-reader',
          order: 26,
          label: () => t('语音朗读', 'Read aloud'),
        }, TtsSettings))

        // The settings navigation glyph for our own section id.
        ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
          name: 'settings.section.icon',
          id: 'tts-reader',
        }, SettingsIcon))
      },
    }
  },
})

