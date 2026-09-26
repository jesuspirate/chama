import assert from 'node:assert/strict';
import { safeAvatarSource, parseAvatar } from './avatars.js';
for (const value of ['https://tracker.example/pixel.gif','//tracker.example','data:image/svg+xml;base64,PHN2Zz4=','javascript:alert(1)','data:image/gif;base64,'+'A'.repeat(70000)]) assert.equal(safeAvatarSource(value),false);
assert.equal(safeAvatarSource('data:image/gif;base64,R0lGODlhAQABAAAAACw='),true);
assert.equal(parseAvatar({animated:'data:image/gif;base64,R0lG',still:'https://tracker.example/fallback.png'}),null);
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1sAAAAASUVORK5CYII=';
assert.ok(parseAvatar({animated:'data:image/gif;base64,R0lG',still:png}));
assert.equal(parseAvatar({animated:png,still:'data:image/webp;base64,UklGRg=='}),null);
assert.equal(parseAvatar({animated:png,still:'data:image/png;base64,iVBORw=='}),null);
const raw = Buffer.from(png.split(',')[1], 'base64');
const apngChunk = Buffer.alloc(20); apngChunk.writeUInt32BE(8); apngChunk.write('acTL',4);
const apng = 'data:image/png;base64,' + Buffer.concat([raw.subarray(0,33),apngChunk,raw.subarray(33)]).toString('base64');
assert.equal(parseAvatar({animated:apng,still:apng}),null);
console.log('Avatar sources: embedded raster allowlist, fallback and size limits passed');

// Static WebP/JPEG are accepted, but an animated WebP cannot masquerade as
// the reduced-motion fallback. Keep the old static PNG profile compatible.
function webp(animated = false) {
  const payload = Buffer.alloc(10); payload[3]=0x9d; payload[4]=1; payload[5]=0x2a;
  payload.writeUInt16LE(256,6); payload.writeUInt16LE(256,8);
  const frame=Buffer.alloc(8); frame.write('VP8 '); frame.writeUInt32LE(payload.length,4);
  const animation=animated?Buffer.from('ANIM\x00\x00\x00\x00','binary'):Buffer.alloc(0);
  const head=Buffer.alloc(12); head.write('RIFF'); head.writeUInt32LE(4+frame.length+payload.length+animation.length,4); head.write('WEBP',8);
  return 'data:image/webp;base64,'+Buffer.concat([head,animation,frame,payload]).toString('base64');
}
const stillWebp=webp();
assert.ok(parseAvatar({animated:stillWebp,still:stillWebp}));
assert.equal(parseAvatar({animated:webp(true),still:webp(true)}),null);
assert.equal(parseAvatar({animated:stillWebp,still:stillWebp.slice(0,-4)}),null);

// A large source is cropped, not rejected or stretched. Encoding retries to
// meet the upload limit and only returns the new image (never the original).
const { avatarFromFile } = await import('./avatars.js');
const draws: unknown[][]=[], qualities: number[]=[];
let closed=0;
Object.defineProperty(globalThis,'createImageBitmap',{configurable:true,value:async()=>({width:4000,height:2000,close:()=>closed++})});
const context={drawImage:(...args:unknown[])=>draws.push(args),fillRect:()=>{},fillStyle:'',globalCompositeOperation:''};
const canvas={width:0,height:0,getContext:()=>context,toDataURL:(_format:string,quality:number)=>{qualities.push(quality);return quality>.62?'data:image/webp;base64,'+'A'.repeat(60000):stillWebp;}};
Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:()=>canvas}});
const compressed=await avatarFromFile({type:'image/png',size:5_000_000} as File);
assert.deepEqual([canvas.width,canvas.height],[256,256]);
assert.deepEqual(draws[0].slice(1),[1000,0,2000,2000,0,0,256,256]);
assert.deepEqual(qualities,[.82,.72,.62]);
assert.equal(compressed.animated,compressed.still);
assert.equal(closed,1);
console.log('Avatar compression: large input, cover crop, quality retries and static fallback checks passed');
