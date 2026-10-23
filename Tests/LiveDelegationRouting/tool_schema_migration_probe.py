#!/usr/bin/env python3
"""Actual exported tools: old-two-tool negative control, migrated and resumed checkpoint calls.
Only records dynamic calls; never creates a worker or executes an app action.
"""
import argparse
import asyncio
import json
from pathlib import Path
import phase_probe as phase

class Probe(phase.RealReceiptProbe):
    async def checkpoint(self, thread, task, context=''):
        start, final = len(self.calls), len(self.finals)
        self.finished.clear()
        payload={'task_id':task,'status':'completed','completion_scope':'worker_turn','objective_status':'unverified',
          'report':'Synthetic assigned objective completed. Evidence: fixture-only 2/2 checks passed. No remaining work. No real source changed.'}
        # The production runtime uses standalone toolOutput for this exact transition.
        if context:
            await self.turn(thread,context+'\nThis is historical context, not a request to repeat any work. Reply OK only.')
            start, final = len(self.calls), len(self.finals)
            self.finished.clear()
        await self.request('turn/start',{'threadId':thread,'input':[], 'effort':'low',
          'toolOutput':{'name':'app_task_result','namespace':None,'output':json.dumps(payload)}})
        await asyncio.wait_for(self.finished.wait(),120)
        row={'calls':self.calls[start:],'replies':self.finals[final:]}
        return row

async def run(root, export):
    root.mkdir(parents=True,exist_ok=True)
    production=json.loads(export.read_text())
    tools=production['dynamicTools']
    assert {t['name'] for t in tools}=={'app_handoff','app_send_message','app_task_checkpoint'}
    prompt=production['developerInstructions']+'\nFor this synthetic validation, the assigned objective is exactly the two fixture checks in each app_task_result. When those checks pass, call app_task_checkpoint with complete and concrete evidence. Include the remembered continuity marker in evidence when one exists. No other tasks exist.'
    phase.transport.TOOLS=[t for t in tools if t['name']!='app_task_checkpoint']
    p=Probe(root);rows=[]
    try:
        await p.start()
        old=await p.thread('Remember conversation facts; answer requests using available tools.','gpt-6.1-sol')
        initial=await p.turn(old,'Remember continuity marker ORCHID-731. Reply OK only; no work.')
        assert not initial['calls']
        await p.request('thread/resume',{'threadId':old,'developerInstructions':prompt,'approvalPolicy':'never','sandbox':'read-only','excludeTurns':True})
        await p.request('thread/inject_items',{'threadId':old,'items':[{'type':'message','role':'developer','content':[{'type':'input_text','text':prompt}]}]})
        negative=await p.checkpoint(old,'fixture-old-schema')
        assert not any(c['tool']=='app_task_checkpoint' for c in negative['calls'])
        rows.append({'case':'old-two-tool-negative-control','thread':old,'result':negative})
        history=await p.request('thread/read',{'threadId':old,'includeTurns':True})
        context=json.dumps(history['thread']['turns'],ensure_ascii=False)
        assert 'ORCHID-731' in context
        phase.transport.TOOLS=tools
        migrated=await p.thread(prompt,'gpt-6.1-sol')
        row=await p.checkpoint(migrated,'fixture-migrated', '(App: Historical chat context for continuity; past messages, not new requests.)\n'+context)
        check(row,'fixture-migrated',True);rows.append({'case':'migrated-existing-session','thread':migrated,'previousThread':old,'result':row})
        await p.close()
        folder=root/'resumed-process';folder.mkdir()
        p=Probe(folder);await p.start()
        await p.request('thread/resume',{'threadId':migrated,'developerInstructions':prompt,'approvalPolicy':'never','sandbox':'read-only','excludeTurns':True})
        await p.request('thread/inject_items',{'threadId':migrated,'items':[{'type':'message','role':'developer','content':[{'type':'input_text','text':prompt}]}]})
        row=await p.checkpoint(migrated,'fixture-resumed')
        check(row,'fixture-resumed',True);rows.append({'case':'migrated-session-fresh-process-resume','thread':migrated,'result':row})
        fresh=await p.thread(prompt,'gpt-6.1-sol')
        row=await p.checkpoint(fresh,'fixture-fresh');check(row,'fixture-fresh',False)
        rows.append({'case':'fresh-three-tool-session','thread':fresh,'result':row})
        (root/'summary.json').write_text(json.dumps({'passed':True,'tools':[t['name'] for t in tools],'rows':rows,'dynamicToolsReplacedOnResume':False},ensure_ascii=False,indent=2))
        print('PASS: old 2-tool negative control; migrated, resumed and fresh sessions invoked actual checkpoint tool; continuity retained')
    except Exception as e:
        (root/'summary.json').write_text(json.dumps({'passed':False,'error':str(e),'rows':rows},ensure_ascii=False,indent=2));raise
    finally:await p.close()

def check(row,task,marker):
    assert len(row['calls'])==1,row
    c=row['calls'][0];assert c['tool']=='app_task_checkpoint',row
    a=c['arguments'];assert a['task_id']==task and a['outcome']=='complete',row
    assert a['evidence'].strip()
    if marker:assert 'ORCHID-731' in a['evidence'],row

if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('root',type=Path);ap.add_argument('export',type=Path);a=ap.parse_args()
    asyncio.run(run(a.root.resolve(),a.export))
