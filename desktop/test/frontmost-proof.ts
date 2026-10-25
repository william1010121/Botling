/** Pure evidence checks for the single authorized hidden probe. No native/app operations. */
export class FrontmostProof {
 readonly samples:{phase:string;startedAt:number;at:number;pid:number;bundleId:string}[]=[];
 readonly windows:{at:number;states:{id:number;visible:boolean;focused:boolean}[]}[]=[];
 baseline:string|undefined;
 constructor(readonly maxGapMs=750){}
 sample(value:string,phase:string,startedAt:number,at:number):void {
  const match=/^([1-9]\d*)\t([A-Za-z0-9][A-Za-z0-9_.-]*)$/.exec(value);
  if(!match)throw new Error('Missing frontmost PID/bundle metadata; fail closed');
  const previous=this.samples.at(-1);this.samples.push({phase,startedAt,at,pid:Number(match[1]),bundleId:match[2]});
  this.baseline??=value;
  if(value!==this.baseline)throw new Error('Observed frontmost PID/bundle changed; cause unassigned; fail closed');
  if(at-startedAt>this.maxGapMs||previous&&at-previous.at>this.maxGapMs)throw new Error('Frontmost sampling gap exceeded bound; proof unavailable');
 }
 window(at:number,states:{id:number;visible:boolean;focused:boolean}[],events:{event:string}[]):void {
  this.windows.push({at,states});
  if(states.some(window=>window.visible||window.focused)||events.some(event=>event.event==='show'||event.event==='focus'))throw new Error('Isolated test window showed/focused; fail closed');
 }
 complete():void {
  for(const phase of ['before','during','after'])if(this.samples.filter(sample=>sample.phase===phase).length<2)throw new Error('Missing bounded '+phase+' samples');
  if(this.windows.filter(snapshot=>snapshot.states.length>0).length<3)throw new Error('Insufficient actual native window-state samples');
 }
}
