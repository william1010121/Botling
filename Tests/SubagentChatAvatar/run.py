#!/usr/bin/env python3
"""Render real sidebar rows with isolated synthetic stores, without launching the app.
Run after `swift build --jobs 2` from this checkout; output directory is argv[1].
"""
import os
from pathlib import Path
import subprocess
import shutil
import sys
import tempfile

repo = Path(__file__).resolve().parents[2]
build = (repo / '.build/debug').resolve()
output = Path(sys.argv[1]).resolve()
output.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix='ccb-subagent-render-') as scratch:
    scratch = Path(scratch)
    source = (repo / 'Sources/ClaudeCodeBot/SidePanels.swift').read_text()
    # Keep declarations byte-for-byte from production, not a rewritten row mock.
    start = source.index('struct SubagentRows: View')
    end = source.index('struct DetailPanel: View', start)
    rows = scratch / 'Rows.swift'
    def declaration(marker):
        begin = source.index(marker)
        opening = source.index('{', begin)
        depth = 1
        cursor = opening + 1
        while depth:
            if source[cursor] == '{': depth += 1
            elif source[cursor] == '}': depth -= 1
            cursor += 1
        return source[begin:cursor] + '\n'
    context = """
struct ParentChildPreview: View {
    let subagent: Subagent
    let bot: Bot
    let workspace: Workspace
    var body: some View {
        VStack(spacing: 2) {
            BotRow(bot: bot, selected: false, waiting: false) {}
            SubagentRow(subagent: subagent, bot: bot, workspace: workspace)
        }
    }
}
"""
    rows.write_text('import AppKit\nimport SwiftUI\nimport ClaudeCodeBotCore\n' + source[start:end]
                    + declaration('private struct BotRow: View')
                    + declaration('private struct UnreadBadge: View') + context)
    sources = [repo / 'Sources/ClaudeCodeBot' / name for name in ['Avatar.swift', 'Theme.swift', 'ChibiViews.swift']]
    binary = scratch / 'render'
    command = ['swiftc', '-parse-as-library', '-swift-version', '5', '-module-cache-path', '/private/tmp/ccb-subagent-module-cache',
               '-I', str(build / 'Modules'), *map(str, sources), str(rows), str(Path(__file__).with_name('render.swift')),
               *map(str, sorted((build / 'ClaudeCodeBotCore.build').glob('*.o'))), '-o', str(binary)]
    subprocess.run(command, check=True, cwd=repo)
    environment = os.environ.copy()
    if '--missing-assets' in sys.argv[2:]:
        # Shadow only this fixture process's Core bundle. Never change build or app assets.
        bundle = next(build.glob('*_ClaudeCodeBotCore.bundle'))
        isolated = scratch / bundle.name
        shutil.copytree(bundle, isolated)
        for asset in isolated.glob('CharacterArt/avatars-static/*/idle.png'):
            asset.unlink()
        environment['CCB_AVATAR_EXPECT_MISSING'] = '1'
    subprocess.run([str(binary), str(output)], check=True, cwd=repo, env=environment)
