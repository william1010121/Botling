extension L10n {
    /// Words of web AIs as bots (WebSiteViews.swift, Workspace+Web.swift). Each row: English, then
    /// [繁體中文 (Taiwan), 简体中文, 日本語, 한국어].
    static let webStrings: Table = [
        "Web": ["網頁", "网页", "Web", "웹"],
        "{0} in the app: its conversations are saved as text the main bot can search": ["App 裡的 {0}：對話會存成文字，主 Bot 可以搜尋", "App 里的 {0}：对话会存成文字，主 Bot 可以搜索", "アプリ内の {0}：会話はメインボットが検索できるテキストとして保存されます", "앱 안의 {0}: 대화가 메인 봇이 검색할 수 있는 텍스트로 저장됩니다"],
        "{0}, web, {1} conversations": ["{0}，網頁，{1} 則對話", "{0}，网页，{1} 个对话", "{0}、Web、会話 {1} 件", "{0}, 웹, 대화 {1}개"],
        "Web · {0} conversations": ["網頁 · {0} 則對話", "网页 · {0} 个对话", "Web · 会話 {0} 件", "웹 · 대화 {0}개"],
        "{0} conversation: {1}": ["{0} 對話：{1}", "{0} 对话：{1}", "{0} の会話：{1}", "{0} 대화: {1}"],
        "{0} shows here, signed in as you.": ["{0} 會顯示在這裡，以你的帳號登入。", "{0} 会显示在这里，以你的账号登录。", "{0} がここに、あなたのアカウントで表示されます。", "{0}이(가) 여기에 내 계정으로 표시됩니다."],
        "Saved for Main bot · {0} messages": ["已存給主 Bot · {0} 則訊息", "已存给主 Bot · {0} 条消息", "メインボット用に保存済み · {0} 件", "메인 봇용으로 저장됨 · 메시지 {0}개"],
        "Couldn't read this page": ["讀不到這個頁面", "读不到这个页面", "このページを読み取れませんでした", "이 페이지를 읽지 못했습니다"],
        "Nothing was saved. {0} The page reader is in the plugin ccb-web-extractors; ask Maintainer to fix it.": ["沒有存任何東西。{0} 頁面讀取腳本在外掛 ccb-web-extractors 裡，請 Maintainer 修。", "没有保存任何内容。{0} 页面读取脚本在插件 ccb-web-extractors 里，请 Maintainer 修复。", "何も保存されていません。{0} ページ読み取りスクリプトはプラグイン ccb-web-extractors にあります。Maintainer に修正を頼んでください。", "아무것도 저장되지 않았습니다. {0} 페이지 읽기 스크립트는 플러그인 ccb-web-extractors에 있습니다. Maintainer에게 고쳐 달라고 하세요."],
        "No page reader for {0} was found.": ["找不到 {0} 的頁面讀取腳本。", "找不到 {0} 的页面读取脚本。", "{0} のページ読み取りスクリプトが見つかりません。", "{0}의 페이지 읽기 스크립트를 찾지 못했습니다."],
        "A new question is saved once it has an answer": ["新問題有回答後就會存下來", "新问题有回答后就会保存", "新しい質問は回答が付くと保存されます", "새 질문은 답이 달리면 저장됩니다"],
        "Reading…": ["讀取中…", "读取中…", "読み取り中…", "읽는 중…"],
        "This question": ["這個問題", "这个问题", "この質問", "이 질문"],
        "Questions": ["問題", "问题", "質問", "질문"],
        "New question": ["新問題", "新问题", "新しい質問", "새 질문"],
        "Opens {0} fresh; once it has an id it becomes a row": ["重新開啟 {0}；有了 id 後就會成為一列", "重新打开 {0}；有了 id 后就会成为一行", "{0} を新しく開きます。ID が付くと一行になります", "{0}을(를) 새로 엽니다. ID가 생기면 한 줄이 됩니다"],
        "{0} messages · saved {1}": ["{0} 則訊息 · {1} 存檔", "{0} 条消息 · {1} 保存", "{0} 件 · {1} に保存", "메시지 {0}개 · {1} 저장"],
        "Show in Finder": ["在 Finder 中顯示", "在访达中显示", "Finder で表示", "Finder에서 보기"],
        "Ask Main bot about this": ["問主 Bot 這段對話", "问主 Bot 这段对话", "メインボットに聞く", "메인 봇에게 묻기"],
        "Sends the main bot a message naming the saved file, so it can read it": ["傳訊息給主 Bot，附上存檔路徑讓它讀", "发消息给主 Bot，附上存档路径让它读", "保存したファイルを示すメッセージをメインボットに送り、読んでもらいます", "저장된 파일을 알려 주는 메시지를 메인 봇에게 보내 읽게 합니다"],
        "Ask {0} something; the conversation is listed and saved once it has an answer.": ["問 {0} 一個問題；有回答後，對話就會列出並存檔。", "问 {0} 一个问题；有回答后，对话就会列出并保存。", "{0} に何か聞いてください。回答が付くと会話が一覧に入り保存されます。", "{0}에게 무언가 물어보세요. 답이 달리면 대화가 목록에 오르고 저장됩니다."],
        "About my {0} conversation \"{1}\": read {2} and tell me what matters in it.": ["關於我和 {0} 的對話「{1}」：請讀 {2}，告訴我重點。", "关于我和 {0} 的对话“{1}”：请读 {2}，告诉我重点。", "{0} との会話「{1}」について：{2} を読んで、大事な点を教えてください。", "{0}와(과)의 대화 '{1}'에 대해: {2}을(를) 읽고 중요한 점을 알려 주세요."],
    ]
}
