#!/usr/bin/env python3
"""Independent WKWebView before/after regression. Does not run the installed App or use profiles."""
import json
import pathlib
import subprocess
import sys

repo = pathlib.Path(__file__).resolve().parents[2]
out = pathlib.Path(sys.argv[1]).resolve()
out.mkdir(parents=True, exist_ok=True)
probe = out / 'probe'
subprocess.run([
    'swiftc', str(repo / 'Sources/ClaudeCodeBotCore/WebMenuAnchoring.swift'),
    str(repo / 'Sources/ClaudeCodeBotCore/WebLaas.swift'),
    str(repo / 'Tests/WebMenuAnchor/Probe.swift'), '-o', str(probe),
    '-framework', 'AppKit', '-framework', 'WebKit', '-module-cache-path', str(out / 'module-cache')
], check=True)
for name, flags, expected in [
    ('before', [], 1),
    ('after', ['--repair'], 0),
    ('with-app-injections', ['--repair', '--app-injections', str(repo / 'Sources/ClaudeCodeBot/Resources')], 0),
]:
    result = subprocess.run([str(probe), str(repo / 'Tests/WebMenuAnchor/gemini-menu.html'), str(out / name), *flags], capture_output=True, text=True, timeout=40)
    (out / (name + '.log')).write_text(result.stdout + result.stderr)
    print(name + ': ' + result.stdout.strip().splitlines()[-1] if result.stdout else result.stderr)
    assert result.returncode == expected, f'{name}: unexpected exit {result.returncode}; see log'
    checks = json.loads((out / name / 'checks.json').read_text())['checks']
    assert (not checks['reported-912x680']) if name == 'before' else all(checks.values())
print('Expected uninjected WebKit failure and both repaired suites verified.')
