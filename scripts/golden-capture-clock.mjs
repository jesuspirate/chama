// Test-process-only fixture entropy. Never imported by application code.
// Timers/performance remain real; fixtures use a fixed calendar and random stream.
const fixed = Date.parse('2026-10-09T12:00:00Z');
const started = performance.now();
Date.now = () => {
  const stack = new Error().stack ?? '';
  // Adapter deadlines and the existing test wait helper need elapsed time.
  // Fixture builders, unsigned-event builders and pure replay keep fixed time.
  return /src\/(?:(?:fedimint|payments)\/(?![^\n]*\.tests?\.)|escrow-engine\/relay-manager)|at waitUntil/.test(stack)
    ? fixed + Math.floor(performance.now()-started) : fixed;
};
let seed = 0x642100;
function nextByte() { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 24; }
Math.random = () => ((nextByte()*16777216 + nextByte()*65536 + nextByte()*256 + nextByte()) >>> 0)/4294967296;
Object.defineProperty(globalThis.crypto,'getRandomValues',{configurable:true,value:array=>{
  const bytes = new Uint8Array(array.buffer,array.byteOffset,array.byteLength);
  for(let i=0;i<bytes.length;i++) bytes[i]=nextByte();
  return array;
}});
Object.defineProperty(globalThis.crypto,'randomUUID',{configurable:true,value:()=>{
  const bytes=new Uint8Array(16);crypto.getRandomValues(bytes);bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
  const hex=Buffer.from(bytes).toString('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}});
