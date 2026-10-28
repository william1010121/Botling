"""Offline check of the signed 1.4.3 artifact's embedded permission handler.
Usage: python3 offline_permission_probe.py /path/to/agy_acp_server.par
This exercises the handler with synthetic ACP peers, not native tool dispatch.
No credential, network or agent execution is performed.
"""
import ast,asyncio,hashlib,json,pathlib,socket,subprocess,sys,textwrap,time,uuid
from types import SimpleNamespace as NS
from collections.abc import Mapping

def forbidden(*args,**kwargs):
    raise AssertionError('No networking or child processes in this probe')
socket.socket.connect=forbidden
socket.create_connection=forbidden
subprocess.Popen.__init__=forbidden
payload=pathlib.Path(sys.argv[1]).read_bytes()
assert hashlib.sha256(payload).hexdigest()=='1251927db3e21f3d693fd042d6890d82f65eb00587e97f1f3d8f0d798e7f0954'
start=payload.index(b'  async def _permission_handler(')
end=payload.index(b'\n  async def ',start+30)
parsed=ast.parse(textwrap.dedent(payload[start:end].decode()))
handler=ast.Module(body=[parsed.body[0]],type_ignores=[])
class AllowedOutcome(NS):pass
scope=dict(sdk_types_module=NS(ToolCall=NS),schema=NS(AllowedOutcome=AllowedOutcome,PermissionOption=NS,ToolCallUpdate=NS,ToolCallStart=NS),
    _tool_call_name=lambda tc:tc.name,_call_accesses_outside_workspace=lambda *args:False,
    _allow_always_signature=lambda *args:None,_unwrap_mcp_tool_call=lambda name,args,**kw:(name,args,None),
    _extract_tool_display_title=lambda name,*a,**kw:name,_infer_tool_kind=lambda *a,**kw:'other',
    _extract_tool_locations=lambda *a,**kw:[],_extract_tool_content=lambda *a,**kw:[],
    _is_high_risk_tool=lambda name:False,_AUTO_EDIT_TOOLS={'write_to_file'},_EXEC_TOOLS={'run_command','shell'},_WEB_TOOLS={'read_url'},
    time=time,uuid=uuid,Mapping=Mapping)
exec(compile(handler,'signed-1.4.3:_permission_handler','exec'),scope)
checks=[]
async def check(name,outcome):
    entered=asyncio.Event();release=asyncio.Event();rejected=[]
    async def update(**kwargs):pass
    async def request(**kwargs):entered.set();await release.wait();return NS(outcome=outcome)
    async def reject(*args):rejected.append(args)
    owner=NS(_sessions={'s':NS(mode_id='default',pending_permission_frames={},mcp_frames={})},
        _client=NS(session_update=update,request_permission=request),_allowed_tool_calls_by_session_id={},
        _latest_request_ids={},_telemetry_dispatcher=None,_next_interaction_tool_index=lambda *a:0,
        _session_workspace_roots=lambda *a:[],_reject_tool_call=reject)
    for attr in ['_admin_file_access_always_ask','_admin_file_access_deny','_admin_terminal_requires_review','_admin_terminal_auto_proceed','_terminal_sandbox_auto_proceed']:
        setattr(owner,attr,lambda:False)
    t=asyncio.create_task(scope['_permission_handler'](owner,'s',NS(name=name,args={},id='call',server_name=None)))
    await asyncio.wait_for(entered.wait(),1);assert not t.done();release.set()
    assert await t is False;assert len(rejected)==1
    checks.append(name+': pending until reply, then refused')
async def main():
    for name in ['run_command','write_to_file','start_subagent','mcp_tool']:
        await check(name,AllowedOutcome(option_id='deny'))
        await check(name,NS(outcome='cancelled'))
    print(json.dumps({'artifact':'antigravity-acp 1.4.3','handler_byte_offset':start,'checks':checks,
      'coverage':'handler only; helpers/peer synthetic; no native dispatch, auth, MCP or subagent execution'},indent=2))
asyncio.run(main())
