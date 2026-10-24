#!/usr/bin/env python3
"""Render real sidebar rows with isolated synthetic stores, without launching the app.
Run after `swift build --jobs 2` from this checkout; output directory is argv[1].
"""
import os
from pathlib import Path
import subprocess
import sys
import tempfile

repo = Path(__file__).resolve().parents[2]
build = repo / '.build/arm64-apple-macosx/debug'
output = Path(sys.argv[1]).resolve()
output.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix='ccb-subagent-render-') as scratch:
    scratch = Path(scratch)
    source = (repo / 'Sources/ClaudeCodeBot/SidePanels.swift').read_text()
    # Keep declarations byte-for-byte from production, not a rewritten row mock.
    start = source.index('struct SubagentRows: View')
    end = source.index('struct DetailPanel: View', start)
    rows = scratch / 'Rows.swift'
    rows.write_text('import AppKit\nimport SwiftUI\nimport ClaudeCodeBotCore\n' + source[start:end])
    sources = [repo / 'Sources/ClaudeCodeBot' / name for name in ['Avatar.swift', 'Theme.swift', 'ChibiViews.swift']]
    avatar = repo / 'Sources/ClaudeCodeBot/SubagentAvatar.swift'
    if avatar.exists(): sources.append(avatar)
    binary = scratch / 'render'
    command = ['swiftc', '-parse-as-library', '-swift-version', '5', '-module-cache-path', '/private/tmp/ccb-subagent-module-cache',
               '-I', str(build / 'Modules'), *map(str, sources), str(rows), str(Path(__file__).with_name('render.swift')),
               *map(str, sorted((build / 'ClaudeCodeBotCore.build').glob('*.o'))), '-o', str(binary)]
    subprocess.run(command, check=True, cwd=repo)
    subprocess.run([str(binary), str(output)], check=True, cwd=repo)
