import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
/** Read a regular file without allocating based on a concurrently growing file. */
export async function boundedFile(file:string,maximum=5*1024*1024):Promise<Buffer>{
  // A FIFO must not wait for a writer before fstat can reject non-regular files.
  const handle=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
  try{
    const before=await handle.stat();if(!before.isFile()||before.size>maximum)throw new Error('File exceeds the safe preview limit.');
    const buffer=Buffer.alloc(Math.min(maximum+1,before.size+1));let count=0;
    while(count<buffer.length){const read=await handle.read(buffer,count,buffer.length-count,count);if(!read.bytesRead)break;count+=read.bytesRead;}
    const after=await handle.stat();
    if(count!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs)throw new Error('File changed during preview.');
    return buffer.subarray(0,count);
  }finally{await handle.close();}
}
