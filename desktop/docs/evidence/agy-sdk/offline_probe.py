import os,asyncio,socket,subprocess,json
os.environ.clear()
def forbidden(*a,**k):raise AssertionError('Network/process execution forbidden in offline probe')
socket.socket.connect=forbidden
socket.create_connection=forbidden
subprocess.Popen.__init__=forbidden
from google.antigravity import LocalAgentConfig,types
from google.antigravity.hooks import policy
from google.antigravity.models import GeminiAPIEndpoint
results=[]
async def main():
 entered=asyncio.Event();release=asyncio.Event()
 async def ask(tc):entered.set();await release.wait();return False
 hook=policy.enforce([policy.ask_user('*',handler=ask)])
 for name,server in [('view_file',None),('write_to_file',None),('run_command',None),('read_url',None),('delegate',None),('custom_tool',None),('unknown_future_tool',None),('execute','mcp-server')]:
  entered.clear();release.clear();t=asyncio.create_task(hook.run(None,types.ToolCall(name=name,args={},server_name=server)))
  await entered.wait();assert not t.done();release.set();assert (await t).allow is False
  results.append(name+': waits and refuses')
 async def broken(tc):raise RuntimeError('callback failure')
 assert not (await policy.enforce([policy.ask_user('*',handler=broken)]).run(None,types.ToolCall(name='write_to_file',args={}))).allow
 results.append('callback exception: denied')
 try:policy.enforce([policy.ask_user('*')]);raise AssertionError('accepted missing callback')
 except ValueError:results.append('missing callback: rejected')
 try:GeminiAPIEndpoint().validate_endpoint();raise AssertionError('accepted missing API key')
 except ValueError as e:results.append('no credentials: '+str(e))
 assert 'auth' not in LocalAgentConfig.model_fields
 results.append('LocalAgentConfig: no auth OAuth field')
 print(json.dumps({'sdk':'0.1.22','checks':results,'network_calls':0,'child_processes':0},indent=2))
asyncio.run(main())
