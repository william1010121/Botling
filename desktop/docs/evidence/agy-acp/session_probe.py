"""Bounded official-server initialize/session-new probe; NEVER authenticates or prompts.
Usage: python3 session_probe.py /path/to/agy_acp_server.par
Uses the real HOME solely for the server's existing-auth selection. Stops on an
error and terminates its process group. Not a native tool execution test.
"""
import subprocess,json,pathlib,selectors,time,os,signal,tempfile,sys,hashlib
binary=pathlib.Path(sys.argv[1]).resolve()
assert hashlib.sha256(binary.read_bytes()).hexdigest()=='1251927db3e21f3d693fd042d6890d82f65eb00587e97f1f3d8f0d798e7f0954'
root=pathlib.Path(tempfile.mkdtemp(prefix='botling-acp-probe-'))
workspace=tempfile.mkdtemp(prefix='acp-handshake-',dir=root)
env={k:os.environ[k] for k in ['HOME','PATH','USER','TMPDIR'] if k in os.environ}
p=subprocess.Popen([str(binary)],cwd=workspace,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
sel=selectors.DefaultSelector();sel.register(p.stdout,selectors.EVENT_READ);stderr=[]
try:
 req={'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':1,'clientCapabilities':{},'clientInfo':{'name':'botling-feasibility','version':'0'}}};p.stdin.write(json.dumps(req)+'\n');p.stdin.flush()
 deadline=time.monotonic()+25
 while time.monotonic()<deadline:
  ready=sel.select(1)
  if ready:
   line=p.stdout.readline()
   if not line:break
   data=json.loads(line);print(json.dumps(data,ensure_ascii=False));(root/('initialize.json' if data.get('id')==1 else 'session-new.json')).write_text(json.dumps(data,indent=2))
   if data.get('id')==1:
    p.stdin.write(json.dumps({'jsonrpc':'2.0','id':2,'method':'session/new','params':{'cwd':workspace,'mcpServers':[]}})+'\n');p.stdin.flush()
   elif data.get('id')==2:break
   elif 'id' in data:
    p.stdin.write(json.dumps({'jsonrpc':'2.0','id':data['id'],'error':{'code':-32601,'message':'Probe refuses client actions'}})+'\n');p.stdin.flush()
finally:
 try:os.killpg(p.pid,signal.SIGTERM)
 except ProcessLookupError:pass
 try:p.wait(timeout=3)
 except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()
 print('process exited',p.returncode)
