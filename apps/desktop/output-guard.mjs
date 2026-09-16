const guarded=new WeakSet();
/** A launcher may exit while the desktop remains open. A broken diagnostic pipe
 * is not a Core failure; never log back into that pipe from this handler.
 * Other stream failures still propagate, rather than hiding arbitrary exceptions. */
export function guardBrokenOutput(stream){
 if(!stream||guarded.has(stream))return;
 guarded.add(stream);
 stream.on('error',error=>{if(error?.code!=='EPIPE')throw error;});
}
guardBrokenOutput(process.stdout);
guardBrokenOutput(process.stderr);
