#!/usr/bin/env python3
"""Compile actual native UI with an isolated synthetic preview entry point."""
import json
import shutil
from pathlib import Path
import subprocess
import sys

repo = Path(__file__).resolve().parents[2]
out = Path(sys.argv[1]).resolve()
out.mkdir(parents=True, exist_ok=True)
build = repo / '.build/arm64-apple-macosx/debug'
# Remove only the app's entry annotation in a temporary copy; production source is untouched.
entry = out / 'AppWithoutEntry.swift'
entry.write_text((repo / 'Sources/ClaudeCodeBot/ClaudeCodeBotApp.swift').read_text().replace('@main\n', '', 1))
sources = sorted(p for p in (repo / 'Sources/ClaudeCodeBot').glob('*.swift') if p.name != 'ClaudeCodeBotApp.swift')
sources += [entry, repo / 'Tests/WebChatPinningPreview/Preview.swift', build / 'ClaudeCodeBot.build/DerivedSources/resource_bundle_accessor.swift']
objects = sorted((build / 'ClaudeCodeBotCore.build').glob('*.o'))
assert objects and all(p.exists() for p in sources), 'Run targeted swift test/build first'
object_dir = out / 'objects'
object_dir.mkdir(exist_ok=True)
ui_objects = [object_dir / (p.stem + '.o') for p in sources]
output_map = out / 'output-map.json'
output_map.write_text(json.dumps({str(p): {'object': str(obj)} for p, obj in zip(sources, ui_objects)}))
cmd = ['swiftc', '-c', '-parse-as-library', '-module-name', 'ClaudeCodeBot', '-swift-version', '5',
       '-target', 'arm64-apple-macosx14.0', '-I', str(build / 'Modules'),
       '-enable-batch-mode', '-j2', '-module-cache-path', '/private/tmp/botling-web-chat-pinning-module-cache',
       '-output-file-map', str(output_map), *map(str, sources)]
subprocess.run(cmd, check=True, cwd=repo)
subprocess.run(['swiftc', '-target', 'arm64-apple-macosx14.0', *map(str, ui_objects), *map(str, objects), '-o', str(out / 'preview')], check=True, cwd=repo)
# Only this harness's synthetic data, so reruns start with the same two accounts.
shutil.rmtree(out / 'fixture', ignore_errors=True)
subprocess.run([str(out / 'preview'), str(out)], check=True, cwd=repo)
