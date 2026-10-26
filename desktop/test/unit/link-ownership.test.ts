import {afterEach,expect,it} from 'vitest';
import {mkdirSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {CoreHarness,MAIN} from '../core-harness';
import {tempDir,swiftLine} from '../helpers';
const running:CoreHarness[]=[];
afterEach(async()=>{for(const c of running.splice(0))await c.kill();});
const GUEST='DEC0DE00-0000-4000-8000-00000000DEC0';
it('D8 component authority excludes guest replies and echoed user notices while retaining own bot links',async()=>{
 const data=tempDir('link-ownership');mkdirSync(join(data,'main'));
 const lines=[swiftLine({id:randomUUID(),role:'bot',text:'[own](https://example.org/own)'}),swiftLine({id:randomUUID(),role:'bot',sourceID:GUEST,text:'[guest](https://example.org/guest)'}),swiftLine({id:randomUUID(),role:'notice',text:'Called into another chat: [user echo](file:///synthetic-user-secret.txt)'})];
 writeFileSync(join(data,'main/chat.json'),JSON.stringify(lines));const c=new CoreHarness(data);running.push(c);
 expect((await c.call({type:'link.authorize',botId:MAIN,url:'https://example.org/own'})).linked).toBe(true);
 const guest=await c.call({type:'link.authorize',botId:MAIN,url:'https://example.org/guest'}),notice=await c.call({type:'link.authorize',botId:MAIN,url:'file:///synthetic-user-secret.txt'});
 expect({guestLinked:guest.linked,notice}).toEqual({guestLinked:false,notice:{result:false,linked:false}});
});

it('D8 a guest component inherits exactly its reply author and cannot borrow the host or another guest',async()=>{
 const data=tempDir('link-context');mkdirSync(join(data,'main'));const id=randomUUID(),other='12345678-1234-4123-8123-123456789ABC';
 const lines=[swiftLine({id:randomUUID(),role:'bot',text:'[host](https://example.org/host)'}),swiftLine({id,role:'bot',sourceID:GUEST,text:'[guest](https://example.org/guest)',displays:[{name:'probe',data:'{}'}]}),swiftLine({id:randomUUID(),role:'bot',sourceID:other,text:'[other](file:///other-guest.txt)'}),swiftLine({id:randomUUID(),role:'user',sourceID:GUEST,text:'[user](https://example.org/user)'})];
 writeFileSync(join(data,'main/chat.json'),JSON.stringify(lines));const c=new CoreHarness(data);running.push(c);
 const access=(url:string,messageId:string=id)=>c.call({type:'link.authorize',botId:MAIN,url,messageId});
 expect(await access('https://example.org/guest')).toEqual({result:true,linked:true});
 expect(await access('https://example.org/host')).toEqual({result:true,linked:false});
 expect(await access('file:///other-guest.txt')).toEqual({result:true,linked:false});
 expect(await access('https://example.org/user')).toEqual({result:false,linked:false});
 expect(await access('https://example.org/guest',String(lines[3].id))).toEqual({result:false,linked:false});
});

it('D8 generated preview reply context keeps its own author authority without stored displays',async()=>{
 const data=tempDir('link-auto-preview');mkdirSync(join(data,'main'));const host=randomUUID(),guest=randomUUID(),url='file:///synthetic/artifacts/generated.html';
 writeFileSync(join(data,'main/chat.json'),JSON.stringify([swiftLine({id:host,role:'bot',text:`[report](${url})`}),swiftLine({id:guest,role:'bot',sourceID:GUEST,text:'[guest](https://example.org/guest-auto)'})]));
 const c=new CoreHarness(data);running.push(c);
 expect(await c.call({type:'link.authorize',botId:MAIN,url,messageId:host})).toEqual({result:true,linked:true});
 expect(await c.call({type:'link.authorize',botId:MAIN,url,messageId:guest})).toEqual({result:true,linked:false});
});

it('E2 user links include group guest/notice lines while components retain exact authorship',async()=>{
 const data=tempDir('e2-group-links'),group=randomUUID().toUpperCase(),guestId=randomUUID(),hostId=randomUUID(),noticeId=randomUUID();mkdirSync(join(data,'groups',group),{recursive:true});writeFileSync(join(data,'groups.json'),JSON.stringify([{id:group,name:'Synthetic group',members:[MAIN,GUEST]}]));
 writeFileSync(join(data,'groups',group,'chat.json'),JSON.stringify([swiftLine({id:guestId,role:'bot',sourceID:GUEST,text:'[guest](file:///guest-group.html)'}),swiftLine({id:hostId,role:'bot',sourceID:MAIN,text:'[main](https://example.org/main-group)'}),swiftLine({id:noticeId,role:'notice',text:'Called into another chat: [notice](file:///notice-group.txt)'}),swiftLine({id:randomUUID(),role:'user',text:'[private](file:///user-private.txt)'})]));
 const c=new CoreHarness(data);running.push(c);
 expect((await c.call({type:'link.authorize',source:'user',botId:group,url:'file:///guest-group.html'})).linked).toBe(true);
 expect((await c.call({type:'link.authorize',source:'user',botId:group,url:'file:///notice-group.txt'})).linked).toBe(true);
 expect((await c.call({type:'link.authorize',source:'user',botId:group,url:'file:///user-private.txt'})).linked).toBe(false);
 expect((await c.call({type:'link.authorize',botId:group,url:'file:///notice-group.txt',messageId:guestId})).linked).toBe(false);
 expect((await c.call({type:'link.authorize',botId:group,url:'https://example.org/main-group',messageId:guestId})).linked).toBe(false);
 expect((await c.call({type:'link.authorize',botId:group,url:'file:///guest-group.html',messageId:guestId})).linked).toBe(true);
});

it('F6 legacy pins inherit their pin bot author without borrowing guest links',async()=>{
 const data=tempDir('legacy-pin'),pin=randomUUID().toUpperCase();mkdirSync(join(data,'main'));writeFileSync(join(data,'main/pins.json'),JSON.stringify([{id:pin,name:'todo',data:'{}',refresh:'manual',minutes:15,size:'2x2',makingLive:false}]));writeFileSync(join(data,'main/chat.json'),JSON.stringify([swiftLine({id:randomUUID(),role:'bot',text:'[own](https://example.org/pin-own)'}),swiftLine({id:randomUUID(),role:'bot',sourceID:GUEST,text:'[guest](https://example.org/pin-guest)'})]));const c=new CoreHarness(data);running.push(c);
 expect((await c.call({type:'link.authorize',botId:MAIN,pinId:pin,url:'https://example.org/pin-own'})).linked).toBe(true);expect((await c.call({type:'link.authorize',botId:MAIN,pinId:pin,url:'https://example.org/pin-guest'})).linked).toBe(false);
});

it('chat attachments (a relay line, your own line) open for a user click, never for a component or a file the chat does not name',async()=>{
 // A Catch-up summary's "Links & artifacts" lists a line's attachments, not only the links in its words.
 const data=tempDir('link-attachments');mkdirSync(join(data,'main'));
 const relayed='file:///synthetic/attachments/20261026-162932-20261026-162932-BF1F37-agent-activity.png',mine='file:///synthetic/attachments/20261026-170000-notes.txt';
 writeFileSync(join(data,'main/chat.json'),JSON.stringify([swiftLine({id:randomUUID(),role:'relay',text:'A component report',attachments:[{url:relayed,kind:'image'}]}),swiftLine({id:randomUUID(),role:'user',text:'see this',attachments:[{url:mine,kind:'file'}]})]));
 const c=new CoreHarness(data);running.push(c);
 expect((await c.call({type:'link.authorize',source:'user',botId:MAIN,url:relayed})).linked).toBe(true);
 expect((await c.call({type:'link.authorize',source:'user',botId:MAIN,url:mine})).linked).toBe(true);
 expect((await c.call({type:'link.authorize',source:'user',botId:MAIN,url:'file:///synthetic/attachments/other.png'})).linked).toBe(false);
 expect((await c.call({type:'link.authorize',source:'component',botId:MAIN,url:mine})).linked).toBe(false);
});
