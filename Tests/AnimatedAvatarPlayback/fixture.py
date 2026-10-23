"""Write synthetic chat state using the worktree's real packaged art (no live chat/model)."""
import base64,json,sys
from pathlib import Path
from urllib.parse import quote
repo=Path(sys.argv[1]).resolve();out=Path(sys.argv[2]).resolve();out.mkdir(parents=True,exist_ok=True)
art=repo/'Sources/ClaudeCodeBotCore/Resources/CharacterArt'
hat="<circle cx='32' cy='11' r='10' fill='#FF4B42'/><ellipse cx='32' cy='19' rx='13' ry='2.8' fill='#FF4B42'/><circle cx='29' cy='10' r='1.5'/><circle cx='35' cy='10' r='1.5'/>"
def data(svg):return 'data:image/svg+xml;charset=utf-8,'+quote(svg,safe='')
def svg(character,pose):
 png=base64.b64encode((art/f'avatars-static/{character}/{pose}.png').read_bytes()).decode()
 return data("<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64' viewBox='0 0 64 64'><image x='0' y='18' width='64' height='46' preserveAspectRatio='xMidYMax meet' href='data:image/png;base64,"+png+"'/>"+hat+"</svg>")
clips=json.loads((art/'animations.json').read_text());heads=[]
for engine,character in [('claude','claude'),('codex','gpt')]:
 selected=[]
 for item in clips:
  if item['engine']!=engine:continue
  item=dict(item);item['file']=(art/item['file']).as_uri();item['poster']=(art/item['poster']).as_uri();selected.append(item)
 heads.append(dict(engine=engine,avatar=svg(character,'idle'),thinking=svg(character,'thinking'),sleeping=svg(character,'sleepy'),hat=data("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>"+hat+"</svg>"),clips=selected))
def msg(id,head,text):return dict(id=id,role='bot',text=text,stamp=None,avatar=heads[head]['avatar'],choices=None,chosen=None,answer=None,open=False,attachments=None,replyTo=None,replyPreview=None,openable=False)
state=dict(botID='synthetic-animated-avatar',botName='Synthetic animation fixture',messages=[msg('claude',0,'合成驗收資料：這是 Claude 的角色頭像。'),msg('codex',1,'合成驗收資料：點選頭像可預覽全部 12 款動圖。')],working=True,avatar=heads[1]['avatar'],avatarMood='work',placeholder='合成資料，不連接模型',replyingTo=None,pendingFiles=[],components={},animatedHeads=heads,seenHeads=dict(C=heads[0]['avatar'],X=heads[1]['avatar']),lang='zh-Hant')
(out/'fixture.json').write_text(json.dumps(state,ensure_ascii=False))
print(out/'fixture.json')
