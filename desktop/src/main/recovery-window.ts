/** Recovery actions redraw a document, never replace its native window or test page. */
export class RecoveryWindowHost<T extends {isDestroyed():boolean}> {
 private current:T|undefined;
 get(create:()=>T):T {if(!this.current||this.current.isDestroyed())this.current=create();return this.current;}
}
