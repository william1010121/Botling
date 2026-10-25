/** Match the exact isolated chat realm/path; the diagnostic query does not change its identity. */
export function isChatURL(value:string):boolean {
 try{const url=new URL(value);return url.protocol==='botling-chat:'&&url.host==='chat'&&!url.username&&!url.password&&url.pathname==='/chat.html';}catch{return false;}
}
