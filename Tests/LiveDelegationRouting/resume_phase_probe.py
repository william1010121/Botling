#!/usr/bin/env python3
"""One real resume regression: persisted tool descriptions, refreshed developer prompt, no worker execution."""
import argparse
import asyncio
import json
from pathlib import Path
import phase_probe as phase


async def run(root, before, after, model):
    root.mkdir(parents=True,exist_ok=True)
    phase.transport.TOOLS = phase.EFFECTIVE['tools']
    p = phase.RealReceiptProbe(root)
    try:
        await p.start()
        thread = await p.thread(before.read_text(), model)
        initial = await p.turn(thread, '只回答 OK，不啟動任何工作。')
        assert not initial['calls']
        (root/'initial-turn.json').write_text(json.dumps(initial,ensure_ascii=False,indent=2))
        await p.close()
        resumed = root/'resumed-server'
        resumed.mkdir(exist_ok=True)
        p = phase.RealReceiptProbe(resumed)
        await p.start()
        params = {'threadId':thread,'cwd':str(root),'developerInstructions':after.read_text(),
                  'approvalPolicy':'never','sandbox':'read-only','excludeTurns':True}
        (root/'resume-params.json').write_text(json.dumps(params,indent=2))
        # No dynamicTools on resume: existing descriptions are intentionally preserved.
        await p.request('thread/resume',params)
        row = await p.turn(thread,phase.REGISTRY+'\nUser: 另開 worker 僅研究快捷鍵設定，不實作，等我明確授權；main.ts 即使釋放也先停在研究階段。')
        error = None
        try:
            assert len(row['calls']) == 1
            phase.research_payload(row['calls'][0])
        except (AssertionError, KeyError, ValueError) as e:
            error = str(e)
        summary = {'passed':error is None,'error':error,'model':model,'dynamicToolsReplaced':False,'result':row}
        (root/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2))
        print(json.dumps({'passed':summary['passed'],'error':error},indent=2))
        return summary['passed']
    finally: await p.close()


if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('folder',type=Path)
    parser.add_argument('before',type=Path)
    parser.add_argument('after',type=Path)
    parser.add_argument('--model',default='gpt-6.1-sol')
    args=parser.parse_args()
    raise SystemExit(0 if asyncio.run(run(args.folder.resolve(),args.before,args.after,args.model)) else 1)
