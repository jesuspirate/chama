import React from 'react';
import { createRoot } from 'react-dom/client';
import { CircleCanvas } from '../../src/ui/screens/CircleCanvas';
import { BrandHeader } from '../../src/ui/components/BrandHeader';
import { Wordmark } from '../../src/ui/components/Wordmark';
import { LangProvider } from '../../src/i18n';
import { T, applyThemeMode } from '../../src/ui/theme';
applyThemeMode('dark');
const params = new URLSearchParams(location.search);
const chrome = Number(params.get('chrome') ?? 190);
document.body.style.cssText = `margin:0;background:${T.bg};color:${T.text};font-family:${T.sans}`;
createRoot(document.getElementById('root')!).render(<LangProvider><style>{`*{box-sizing:border-box}button,input{font:inherit}`}</style>
 {params.has('brand') ? <><BrandHeader/><Wordmark/></> : <div style={{paddingBottom:60}}>
 <header style={{height:chrome,padding:16}}><Wordmark/></header>
 <CircleCanvas viewerPubkey={'a'.repeat(64)} community="us-blf" mintUrl="https://example.invalid" onBack={()=>{}} onPublish={async()=>{throw Error('Fixture: publishing disabled');}}/>
 <nav data-chama-bottom-nav style={{position:'fixed',bottom:0,height:60,width:'100%',background:T.card}}>Browse · Dashboard · Me</nav>
 </div>}
</LangProvider>);
