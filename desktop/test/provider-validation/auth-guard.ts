/** Pinned ACP 1.4.3's interactive-login notices, not generic OAuth/browser logs.
 * Keep a bounded cross-chunk tail; never retain or return a URL or credential. */
export function interactiveAuthGuard() {
  let tail='';
  return (chunk:string):boolean=>{
    tail=(tail+chunk).slice(-8192);
    return tail.includes('Credentials missing or invalid. Launching browser login flow...')
      || tail.includes('Open the following link to authenticate the ACP server:')
      || tail.includes('Interactive login required.')
      || /https:\/\/accounts\.google\.com\/o\/oauth2\/[^\s]*[?&]client_id=/.test(tail);
  };
}
