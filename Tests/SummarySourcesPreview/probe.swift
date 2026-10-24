// Synthetic production WKWebView acceptance. Records bridge actions; never executes them.
import AppKit
import WebKit
@MainActor final class Probe:NSObject,WKNavigationDelegate,WKScriptMessageHandler {
 var loaded=false;var actions=[[String:Any]]();var imageAudits=[[String:Any]]();let web:WKWebView;let window:NSWindow
 override init(){let config=WKWebViewConfiguration();config.websiteDataStore = .nonPersistent();web=WKWebView(frame:NSRect(x:0,y:0,width:760,height:900),configuration:config);window=NSWindow(contentRect:web.frame,styleMask:.borderless,backing:.buffered,defer:false);super.init();config.userContentController.add(self,name:"ccb");let audit=WKContentWorld.world(name:"sourceImageAudit");config.userContentController.add(self,contentWorld:audit,name:"sourceImageAudit");config.userContentController.addUserScript(WKUserScript(source:"const auditSourceImages=async()=>{await Promise.all([...document.images].map(i=>i.decode().catch(()=>{})));webkit.messageHandlers.sourceImageAudit.postMessage({static:!!document.querySelector('meta[http-equiv=Content-Security-Policy]'),images:[...document.images].map(i=>({complete:i.complete,width:i.naturalWidth}))})};if(document.readyState==='complete')auditSourceImages();else window.addEventListener('load',auditSourceImages);",injectionTime:.atDocumentEnd,forMainFrameOnly:false,in:audit));web.navigationDelegate=self;window.contentView=web;window.setFrameOrigin(NSPoint(x:-30000,y:-30000));window.alphaValue=0}
 func webView(_ webView:WKWebView,didFinish navigation:WKNavigation!){loaded=true}
 // WK refuses even isolated-world evaluation inside sandbox="". Decode each exact srcdoc
 // in a secondary nonpersistent WK view instead; production sandbox is never relaxed.
 func auditStaticFrames()async throws{
  let pages=try await js("[...document.querySelectorAll('.source-static-frame')].map(f=>f.srcdoc)") as! [String]
  for page in pages{
   let config=WKWebViewConfiguration();config.websiteDataStore = .nonPersistent()
   let copy=WKWebView(frame:NSRect(x:0,y:0,width:600,height:900),configuration:config)
   copy.loadHTMLString(page,baseURL:nil)
   var value:[String:Any]?
   for _ in 0..<100{
    try await Task.sleep(for:.milliseconds(50))
    if let result=try? await copy.callAsyncJavaScript("await Promise.all([...document.images].map(i=>i.decode().catch(()=>{})));return {static:document.querySelector('meta[http-equiv=\"Content-Security-Policy\"]')?.content.includes(\"script-src 'none'\")===true,images:[...document.images].map(i=>({complete:i.complete,width:i.naturalWidth}))}",arguments:[:],in:nil,contentWorld:WKContentWorld.world(name:"sourceImageAudit")) as? [String:Any],result["static"] as? Bool == true,!(result["images"] as? [[String:Any]] ?? []).isEmpty{value=result;break}
   }
   guard var value else{throw NSError(domain:"Exact static srcdoc image decode unavailable",code:10)}
   value["method"]="byte-identical srcdoc in secondary nonpersistent WKWebView; production sandbox unchanged"
   imageAudits.append(value)
  }
 }
 func userContentController(_ userContentController:WKUserContentController,didReceive message:WKScriptMessage){if let value=message.body as? [String:Any]{if message.name=="sourceImageAudit"{imageAudits.append(value)}else{actions.append(value)}}}
 func js(_ source:String)async throws->Any{try await web.evaluateJavaScript(source)}
 func wait(_ condition:String)async throws{for _ in 0..<100 {if try await js(condition) as? Bool == true{return};try await Task.sleep(for:.milliseconds(50))};throw NSError(domain:"Timed out: \(condition)",code:1)}
 func shot(_ name:String,_ output:URL)async throws{try await Task.sleep(for:.milliseconds(80));let image=try await web.takeSnapshot(configuration:nil);try NSBitmapImageRep(data:image.tiffRepresentation!)!.representation(using:.png,properties:[:])!.write(to:output.appending(path:name+".png"))}
 func run(_ repo:URL,_ output:URL)async throws{
  try FileManager.default.createDirectory(at:output,withIntermediateDirectories:true)
  web.loadFileURL(repo.appending(path:"Sources/ClaudeCodeBot/Resources/web/chat.html"),allowingReadAccessTo:repo)
  for _ in 0..<100 where !loaded {try await Task.sleep(for:.milliseconds(50))};guard loaded else{throw NSError(domain:"load",code:1)}
  _=try await js(String(contentsOf:repo.appending(path:"Tests/SummarySourcesPreview/fixture.js"),encoding:.utf8))
  try await wait("document.querySelector('iframe.component-frame')?.style.height !== ''")
  // Wait until the real frame has produced its unique init action before folding it.
  for _ in 0..<100 where !actions.contains(where:{$0["type"] as? String == "sourceAudit"}){try await Task.sleep(for:.milliseconds(50))}
  guard actions.contains(where:{$0["type"] as? String == "sourceAudit"}) else{throw NSError(domain:"Original live card did not initialize",code:2)}
  let interval=CommandLine.arguments.contains("--interval")
  let automatic=CommandLine.arguments.contains("--auto")
  _=try await js("window.originalFrame=document.querySelector('iframe.component-frame');window.originalMessages=JSON.stringify(fixture.messages);window.originalRows=[...document.querySelectorAll('#messages>[data-id],#messages>.stamped')];if(\(interval)){summary.manual=true;summary.automatic=\(automatic);summary.speakerCounts={claude:1,codex:2};fixture.intervalSummaries=[summary]}else{fixture.catchUp=summary};ccb.setState(fixture);true")
  let baseline=actions.count;var results=[[String:Any]]()
  for width in [760,360]{
   web.setFrameSize(NSSize(width:width,height:900));window.setContentSize(web.frame.size)
   try await wait("innerWidth==\(width) && matchMedia('(max-width:480px)').matches==\(width<=480 ? "true":"false")")
   for phase in ["ready","loading","failed"]{
    _=try await js("summary.state='\(phase)';summary.error='Synthetic offline';ccb.setState(fixture);true")
    try await wait("[...document.images].filter(i=>i.getBoundingClientRect().width).every(i=>i.complete&&i.naturalWidth>0)")
    let cardFits=try await js("(()=>{const card=document.querySelector('.catchup-card-body').getBoundingClientRect();return [...document.querySelectorAll('.catchup-top>* , .catchup-foot button')].filter(e=>e.getBoundingClientRect().width).every(e=>{const r=e.getBoundingClientRect();return r.left>=card.left&&r.right<=card.right})})()") as? Bool
    guard cardFits==true else{throw NSError(domain:"Summary header/footer clipped at \(width) / \(phase)",code:8)}

    try await shot("\(phase)-\(width)",output)
   }
   _=try await js("summary.state='ready';ccb.setState(fixture);document.querySelector('[data-action=toggle]').click();true")
   try await wait("!!document.querySelector('.source-static-frame') && [...document.querySelectorAll('.source-static-frame')].every(f=>f.dataset.loaded==='true')")
   try await wait("[...document.querySelectorAll('.source-body img')].every(i=>i.complete&&i.naturalWidth>0)")
   try await auditStaticFrames()
   let initial=try await js("({width:innerWidth,headerText:document.querySelector('.source-header').textContent,originalFramePreserved:originalFrame===document.querySelector('#messages iframe.component-frame'),messagesPreserved:originalMessages===JSON.stringify(fixture.messages),rowsPreserved:originalRows.every((row,index)=>row===[...document.querySelectorAll('#messages>[data-id],#messages>.stamped')][index]),originalsFolded:[...document.querySelectorAll('#messages .catchup-folded')].length,sourceIDs:[...document.querySelectorAll('[data-source-id]')].map(e=>e.dataset.sourceId),staticFrames:[...document.querySelectorAll('.source-static-frame')].map(f=>({sandbox:f.getAttribute('sandbox'),scripts:f.srcdoc.includes('<script'),checked:f.srcdoc.includes('checked'),hasNote:f.srcdoc.includes('Original persisted note'),hasCSP:f.srcdoc.includes(\"script-src 'none'\")})),images:[...document.querySelectorAll('.source-body img')].map(i=>({complete:i.complete,width:i.naturalWidth})),overflow:document.documentElement.scrollWidth>innerWidth,dialogOverflow:document.querySelector('dialog').scrollWidth>document.querySelector('dialog').clientWidth})") as! [String:Any]
   guard initial["originalFramePreserved"] as? Bool == true,initial["messagesPreserved"] as? Bool == true,initial["rowsPreserved"] as? Bool == true,initial["originalsFolded"] as? Int == 3,initial["overflow"] as? Bool == false,initial["dialogOverflow"] as? Bool == false else{throw NSError(domain:"DOM failed: \(initial)",code:3)}
   results.append(initial);try await shot("originals-\(width)",output)
   _=try await js("document.querySelector('.source-body img.media').click();true")
   try await wait("!!document.querySelector('dialog .lightbox') && document.querySelector('.lightbox-image').complete && document.querySelector('.lightbox-image').naturalWidth>0")
   _=try await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));true")
   guard try await js("!!document.querySelector('dialog')&&!document.querySelector('.lightbox')") as? Bool == true else{print("Image close state",try await js("({dialog:!!document.querySelector('dialog'),lightboxes:document.querySelectorAll('.lightbox').length,body:document.body.innerHTML.slice(-800)})"));throw NSError(domain:"Image preview close lost modal",code:7)}
   _=try await js("document.querySelector('[data-source-close]').click();document.querySelector('[data-cite-point=\"0\"]').click();true")
   try await wait("document.querySelector('mark')?.textContent==='Wait for signing.'")
   try await shot("answer-citation-\(width)",output)
   _=try await js("document.querySelector('[data-source-close]').click();document.querySelector('[data-cite-point=\"1\"]').click();true")
   try await wait("document.querySelector('mark')?.textContent==='the exact original sentence'")
   _=try await js("document.querySelector('[data-source-next]').click();true")
   try await wait("document.querySelector('[data-source-id=b]')?.classList.contains('cited')===true && !!document.querySelector('.source-static-frame') && [...document.querySelectorAll('.source-static-frame')].every(f=>f.dataset.loaded==='true')")
   try await shot("card-citation-\(width)",output)
   _=try await js("document.querySelector('[data-source-prev]').click();true")
   try await wait("document.querySelector('[data-source-id=a]')?.classList.contains('cited')===true && document.querySelector('mark')?.textContent==='the exact original sentence'")
   guard try await js("document.querySelector('[data-source-prev]').disabled && !document.querySelector('[data-source-next]').disabled") as? Bool == true else{throw NSError(domain:"Previous source navigation failed",code:9)}
   _=try await js("document.querySelector('[data-source-close]').click();document.querySelector('[data-cite-point=\"2\"]').click();true")
   try await wait("!!document.querySelector('.source-whole')")
   try await wait("[...document.querySelectorAll('.source-static-frame')].every(f=>f.dataset.loaded==='true')")
   try await shot("unanswered-\(width)",output)
   _=try await js("document.querySelector('[data-source-id=c] .source-whole').click();true")
   try await shot("whole-card-\(width)",output)
   _=try await js("document.querySelector('[data-source-close]').click();true")
  }
  let staticAudits=imageAudits.filter{$0["static"] as? Bool == true && ($0["images"] as? [[String:Any]] ?? []).count > 0}
  guard !staticAudits.isEmpty,staticAudits.allSatisfy({audit in (audit["images"] as? [[String:Any]] ?? []).allSatisfy{($0["complete"] as? Bool)==true && ($0["width"] as? Int ?? 0)>0}}) else{throw NSError(domain:"Static frame images failed decode: \(staticAudits)",code:6)}
  guard actions.count==baseline else{throw NSError(domain:"Viewer emitted unexpected actions: \(actions)",code:4)}
  _=try await js("document.querySelector('[data-cite-point=\"2\"]').click();document.querySelector('.source-answer-in-chat').click();true")
  let returned=try await js("!document.querySelector('dialog')&&!document.querySelector('#messages [data-id=c]').classList.contains('catchup-folded')&&document.querySelector('#messages [data-id=c]').classList.contains('source-live-flash')&&originalFrame===document.querySelector('#messages iframe.component-frame')") as? Bool
  guard returned==true else{throw NSError(domain:"Return to actual live card failed",code:5)}
  try await shot("answer-in-chat-360",output)
  try JSONSerialization.data(withJSONObject:["results":results,"bridgeBefore":baseline,"bridgeAfter":actions.count,"answerInChat":returned==true,"staticImageAudits":staticAudits],options:[.prettyPrinted,.sortedKeys]).write(to:output.appending(path:"verification.json"))
  print("PASS: production WK760/360; loading/ready/failed/originals/citations/read-only cards; no extra bridge actions; originals preserved; Answer in chat locates live card")
 }
}
@main struct Main{@MainActor static func main(){NSApplication.shared.setActivationPolicy(.prohibited);let probe=Probe();Task{@MainActor in do{try await probe.run(URL(filePath:CommandLine.arguments[1]),URL(filePath:CommandLine.arguments[2]));exit(0)}catch{print("FAIL",error);exit(1)}};NSApplication.shared.run()}}
