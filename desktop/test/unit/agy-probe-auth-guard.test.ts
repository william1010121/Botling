import {expect,it} from 'vitest';
import {interactiveAuthGuard} from '../provider-validation/auth-guard';
it('does not infer login from OAuth/browser capability descriptions',()=>{
 const guard=interactiveAuthGuard();
 expect(guard('OAuth enabled; browser subagent disabled')).toBe(false);
 expect(guard('auth_uri=https://accounts.google.com/o/oauth2/v2/auth')).toBe(false);
 expect(guard('Access token expired. Refreshing silently...')).toBe(false);
});
it('stops on pinned interactive-auth notices even split across chunks',()=>{
 const guard=interactiveAuthGuard();expect(guard('Credentials missing or invalid. Launching bro')).toBe(false);
 expect(guard('wser login flow...')).toBe(true);
 expect(interactiveAuthGuard()('Open the following link to authenticate the ACP server:')).toBe(true);
 expect(interactiveAuthGuard()('Interactive login required.')).toBe(true);
});
