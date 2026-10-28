// Operational background mode, also honored by packaged binaries. It grants no test/IPC authority.
export const hidden = process.env.BOTLING_HIDDEN === '1';
export function configureHiddenApp(app:{isReady():boolean;setActivationPolicy(policy:'prohibited'):void},platform=process.platform,enabled=hidden||process.argv.includes('--component-shot')||process.argv.includes('--check-plugin')||process.argv.includes('--render-report')):void {
 if(!enabled||platform!=='darwin')return;
 if(app.isReady())throw new Error('Background activation policy must be installed before ready');
 app.setActivationPolicy('prohibited');
}
