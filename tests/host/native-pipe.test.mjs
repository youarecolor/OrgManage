import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {NativePipeConnection} from '../../dist/host/src/native-pipe.js';
test('real Windows pipe client verifies server PID/generation and carries exact UTF-8 frames',{skip:process.platform!=='win32',timeout:15000},async t=>{
 const sessionId=randomBytes(32).toString('hex'),sockets=[],requests=[];
 const server=createServer(socket=>{sockets.push(socket);let pending=Buffer.alloc(0);socket.on('error',()=>{});socket.on('data',bytes=>{pending=Buffer.concat([pending,bytes]);while(pending.length>=4&&pending.length>=4+pending.readUInt32LE(0)){const n=pending.readUInt32LE(0);const request=JSON.parse(pending.subarray(4,4+n).toString());pending=pending.subarray(4+n);requests.push(request);const body=Buffer.from(JSON.stringify({sessionId,sequence:request.sequence,frames:['日本語の応答'],closed:false})),head=Buffer.alloc(4);head.writeUInt32LE(body.length);socket.write(Buffer.concat([head,body]));}});});
 server.listen('\\\\.\\pipe\\OrgManage-Native-'+sessionId);await once(server,'listening');t.after(()=>{for(const s of sockets)s.destroy();server.close();});
 const {stdout}=await promisify(execFile)('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoProfile','-Command',`(Get-Process -Id ${process.pid}).StartTime.ToUniversalTime().Ticks`],{windowsHide:true,timeout:5000});
 const connection=await NativePipeConnection.open({sessionId,processId:process.pid,processStartTicks:stdout.trim()});t.after(()=>connection.disconnect());
 const result=await connection.exchange({sessionId,sequence:1,operation:'write',frame:JSON.stringify({text:'日本語の固定試験'})});assert.deepEqual(result.frames,['日本語の応答']);assert.equal(JSON.parse(requests[0].frame).text,'日本語の固定試験');
 const exited=once(connection.child,'close');connection.disconnect();await exited;assert.equal(connection.child.exitCode,0);
});
test('real Windows pipe rejects the wrong server generation before any request',{skip:process.platform!=='win32',timeout:15000},async t=>{
 const sessionId=randomBytes(32).toString('hex'),sockets=[];let bytes=0;
 const server=createServer(s=>{sockets.push(s);s.on('data',b=>bytes+=b.length);s.on('error',()=>{});});server.listen('\\\\.\\pipe\\OrgManage-Native-'+sessionId);await once(server,'listening');t.after(()=>{for(const s of sockets)s.destroy();server.close();});
 await assert.rejects(NativePipeConnection.open({sessionId,processId:process.pid,processStartTicks:'100000000000000000'}));assert.equal(bytes,0);
});
