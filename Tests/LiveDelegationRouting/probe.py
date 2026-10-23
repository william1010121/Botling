#!/usr/bin/env python3
"""Behavior regression using actual exported BotPrompts and real Codex inference.

Tool doubles record routing only: they never launch a worker or edit app sources.
  CCB_ROUTING_EXPORT=/tmp/routing swift test --jobs 2 --filter DelegationRoutingPolicyTests
  python3 Tests/LiveDelegationRouting/probe.py /tmp/routing
Requires a locally authenticated Codex CLI; logs remain in the supplied local folder.
"""
import argparse
import asyncio
import json
import os
from pathlib import Path
import re
import shutil
import signal
import tomllib

EFFECTIVE_TRANSPORT = json.loads((Path(__file__).with_name('fixtures') / 'effective-transport.json').read_text())
TOOLS = EFFECTIVE_TRANSPORT['tools']


def evaluate(results):
    def handoffs(row): return [c for c in row['calls'] if c['tool'] == 'app_handoff']
    def source_handoffs(row):
        return [c for c in handoffs(row) if not re.search(r'memory|bookkeep|記憶', c['arguments'].get('name', ''), re.I)]
    turns = results['independent_requests']
    batch = results.get('batch_continuation', [results['batch']])
    def tagged(row, tag): return any(re.search('<' + tag + r'(?:\s|>)', r) for r in row['replies'])
    return {
        'source_uses_worker_not_plugin': bool(handoffs(results['app_source'])) and not tagged(results['app_source'], 'plugin'),
        'three_independent_handoffs': all(handoffs(row) and len(handoffs(row)) == len(row['calls']) for row in turns),
        'same_task_reuses_worker': len(results['same_task_followup']['calls']) == 1 and results['same_task_followup']['calls'][0]['tool'] == 'app_send_message' and bool(turns[-1]['calls']) and results['same_task_followup']['calls'][0]['arguments'].get('task_id') == turns[-1]['calls'][-1].get('receipt_task_id'),
        'component_still_maintainer': tagged(results['component'], 'component'),
        'plugin_still_maintainer': tagged(results['plugin'], 'plugin'),
        'batch_delegates_all_three': len(batch) == 3 and all(len(source_handoffs(row)) == 1 and len(row['calls']) == 1 for row in batch),
        'source_workers_isolated': all('worktree' in c['arguments'].get('instructions', '').lower() for row in turns for c in source_handoffs(row)) and all(handoffs(row) for row in turns),
    }


class Probe:
    def __init__(self, root):
        self.root = root
        self.pending = {}
        self.next_id = 0
        self.calls = []
        self.finals = []
        self.finished = asyncio.Event()
        self.log = (root / 'events.jsonl').open('w')
        self.stderr = (root / 'server.stderr').open('w')

    async def send(self, value):
        self.process.stdin.write((json.dumps(value) + '\n').encode())
        await self.process.stdin.drain()

    async def request(self, method, params):
        self.next_id += 1
        future = asyncio.get_running_loop().create_future()
        self.pending[self.next_id] = future
        await self.send({'id': self.next_id, 'method': method, 'params': params})
        return await asyncio.wait_for(future, 60)

    async def read(self):
        while line := await self.process.stdout.readline():
            msg = json.loads(line)
            self.log.write(json.dumps(msg, ensure_ascii=False) + '\n')
            self.log.flush()
            method, p = msg.get('method'), msg.get('params', {})
            if method is None:
                f = self.pending.pop(msg.get('id'), None)
                if f and not f.done():
                    if 'error' in msg:
                        f.set_exception(RuntimeError(str(msg['error'])))
                    else:
                        f.set_result(msg.get('result', {}))
            elif 'id' in msg:
                if method == 'item/tool/call':
                    args = p.get('arguments', {})
                    if isinstance(args, str): args = json.loads(args)
                    self.calls.append({'tool': p.get('tool'), 'arguments': args})
                    payload = {'status': 'accepted', 'task_id': args.get('task_id', 'worker-' + str(len(self.calls))), 'message': EFFECTIVE_TRANSPORT['acceptance_message']}
                    self.calls[-1]['receipt_task_id'] = payload['task_id']
                    result = {'success': True, 'contentItems': [{'type': 'inputText', 'text': json.dumps(payload)}]}
                    await self.send({'id': msg['id'], 'result': result})
                else:
                    await self.send({'id': msg['id'], 'error': {'code': -32601, 'message': 'Routing probe does not execute tools'}})
            elif method == 'item/completed' and p.get('item', {}).get('type') == 'agentMessage':
                self.finals.append(p['item'].get('text', ''))
            elif method == 'turn/completed':
                self.finished.set()

    async def start(self):
        args = [os.environ.get('CCB_CODEX', shutil.which('codex') or 'codex'), 'app-server']
        config = Path.home() / '.codex/config.toml'
        settings = tomllib.loads(config.read_text()) if config.exists() else {}
        for name in settings.get('mcp_servers', {}):
            args += ['-c', f'mcp_servers.{name}.enabled=false']
        for name in ('apps', 'plugins', 'memories', 'hooks', 'codex_hooks', 'multi_agent'):
            args += ['-c', f'features.{name}=false']
        args += ['-c', 'skills.include_instructions=false', '-c', 'skills.bundled.enabled=false']
        self.process = await asyncio.create_subprocess_exec(*args, cwd=self.root, stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=self.stderr, start_new_session=True, limit=4*1024*1024)
        self.reader = asyncio.create_task(self.read())
        await self.request('initialize', {'clientInfo': {'name': 'routing_regression', 'version': '1'}, 'capabilities': {'experimentalApi': True}})
        await self.send({'method': 'initialized'})

    async def turn(self, thread, text):
        call_start, final_start = len(self.calls), len(self.finals)
        self.finished.clear()
        await self.request('turn/start', {'threadId': thread, 'input': [{'type': 'text', 'text': text}], 'effort': 'high'})
        await asyncio.wait_for(self.finished.wait(), 180)
        return {'input': text, 'calls': self.calls[call_start:], 'replies': self.finals[final_start:]}

    async def thread(self, prompt, model):
        result = await self.request('thread/start', {'cwd': str(self.root), 'model': model, 'developerInstructions': prompt,
            'approvalPolicy': 'never', 'sandbox': 'read-only', 'dynamicTools': TOOLS,
            'config': {'features.shell_tool': False, 'web_search': 'disabled', 'features.multi_agent': False, 'agents.enabled': False}})
        return result['thread']['id']

    async def close(self):
        if hasattr(self, 'process'):
            try: os.killpg(self.process.pid, signal.SIGTERM)
            except ProcessLookupError: pass
            await self.process.wait()
            self.reader.cancel()
        self.log.close()
        self.stderr.close()


async def run(root, model):
    probe = Probe(root)
    prompt = (root / 'developer-instructions.txt').read_text()
    (root / 'consumed-developer-instructions.txt').write_text(prompt)
    results = {}
    try:
        await probe.start()
        t = await probe.thread(prompt, model)
        results['app_source'] = await probe.turn(t, '新增全域批次模型設定，可一次替所有 bot 套用同一個引擎與模型；側邊欄依實際啟用的引擎顯示，未選用的 Claude / Codex 不應佔位。請開始實作。')
        t = await probe.thread(prompt, model)
        turns = []
        turns.append(await probe.turn(t, '請實作全域模型設定與側邊欄啟用引擎顯示修正。'))
        turns.append(await probe.turn(t, '剛才那個 ClaudeCodeBot 原始碼工作不應交給 Maintainer。請先寫回歸測試再修正 app 產生的錯誤路由規則。'))
        turns.append(await probe.turn(t, '然後我想要把整個專案改名成 botling。請開始幫我做。'))
        results['independent_requests'] = turns
        results['same_task_followup'] = await probe.turn(t, '請通知剛才負責改名的 worker：產品顯示名稱使用 Botling，保留既有使用者資料。')
        t = await probe.thread(prompt, model)
        results['component'] = await probe.turn(t, '請把聊天內的 contribution-board 元件日／週／月切換改成圓角滑動膠囊。')
        t = await probe.thread(prompt, model)
        results['plugin'] = await probe.turn(t, '請新增一個 plugin-library 擴充套件，提供天氣查詢命令；只做外掛，不修改 macOS app 原始碼。')
        t = await probe.thread(prompt, model)
        results['batch'] = await probe.turn(t, '請處理三個互相獨立的工作：全域模型／側邊欄設定；app 產生的路由與委派規則測試及修正；將整個產品改名 Botling。請開始實作。')
        results['batch_continuation'] = [results['batch']]
        for _ in range(2):
            calls = results['batch_continuation'][-1]['calls']
            task = calls[0]['receipt_task_id'] if calls else 'no-accepted-task'
            results['batch_continuation'].append(await probe.turn(t, '(App: app_task_result ' + json.dumps({'task_id': task, 'status': 'completed', 'result': 'Completed only '+calls[0]['arguments'].get('name','assigned deliverable')+'. Commit abcdef1234567890; isolated worktree /tmp/fixture-'+task+' on branch bot/fixture-'+task+'. Changed Sources/Fixture-'+task+'.swift and Tests/Fixture-'+task+'Tests.swift. Executed swift test --jobs 2 --filter FixtureTests: 2 tests passed, 0 failures. No blockers; no integration. Other deliverables pending.'}) + ')'))
        checks = evaluate(results)
        summary = {'model': model, 'checks': checks, 'passed': all(checks.values()), 'results': results}
        (root / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2))
        print(json.dumps({'model': model, 'checks': checks, 'passed': summary['passed']}, indent=2))
        return summary['passed']
    finally:
        await probe.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('folder', type=Path)
    parser.add_argument('--model', default='gpt-6.1-sol')
    parser.add_argument('--check-existing', action='store_true', help='Re-evaluate recorded tool decisions without inference')
    args = parser.parse_args()
    if args.check_existing:
        path = args.folder / 'summary.json'
        summary = json.loads(path.read_text())
        summary['checks'] = evaluate(summary['results'])
        summary['passed'] = all(summary['checks'].values())
        path.write_text(json.dumps(summary, ensure_ascii=False, indent=2))
        print(json.dumps({'checks': summary['checks'], 'passed': summary['passed']}, indent=2))
        raise SystemExit(0 if summary['passed'] else 1)
    raise SystemExit(0 if asyncio.run(run(args.folder.resolve(), args.model)) else 1)
