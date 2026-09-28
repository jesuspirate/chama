import { useEffect, useRef, useState, type ReactNode } from 'react';
import { nativeWalletLinks, openWalletLink } from '../../payments/wallet-link.js';
import { copyTextRobust } from './CopyButton.js';
import { useT } from '../../i18n/index.js';

export function usePaymentTarget(uri: string | undefined, copy: () => void) {
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const held = useRef(false);
  const start = useRef<{x:number;y:number}>();
  const cancel = () => { clearTimeout(timer.current); };
  useEffect(() => cancel, []);
  const open = (share: boolean) => { setFailed(false); void openWalletLink(uri!, share).catch(() => setFailed(true)); };
  return { failed, handlers: {
    onClick: () => {
      if (held.current) { held.current = false; return; }
      if (uri && nativeWalletLinks()) open(false); else copy();
    },
    onPointerDown: (event: React.PointerEvent) => {
      held.current = false; start.current = {x:event.clientX,y:event.clientY};
      if (uri && nativeWalletLinks()) timer.current = setTimeout(() => { held.current = true; open(true); }, 500);
    },
    onPointerMove: (event: React.PointerEvent) => {
      if (start.current && Math.hypot(event.clientX-start.current.x,event.clientY-start.current.y)>10) cancel();
    },
    onPointerUp: cancel, onPointerCancel: cancel, onPointerLeave: cancel,
    onContextMenu: (event: React.MouseEvent) => {
      if (!uri || !nativeWalletLinks()) return;
      event.preventDefault(); cancel();
      if (!held.current) { held.current = true; open(true); }
    },
  }};
}

export function PaymentTarget({uri, copyValue, children}: {uri: string; copyValue: string; children: ReactNode}) {
  const {t} = useT();
  const {failed,handlers} = usePaymentTarget(uri, () => copyTextRobust(copyValue));
  return <div style={{textAlign:'center'}}><button type="button" {...handlers}
    aria-label={nativeWalletLinks() ? t('payment.openWith') : t('common.copy')}
    style={{padding:0,border:0,background:'transparent',cursor:'pointer',touchAction:'manipulation'}}>{children}</button>
    {failed && <div role="status">{t('payment.walletFailed')} <button type="button" onClick={()=>copyTextRobust(copyValue)}>{t('common.copy')}</button></div>}
  </div>;
}
