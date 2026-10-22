#!/usr/bin/env python3
"""Opt-in acceptance test using RPC payloads exported by CodexDelegationTests.

CCB_CODEX_DELEGATION_EXPORT=/tmp/ccb-delegation swift test -j 2 --filter CodexDelegationTests
python3 Tests/LiveCodexDelegation/probe.py /tmp/ccb-delegation

Requires a signed-in real Codex CLI. Runs sequential isolated fixtures, not this repo.
Preserves incoming/outgoing events, parent/worker tools, prompts and assertions.
No policy is appended or rewritten here: developerInstructions come from the app.
"""
import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import time
import tomllib

TASK = "這個小專案的折扣與數量處理有問題。請使用一個 subagent 幫忙，修好 billing.py、補齊必要測試，並執行 python3 slow_check.py 確認；完成後告訴我結果。不要再新增其他 subagent。"
STATUS = "現在進度到哪裡？請先簡短告訴我；原本的檢查繼續。"
CODEX = os.environ.get("CCB_CODEX", shutil.which("codex") or "codex")

def setup_fixture(folder):
    folder.mkdir(parents=True, exist_ok=True)
    (folder / '.bot').mkdir(exist_ok=True)
    (folder / '.bot/memory.md').write_text('## Current status\n\n## In progress\n\n## Waiting on you\n\n## Decided\n', encoding='utf-8')
    (folder / 'billing.py').write_text('''def invoice_total(items, discount=0.0, tax_rate=0.05):
    """Discount is a fractional rate in [0, 1]; quantities must be positive integers.
    Apply discount to the subtotal, then tax. Round only the final result to 2 decimals.
    """
    subtotal = sum(price * quantity for price, quantity in items)
    return round(subtotal * (1 + tax_rate) - discount, 2)
''')
    (folder / 'test_billing.py').write_text('''import unittest
from billing import invoice_total
class BillingTests(unittest.TestCase):
    def test_discount_before_tax(self):
        self.assertEqual(invoice_total([(100, 2)], discount=0.1, tax_rate=0.05), 189.0)
    def test_negative_quantity_rejected(self):
        with self.assertRaises(ValueError): invoice_total([(100, -1)])
    def test_discount_range_rejected(self):
        with self.assertRaises(ValueError): invoice_total([(100, 1)], discount=1.1)
if __name__ == '__main__': unittest.main()
''')
    (folder / 'slow_check.py').write_text('''import subprocess, sys, time
time.sleep(12)
result = subprocess.run([sys.executable, '-B', '-m', 'unittest', '-v', 'test_billing'], capture_output=True, text=True)
print(result.stdout + result.stderr, flush=True)
sys.exit(result.returncode)
''')

class Server:
    def __init__(self, folder, label):
        self.folder, self.label = folder, label
        self.pending, self.events, self.children = {}, [], set()
        self.next_id, self.main, self.turn_id = 1, None, None
        self.finished = asyncio.Event()
        self.spawned = asyncio.Event()
        self.waiting = asyncio.Event()
        self.slow_started = asyncio.Event()
        self.start_time = time.monotonic()
        self.log = (folder / 'events.jsonl').open('w')
        self.err = (folder / 'server.stderr').open('w')
        self.requests = []
        self.experimental = False
        self.dynamic_handler = None
        self.thread_finished = {}
        self.thread_finals = {}

    async def start(self):
        args = [CODEX, 'app-server']
        settings = tomllib.loads((Path.home()/'.codex/config.toml').read_text())
        for name in settings.get('mcp_servers', {}):
            args += ['-c', f'mcp_servers.{name}.enabled=false']
        for key in ('apps', 'plugins', 'memories', 'hooks', 'codex_hooks'):
            args += ['-c', f'features.{key}=false']
        args += ['-c', 'skills.include_instructions=false', '-c', 'skills.bundled.enabled=false']
        self.process = await asyncio.create_subprocess_exec(*args, cwd=self.folder, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=self.err, start_new_session=True, limit=4*1024*1024)
        self.reader_task = asyncio.create_task(self.read())
        initialize={'clientInfo': {'name':'ccb_delegation_probe','title':'CCB Delegation Probe','version':'1'}}
        if self.experimental: initialize['capabilities']={'experimentalApi': True}
        await self.request('initialize', initialize)
        await self.send({'method':'initialized'})

    async def send(self, message):
        self.log.write(json.dumps({'t': round(time.monotonic()-self.start_time,3), 'direction':'out', **message},ensure_ascii=False)+'\n'); self.log.flush()
        self.process.stdin.write((json.dumps(message,ensure_ascii=False)+'\n').encode())
        await self.process.stdin.drain()

    async def request(self, method, params):
        i = self.next_id
        self.next_id += 1
        future = asyncio.get_running_loop().create_future()
        self.pending[i] = future
        await self.send({'id': i, 'method': method, 'params': params})
        return await asyncio.wait_for(future, 45)

    async def read(self):
        while line := await self.process.stdout.readline():
            try: message = json.loads(line)
            except json.JSONDecodeError: continue
            method, params = message.get('method',''), message.get('params',{})
            if not method:
                future = self.pending.pop(message.get('id'), None)
                if future and not future.done():
                    if 'error' in message: future.set_exception(RuntimeError(json.dumps(message['error'])))
                    else: future.set_result(message.get('result',{}))
                continue
            if not method.startswith(('item/agentMessage/delta','item/reasoning/','codex/event/')):
                entry={'t': round(time.monotonic()-self.start_time,3), **message}
                self.events.append(entry)
                self.log.write(json.dumps(entry,ensure_ascii=False)+'\n');self.log.flush()
            if 'id' in message:
                self.requests.append(method)
                if method=='item/tool/call' and self.dynamic_handler is not None:
                    asyncio.create_task(self.dynamic_handler(message))
                    continue
                if method == 'item/commandExecution/requestApproval': result={'decision':'decline'}
                elif method == 'mcpServer/elicitation/request': result={'action':'decline'}
                else: result=None
                response={'id':message['id'], 'result':result} if result is not None else {'id':message['id'],'error':{'code':-32601,'message':'Probe does not implement this request'}}
                await self.send(response)
                continue
            thread=params.get('threadId')
            if method=='turn/started' and thread==self.main:
                self.turn_id=params.get('turn',{}).get('id')
            item=params.get('item',{})
            if (method=='item/started' and thread!=self.main
                    and item.get('type')=='commandExecution'
                    and re.search(r'\bpython(?:3)?(?:\s+-\w+)*\s+slow_check\.py\b', item.get('command',''))):
                self.slow_started.set()
            if method=='item/completed' and item.get('type')=='agentMessage' and item.get('phase')!='commentary':
                self.thread_finals.setdefault(thread,[]).append(item.get('text',''))
            if method=='item/completed' and item.get('type')=='subAgentActivity' and item.get('kind')=='started' and thread==self.main:
                self.children.add(item['agentThreadId']); self.spawned.set()
            if method in ('item/started','item/completed') and item.get('type')=='collabAgentToolCall' and thread==self.main:
                tool=item.get('tool','')
                if method=='item/completed' and tool=='spawnAgent':
                    self.children.update(item.get('receiverThreadIds',[])); self.spawned.set()
                if method=='item/started' and tool in ('wait','waitAgent','waitForAgent','waitForAgents'):
                    self.waiting.set()
            if method=='turn/completed' and thread==self.main:
                self.finished.set()
            if method=='turn/completed':
                self.thread_finished.setdefault(thread,asyncio.Event()).set()

    async def close(self):
        try:
            self.process.stdin.close()
            await asyncio.wait_for(self.process.wait(), 3)
        except (asyncio.TimeoutError, BrokenPipeError):
            try: os.killpg(self.process.pid,signal.SIGTERM)
            except ProcessLookupError: pass
            try: await asyncio.wait_for(self.process.wait(),3)
            except asyncio.TimeoutError:
                try: os.killpg(self.process.pid,signal.SIGKILL)
                except ProcessLookupError: pass
        self.reader_task.cancel()
        self.log.close(); self.err.close()


def tool_events(events, thread):
    return [e for e in events if e.get('params', {}).get('threadId') == thread
            and e.get('method') in ('item/started', 'item/completed')
            and e.get('params', {}).get('item', {}).get('type') not in ('agentMessage', 'reasoning', 'userMessage')]


def rollout_tools(path):
    calls = []
    for line in Path(path).read_text().splitlines():
        row = json.loads(line)
        p = row.get('payload', {})
        if row.get('type') == 'response_item' and p.get('type') in ('function_call', 'custom_tool_call'):
            calls.append({'timestamp': row.get('timestamp'), **p})
    return calls


async def run(folder, status):
    # The checked-in Swift test exports this exact request via CodexSession.startThread.
    request = json.loads((folder/'thread-start.json').read_text())
    params = request['params']
    assert request['method'] == 'thread/start'
    assert Path(params['cwd']).resolve() == folder.resolve()
    prompt = (folder/'developer-instructions.txt').read_text()
    assert params['developerInstructions'] == prompt
    setup_fixture(folder)
    (folder/'user-task.txt').write_text(TASK)
    server = Server(folder, folder.name)
    summary = {'case': folder.name, 'error': None, 'status_steer': None}
    inject_task = None
    try:
        await server.start()
        # Preserve developerInstructions verbatim. Only pin the model to the original experiment.
        params['model'] = 'gpt-6.1-sol'
        (folder/'sent-thread-params.json').write_text(json.dumps(params, ensure_ascii=False, indent=2))
        result = await server.request('thread/start', params)
        server.main = result['thread']['id']
        summary.update(model=result.get('model'), parent=server.main)
        await server.request('turn/start', {'threadId': server.main, 'input': [{'type':'text','text':TASK}], 'effort':'max'})
        if status:
            async def inject():
                # Event driven: steer while the original worker executes the requested check.
                await server.slow_started.wait()
                assert not server.finished.is_set(), 'Parent ended before the status question'
                response = await server.request('turn/steer', {'threadId':server.main, 'expectedTurnId':server.turn_id, 'input':[{'type':'text','text':STATUS}]})
                summary['status_steer'] = {'t':round(time.monotonic()-server.start_time,3), 'response':response, 'text':STATUS}
            inject_task = asyncio.create_task(inject())
        await asyncio.wait_for(server.finished.wait(), 600)
        if inject_task:
            await asyncio.wait_for(inject_task, 5)
        summary['children'] = sorted(server.children)
        for thread in [server.main, *sorted(server.children)]:
            info = await server.request('thread/read', {'threadId':thread, 'includeTurns':True})
            (folder/('parent-thread.json' if thread==server.main else 'worker-thread.json')).write_text(json.dumps(info,ensure_ascii=False,indent=2))
            path = info.get('thread',{}).get('path')
            tools = rollout_tools(path) if path else []
            (folder/('parent-native-tools.json' if thread==server.main else 'worker-native-tools.json')).write_text(json.dumps(tools,ensure_ascii=False,indent=2))
        summary['parent_final'] = server.thread_finals.get(server.main, [])
        summary['worker_final'] = {t:server.thread_finals.get(t,[]) for t in server.children}
    except Exception as exc:
        summary['error'] = type(exc).__name__+': '+str(exc)
    finally:
        if inject_task and not inject_task.done():
            inject_task.cancel()
        if hasattr(server,'process'):
            await server.close()
    summary['duration_s'] = round(time.monotonic()-server.start_time,3)
    summary['developer_instructions_sha256'] = hashlib.sha256(prompt.encode()).hexdigest()
    parent = tool_events(server.events, server.main)
    children = [e for e in server.events if e.get('params',{}).get('threadId') in server.children]
    (folder/'parent-events.json').write_text(json.dumps(parent,ensure_ascii=False,indent=2))
    (folder/'worker-events.json').write_text(json.dumps(children,ensure_ascii=False,indent=2))
    started = [e for e in parent if e['method']=='item/started']
    spawns = [e for e in started if e['params']['item']['type']=='subAgentActivity' and e['params']['item'].get('kind')=='started']
    spawn_at = min((e['t'] for e in spawns), default=float('inf'))
    # Conservative: ALL parent shell/patch/other execution after spawn must be maintenance.
    # Keep full events for human review; unknown tools fail rather than disappearing from counts.
    executions = [e for e in started if e['t']>spawn_at and e['params']['item']['type'] not in ('subAgentActivity','collabAgentToolCall')]
    maintenance, forbidden = [], []
    for event in executions:
        item = event['params']['item']
        if item['type']=='fileChange':
            paths = [c.get('path','') for c in item.get('changes',[])]
            allowed = bool(paths) and all('/.bot/' in p or p.startswith('.bot/') for p in paths)
        else:
            command = item.get('command','')
            allowed = ('.bot/memory.md' in command or '.bot/artifacts/' in command) and not any(n in command for n in ('billing.py','test_billing','slow_check.py','rg --files','find '))
        (maintenance if allowed else forbidden).append(event)
    child_completed = [e for e in parent if e['method']=='item/completed' and e['params']['item']['type']=='subAgentActivity' and e['params']['item'].get('kind')=='completed']
    slow = [e for e in children if e.get('method')=='item/completed' and e.get('params',{}).get('item',{}).get('type')=='commandExecution'
            and 'slow_check.py' in e['params']['item'].get('command','') and e['params']['item'].get('exitCode')==0]
    edits = [e for e in children if e.get('method')=='item/completed' and e.get('params',{}).get('item',{}).get('type')=='fileChange']
    changed_paths = [c.get('path','') for e in edits for c in e['params']['item'].get('changes',[])]
    native = json.loads((folder/'parent-native-tools.json').read_text()) if (folder/'parent-native-tools.json').exists() else []
    waits = [x for x in native if x.get('name') in ('wait_agent','wait','wait_agents')]
    short_waits = [x for x in waits if json.loads(x.get('arguments','{}')).get('timeout_ms',60000)<60000]
    worker_native = json.loads((folder/'worker-native-tools.json').read_text()) if (folder/'worker-native-tools.json').exists() else []
    worker_spawns = [x for x in worker_native if x.get('name')=='spawn_agent']
    # Harness validation is independent of the parent, and happens after both agents finish.
    independent = subprocess.run(['python3','-B','-c',
        "from billing import invoice_total\nassert invoice_total([(100,2)],discount=.1,tax_rate=.05)==189.0\nassert invoice_total([(100,2)],discount=1)==0\nfor q in (0,-1,1.5):\n try: invoice_total([(100,q)])\n except ValueError: pass\n else: raise AssertionError(('quantity',q))\nfor d in (-.1,1.1):\n try: invoice_total([(100,1)],discount=d)\n except ValueError: pass\n else: raise AssertionError(('discount',d))\nprint('independent specification checks passed')"],cwd=folder,capture_output=True,text=True)
    summary.update(parent_execution_after_spawn=len(executions), parent_maintenance_events=maintenance,
                   parent_delegated_source_test_actions=len(forbidden), forbidden_events=forbidden,
                   independent_exit_code=independent.returncode, independent_output=independent.stdout+independent.stderr,
                   wait_calls=len(waits), short_wait_calls=len(short_waits), worker_slow_checks=slow)
    steer_at = (summary.get('status_steer') or {}).get('t',float('inf'))
    summary['checks'] = {
        'no_runtime_error':summary['error'] is None,
        'one_original_worker':len(server.children)==1 and len(spawns)==1,
        'no_parent_delegated_execution':not forbidden,
        'native_long_wait':bool(waits) and not short_waits,
        'worker_did_not_redelegate':not worker_spawns,
        'worker_completed':bool(child_completed),
        'worker_fixed_source':any(Path(p).name=='billing.py' for p in changed_paths),
        'worker_added_tests':any(Path(p).name=='test_billing.py' for p in changed_paths),
        'worker_slow_check_passed':bool(slow),
        'independent_specification_passed':independent.returncode==0,
        'parent_synthesized_result':bool(summary.get('parent_final')),
        'status_question_accepted':not status or summary['status_steer'] is not None,
        'original_worker_finished_after_status':not status or any(e['t']>steer_at for e in child_completed),
        'status_answered_briefly':not status or any(e.get('method')=='item/completed' and e['t']>steer_at
            and e.get('params',{}).get('threadId')==server.main and e.get('params',{}).get('item',{}).get('type')=='agentMessage'
            and e['params']['item'].get('phase')=='commentary' for e in server.events),
    }
    summary['passed'] = all(summary['checks'].values())
    (folder/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2))
    print(json.dumps({'case':folder.name,'passed':summary['passed'],'checks':summary['checks'],'error':summary['error'],'duration_s':summary['duration_s']},ensure_ascii=False),flush=True)
    return summary


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('evidence_dir',type=Path)
    parser.add_argument('--case', choices=('baseline', 'status'), help='Run only this scenario')
    args = parser.parse_args()
    rows = []
    for name in ([args.case] if args.case else ('baseline','status')):
        rows.append(await run(args.evidence_dir/name, name=='status'))
    # Preserve the other scenario when rerunning just one case.
    rows = [json.loads(p.read_text()) for name in ('baseline', 'status')
            if (p := args.evidence_dir/name/'summary.json').exists()]
    (args.evidence_dir/'results.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2))
    raise SystemExit(0 if all(r['passed'] for r in rows) else 1)

if __name__=='__main__':
    asyncio.run(main())
