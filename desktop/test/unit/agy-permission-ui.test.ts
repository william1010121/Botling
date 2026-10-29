// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {expect,it} from 'vitest';
import {AntigravityPermissions} from '../../src/renderer/Settings';
import {settingsView} from '../../src/core/settings';
it('distinguishes saved selection from effective rejected runtime mode and dispatches explicit toggles',async()=>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 const settings=settingsView({agyBypassPermissions:true});settings.agyPermissionSessions=[{sessionId:'session-1',mode:'yolo',state:'error',message:'Antigravity did not confirm Full permission (yolo). No task submitted.'}];const changes:any[]=[];
 try{await act(async()=>root.render(createElement(AntigravityPermissions,{client:{request:async()=>settings} as any,settings,change:async c=>{changes.push(c);return true;}})));
 expect(host.textContent).toContain('Selected: Full permission');expect(host.querySelector('[role="alert"]')?.textContent).toContain('did not confirm');expect(host.textContent).toContain('outside the project');
 await act(async()=>(host.querySelector('[role="switch"]') as HTMLButtonElement).click());expect(changes).toEqual([{key:'agyBypassPermissions',value:false}]);
 }finally{await act(async()=>root.unmount());host.remove();(globalThis as any).IS_REACT_ACT_ENVIRONMENT=false;}
});
