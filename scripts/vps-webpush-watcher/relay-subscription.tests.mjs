import assert from 'node:assert/strict';
import { WebSocketServer, WebSocket } from 'ws';
import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool';
import { subscribeWakeBand } from './relay-subscription.mjs';
useWebSocketImplementation(WebSocket);
const server = new WebSocketServer({host:'127.0.0.1',port:0});
await new Promise(resolve=>server.once('listening',resolve));
const url=`ws://127.0.0.1:${server.address().port}`;
const pool=new SimplePool();
let subscription;
try {
  const req = new Promise(resolve=>server.on('connection',socket=>socket.on('message',data=>{
    const value=JSON.parse(String(data));
    if(value[0]==='REQ') {resolve(value);socket.send(JSON.stringify(['EOSE',value[1]]));}
  })));
  const eose = new Promise(resolve=>{
    subscription=subscribeWakeBand(pool,[url],[38100,38101],123,{oneose:resolve});
  });
  const timeout = AbortSignal.timeout(3000);
  const wire = await Promise.race([req,new Promise((_,reject)=>timeout.addEventListener('abort',()=>reject(Error('No relay REQ'))))]);
  assert.deepEqual(wire.slice(2),[{kinds:[38100,38101],since:123}]);
  await eose;
  assert.ok([...pool.listConnectionStatus().values()].some(Boolean));
  console.log('PASS watcher sends a valid Nostr filter and receives EOSE over WebSocket');
} finally {
  subscription?.close(); pool.close([url]);
  for(const socket of server.clients) socket.terminate();
  await new Promise(resolve=>server.close(resolve));
}
