/** Connection-local bounded framing; no process, credentials, filesystem or network access. */
export class CodexFrameStream {
  #buffer=Buffer.alloc(0); #total=0; #frames=0; #closed=false;
  constructor(readonly onFrame:(frame:Uint8Array)=>void,readonly onEnd:()=>void,readonly onFault:()=>void){}
  #fail():never{if(!this.#closed){this.#closed=true;this.#buffer=Buffer.alloc(0);this.onFault();}throw Error('CODEX_STREAM_INVALID');}
  push(chunk:Uint8Array):void{
    if(this.#closed)throw Error('CODEX_STREAM_CLOSED');
    this.#total+=chunk.byteLength;if(this.#total>2*1024*1024)this.#fail();
    this.#buffer=Buffer.concat([this.#buffer,chunk]);
    for(let i;(i=this.#buffer.indexOf(10))>=0;){
      if(i>65536||++this.#frames>4096)this.#fail();
      const frame=this.#buffer.subarray(0,i);this.#buffer=this.#buffer.subarray(i+1);
      if(!frame.length)this.#fail();
      try{this.onFrame(frame);}catch{this.#fail();}
    }
    if(this.#buffer.length>65536)this.#fail();
  }
  finish():void{if(this.#closed)return;if(this.#buffer.length)this.#fail();this.#closed=true;this.onEnd();}
}
