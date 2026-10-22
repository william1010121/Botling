extension L10n {
    /// Words of the rail, the right strip and release views (RailStrip, RightStrip, ReleasePlannerView, ChatSurface). Each row: English, then
    /// [繁體中文 (Taiwan), 简体中文, 日本語, 한국어].
    static let viewStrings: Table = [
        // The rail (RailStrip)
        "Expand sidebar": ["展開側邊欄", "展开侧边栏", "サイドバーを展開", "사이드바 펼치기"],
        "Collapse sidebar": ["收合側邊欄", "收起侧边栏", "サイドバーを折りたたむ", "사이드바 접기"],
        "Add project…": ["新增專案…", "添加项目…", "プロジェクトを追加…", "프로젝트 추가…"],
        "New bot…": ["新增 Bot…", "新建 Bot…", "新しいボット…", "새 봇…"],
        "New group…": ["新增群組…", "新建群组…", "新しいグループ…", "새 그룹…"],
        "Add a project, a bot or a group": ["新增專案、Bot 或群組", "添加项目、Bot 或群组", "プロジェクト、ボット、グループを追加", "프로젝트, 봇 또는 그룹 추가"],
        // The right strip (RightStrip)
        "Show right panel": ["顯示右側面板", "显示右侧面板", "右パネルを表示", "오른쪽 패널 보기"],
        "Hide right panel": ["隱藏右側面板", "隐藏右侧面板", "右パネルを隠す", "오른쪽 패널 숨기기"],
        "{0}'s settings": ["{0} 的設定", "{0} 的设置", "{0} の設定", "{0} 설정"],
        "Bot settings": ["Bot 設定", "Bot 设置", "ボットの設定", "봇 설정"],
        "Esc to close": ["按 Esc 關閉", "按 Esc 关闭", "Esc で閉じる", "Esc로 닫기"],
        "{0}, {1}. Show the panel": ["{0}，{1}。顯示面板", "{0}，{1}。显示面板", "{0}、{1}。パネルを表示", "{0}, {1}. 패널 보기"],
        // Release planner (ReleasePlannerView)
        "Shared features, most 👍 first": ["共享的功能，👍 最多的在前", "共享的功能，👍 最多的在前", "共有された機能（👍 の多い順）", "공유된 기능 (👍 많은 순)"],
        "No open PRs labelled {0} yet.": ["還沒有標記為 {0} 的開放 PR。", "还没有标记为 {0} 的开放 PR。", "{0} ラベルの付いたオープンな PR はまだありません。", "{0} 라벨이 붙은 열린 PR이 아직 없습니다."],
        "A vote is a 👍 on the PR, seen on GitHub too. Tick the ones for the next version.": [
            "投票就是在 PR 上按 👍，在 GitHub 上也看得到。勾選要放進下一版的項目。",
            "投票就是在 PR 上点 👍，在 GitHub 上也能看到。勾选要放进下一版的项目。",
            "投票は PR への 👍 で、GitHub でも見えます。次のバージョンに入れるものにチェックを付けてください。",
            "투표는 PR에 누르는 👍이며 GitHub에서도 보입니다. 다음 버전에 넣을 항목을 체크하세요.",
        ],
        "A vote is a 👍 on the PR, seen on GitHub too. The repo's owner picks what goes into the next version.": [
            "投票就是在 PR 上按 👍，在 GitHub 上也看得到。由 repo 擁有者決定哪些放進下一版。",
            "投票就是在 PR 上点 👍，在 GitHub 上也能看到。由仓库所有者决定哪些放进下一版。",
            "投票は PR への 👍 で、GitHub でも見えます。次のバージョンに入れるものはリポジトリのオーナーが選びます。",
            "투표는 PR에 누르는 👍이며 GitHub에서도 보입니다. 다음 버전에 들어갈 항목은 저장소 소유자가 고릅니다.",
        ],
        "Reload": ["重新載入", "重新加载", "再読み込み", "다시 불러오기"],
        "Next version": ["下一版", "下一版", "次のバージョン", "다음 버전"],
        "Nothing picked yet.": ["還沒有選取任何項目。", "还没有选择任何项目。", "まだ何も選んでいません。", "아직 고른 것이 없습니다."],
        "Sent": ["已送出", "已发送", "送信済み", "보냄"],
        "Send to {0}": ["送給 {0}", "发给 {0}", "{0} に送る", "{0}에게 보내기"],
        "manager": ["管理者", "管理者", "マネージャー", "매니저"],
        "Its manager merges each picked PR whose tests pass and writes the release notes; one that conflicts or fails comes back to you.": [
            "它的管理者會合併測試通過的已選 PR 並撰寫發版說明；有衝突或失敗的會退回給你。",
            "它的管理者会合并测试通过的已选 PR 并撰写发版说明；有冲突或失败的会退回给你。",
            "マネージャーがテストに通った選択済みの PR をマージしてリリースノートを書きます。衝突や失敗があったものはあなたに戻ってきます。",
            "매니저가 테스트를 통과한 선택된 PR을 병합하고 릴리스 노트를 씁니다. 충돌하거나 실패한 것은 다시 돌아옵니다.",
        ],
        "Pick #{0} for the next version": ["將 #{0} 放進下一版", "将 #{0} 放进下一版", "#{0} を次のバージョンに選ぶ", "#{0}을(를) 다음 버전에 넣기"],
        "draft": ["草稿", "草稿", "下書き", "초안"],
        "Open on GitHub": ["在 GitHub 上開啟", "在 GitHub 上打开", "GitHub で開く", "GitHub에서 열기"],
        "You voted for this": ["你已投票", "你已投票", "投票済み", "투표함"],
        "Vote: a 👍 on the PR": ["投票：在 PR 上按 👍", "投票：在 PR 上点 👍", "投票：PR に 👍", "투표: PR에 👍"],
        "{0} votes. Vote for #{1}": ["{0} 票。投給 #{1}", "{0} 票。投给 #{1}", "{0} 票。#{1} に投票", "{0}표. #{1}에 투표"],
        // The chat surface's own (ChatSurface)
        "Attach": ["附加", "附加", "添付", "첨부"],
        "Couldn't revert component \"{0}\": {1}": ["無法還原元件「{0}」：{1}", "无法还原组件“{0}”：{1}", "コンポーネント「{0}」を元に戻せませんでした：{1}", "컴포넌트 \"{0}\"을(를) 되돌리지 못했습니다: {1}"],
    ]
}
