#!/usr/bin/env python3
"""Transparent recording transport for the opt-in production CodexAgentProcess test.

The Swift production runtime generates every protocol message and prompt. This relay
only disables unrelated local extensions and records actual app-server traffic.
"""
import json
import os
from pathlib import Path
import subprocess
import signal
import sys
import threading
import time
import tomllib

real = os.environ['CCB_LIVE_CODEX_REAL']
folder = Path(os.environ['CCB_LIVE_CODEX_EVIDENCE'])
args = [real, *sys.argv[1:]]
config = Path.home() / '.codex/config.toml'
settings = tomllib.loads(config.read_text()) if config.exists() else {}
for name in settings.get('mcp_servers', {}):
    args += ['-c', f'mcp_servers.{name}.enabled=false']
for key in ('apps', 'plugins', 'memories', 'hooks', 'codex_hooks'):
    args += ['-c', f'features.{key}=false']
args += ['-c', 'skills.include_instructions=false', '-c', 'skills.bundled.enabled=false']
child = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=sys.stderr.buffer)
signal.signal(signal.SIGTERM, lambda *_: child.terminate() if child.poll() is None else None)
started = time.monotonic()
lock = threading.Lock()
log = (folder / 'rpc.jsonl').open('w')

def relay(source, target, direction):
    try:
        for line in iter(source.readline, b''):
            try:
                payload = json.loads(line)
                # Text deltas are available in completed items; avoid huge duplicate logs.
                method = payload.get('method', '')
                if not method.startswith(('item/agentMessage/delta', 'item/reasoning/', 'codex/event/')):
                    with lock:
                        log.write(json.dumps({'t': round(time.monotonic()-started, 3), 'direction': direction, 'rpc': payload}, ensure_ascii=False)+'\n')
                        log.flush()
            except (ValueError, UnicodeError):
                pass
            target.write(line)
            target.flush()
    except (BrokenPipeError, OSError):
        pass
    finally:
        if direction == 'out':
            try: target.close()
            except OSError: pass

input_thread = threading.Thread(target=relay, args=(sys.stdin.buffer, child.stdin, 'out'), daemon=True)
input_thread.start()
try:
    relay(child.stdout, sys.stdout.buffer, 'in')
    raise SystemExit(child.wait())
finally:
    if child.poll() is None:
        child.terminate()
