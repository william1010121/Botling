#!/usr/bin/env python3
"""Run after swift test (debug build with testing enabled). Never opens the installed app.
Links existing production objects into a local dylib so the probe exercises WebSession and
WebRailSection directly. Only freshly added account UUIDs are opened, with local HTML.
"""
import os
import pathlib
import subprocess
import sys

repo = pathlib.Path(__file__).resolve().parents[2]
out = pathlib.Path(sys.argv[1]).resolve()
out.mkdir(parents=True, exist_ok=True)
build = repo / '.build/arm64-apple-macosx/debug'
objects = sorted((build / 'ClaudeCodeBot.build').glob('*.swift.o')) + sorted((build / 'ClaudeCodeBotCore.build').glob('*.swift.o'))
assert objects, 'Run swift test first'
env = os.environ.copy()
env['CLANG_MODULE_CACHE_PATH'] = '/private/tmp/ccb-web-module-cache'
env['SWIFTPM_MODULECACHE_OVERRIDE'] = '/private/tmp/ccb-web-module-cache'
# Suppress WebSession background rereads of synthetic conversation URLs.
env['CCB_WINDOW_SNAPSHOT'] = str(out / 'unused.png')
subprocess.run(['swiftc', '-emit-library', '-o', str(out / 'libWebChatProbeApp.dylib'), *map(str, objects), '-framework', 'AppKit', '-framework', 'WebKit', '-framework', 'AVKit'], env=env, check=True)
subprocess.run(['swiftc', '-swift-version', '5', '-I', str(build / 'Modules'), '-L', str(out), '-lWebChatProbeApp', '-Xlinker', '-rpath', '-Xlinker', str(out), str(repo / 'Tests/WebChatVisibility/Probe.swift'), '-o', str(out / 'probe')], env=env, check=True)
subprocess.run([str(out / 'probe'), str(out)], env=env, check=True, timeout=45)
