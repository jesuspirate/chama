import React from 'react';
import { createRoot } from 'react-dom/client';
import { Wordmark } from '../../src/ui/components/Wordmark';
import { BrandHeader } from '../../src/ui/components/BrandHeader';
import { T, applyThemeMode } from '../../src/ui/theme';
applyThemeMode(new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark');
document.body.style.cssText = `margin:0;padding:28px;background:${T.bg};color:${T.text};font-family:${T.sans}`;
createRoot(document.getElementById('root')!).render(<>
 <style>{`*{box-sizing:border-box}.sample{padding:20px;border:1px solid ${T.border};border-radius:14px;margin-bottom:12px}.label{font-size:12px;color:${T.muted};margin-bottom:16px}`}</style>
 <div className="sample"><div className="label">Onboarding · 27px</div><BrandHeader/></div>
 {[24,17].map(size=><div className="sample" key={size}><div className="label">{size===24?'Browse':'Wallet'} · {size}px</div><Wordmark size={size} markSize={size===24?28:20}/></div>)}
</>);
