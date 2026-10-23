#!/usr/bin/env python3
"""Real fresh/resumed policy adoption; recording-only tools, synthetic history, no worker launch."""
import argparse
import asyncio
import json
from pathlib import Path
import phase_probe as phase

async def run(root, prompt_file, old_file, refresh):
    root.mkdir(parents=True, exist_ok=True)
    prompt = prompt_file.read_text()
    phase.transport.TOOLS = phase.EFFECTIVE['tools']
    p = phase.RealReceiptProbe(root)
    rows = []
    try:
        await p.start()
        thread = await p.thread(old_file.read_text(), 'gpt-6.1-sol')
        initial = await p.turn(thread, 'Remember the synthetic continuity marker ORCHID-731. Reply OK only; do not assign work.')
        assert not initial['calls']
        for label, fresh_process in [('same-process-resume', False), ('fresh-process-resume', True)]:
            if fresh_process:
                await p.close()
                folder = root / label
                folder.mkdir()
                p = phase.RealReceiptProbe(folder)
                await p.start()
            await p.request('thread/resume', {'threadId': thread, 'cwd':str(root),
                'developerInstructions':prompt,'approvalPolicy':'never','sandbox':'read-only','excludeTurns':True})
            if refresh:
                await p.request('thread/inject_items', {'threadId':thread, 'items':[
                    {'type':'message','role':'developer','content':[{'type':'input_text','text':prompt}]}]})
            deliverable = 'shortcut settings' if not fresh_process else 'screenshot export formats (a NEW independent deliverable, separate from previously assigned shortcut research)'
            row = await p.turn(thread, phase.REGISTRY + '\nUser: Create a separate worker for ' + deliverable + ' research and design ONLY. No implementation in any files, even new or nonconflicting files. File release does not authorize implementation. Include the remembered continuity marker in its instructions.')
            (root/(label+'-result.json')).write_text(json.dumps(row,ensure_ascii=False,indent=2))
            assert len(row['calls']) == 1
            phase.research_payload(row['calls'][0])
            assert 'ORCHID-731' in row['calls'][0]['arguments']['instructions'], 'conversation continuity lost'
            rows.append({'case':label,'thread':thread,'result':row})
        fresh = await p.thread(prompt, 'gpt-6.1-sol')
        row = await p.turn(fresh,phase.REGISTRY+'\nUser: Assign research/design only for shortcuts; no implementation in ANY files until explicit authorization.')
        assert len(row['calls'])==1
        phase.research_payload(row['calls'][0])
        rows.append({'case':'fresh-thread','thread':fresh,'result':row})
        (root/'summary.json').write_text(json.dumps({'passed':True,'refresh':refresh,'dynamicToolsReplaced':False,'rows':rows},ensure_ascii=False,indent=2))
        print('PASS: fresh, same-process resume, fresh-process resume; research contract and history retained; recording tools only')
    except Exception as e:
        (root/'summary.json').write_text(json.dumps({'passed':False,'error':str(e),'refresh':refresh,'rows':rows},ensure_ascii=False,indent=2))
        raise
    finally:
        await p.close()

if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('root',type=Path);ap.add_argument('prompt',type=Path);ap.add_argument('old',type=Path);ap.add_argument('--refresh',action='store_true');a=ap.parse_args()
    asyncio.run(run(a.root.resolve(),a.prompt,a.old,a.refresh))
