extension L10n {
    /// Words of the Settings window (SettingsWindow.swift). Each row: English, then
    /// [繁體中文 (Taiwan), 简体中文, 日本語, 한국어].
    static let settingsStrings: Table = [
        // Sections
        "General": ["一般", "常规", "一般", "일반"],
        "Usage": ["用量", "用量", "使用量", "사용량"],
        "Permissions": ["權限", "权限", "権限", "권한"],
        "Plugins": ["外掛", "插件", "プラグイン", "플러그인"],
        "Developer mode": ["開發者模式", "开发者模式", "開発者モード", "개발자 모드"],
        "Release planner": ["發版規劃", "发版规划", "リリース計画", "릴리스 계획"],
        "Doctor": ["健康檢查", "健康检查", "診断", "진단"],
        // General → Language
        "Language": ["語言", "语言", "言語", "언어"],
        "App language": ["App 語言", "应用语言", "アプリの言語", "앱 언어"],
        "System default ({0})": ["系統預設（{0}）", "系统默认（{0}）", "システムのデフォルト（{0}）", "시스템 기본값({0})"],
        "ClaudeCodeBot's menus, buttons and messages change at once. Bots reply in this language by default; when you write to them in another language, they answer in yours.": [
            "ClaudeCodeBot 的選單、按鈕和訊息會立即切換。Bot 預設也用這個語言回覆；你用其他語言寫給它們時，它們會用你的語言回答。",
            "ClaudeCodeBot 的菜单、按钮和消息会立即切换。Bot 默认也用这个语言回复；你用其他语言写给它们时，它们会用你的语言回答。",
            "ClaudeCodeBot のメニュー、ボタン、メッセージはすぐに切り替わります。ボットも標準でこの言語で返信します。別の言語で書くと、その言語で答えます。",
            "ClaudeCodeBot의 메뉴, 버튼, 메시지가 바로 바뀝니다. 봇도 기본적으로 이 언어로 답하며, 다른 언어로 쓰면 그 언어로 답합니다.",
        ],
    ]
}
