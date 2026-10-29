/** Token coloring is deliberately small and language-neutral. All file content stays text nodes. */
export function renderFilePreview(parent: HTMLElement, text: string): void {
 const tokens = /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\b(const|let|var|function|class|return|import|from|export|if|else|async|await|def|fn|pub|struct|true|false|null|nil|None)\b|\b(\d+(?:\.\d+)?)\b/g;
 let offset=0;
 for(const match of text.matchAll(tokens)) {
  parent.append(document.createTextNode(text.slice(offset,match.index)));
  const token=document.createElement('span');token.className=match[1]?'file-comment':match[2]?'file-string':match[3]?'file-keyword':'file-number';token.textContent=match[0];parent.append(token);offset=match.index!+match[0].length;
 }
 parent.append(document.createTextNode(text.slice(offset)));
}
export function fileReference(path: string, url: string): string {
 // The core supplies canonical URLs; Markdown labels must not introduce links or directives.
 return `[${path.replace(/[\\\[\]]/g,'\\$&').replace(/[\r\n]/g,' ')}](${url.replace(/[()]/g,c=>c==='('?'%28':'%29')}) `;
}
export function emphasizePath(parent: HTMLElement, path: string, query: string): void {
 let index=0; query=query.trim().toLowerCase();
 for(const char of path){if(index<query.length&&char.toLowerCase()===query[index]){const mark=document.createElement('mark');mark.textContent=char;parent.append(mark);index++;}else parent.append(document.createTextNode(char));}
}
