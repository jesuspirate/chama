import { useEffect, useRef, useState, type ReactNode } from 'react';
import { nativeWalletLinks, openWalletLink, openWalletOrCopy } from '../../payments/wallet-link.js';
import { copyTextConfirmed } from './CopyButton.js';
import { useT } from '../../i18n/index.js';

export function usePaymentTarget(uri: string | undefined, copy: () => Promise<boolean>) {
  const [failed, setFailed] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const held = useRef(false);
  const start = useRef<{x:number;y:number}>();
  const cancel = () => { clearTimeout(timer.current); };
  useEffect(() => cancel, []);
  const open = () => { setFailed(null); void openWalletOrCopy(uri!, copy).then(setFailed); };
  return { failed, handlers: {
    onClick: () => {
      if (held.current) { held.current = false; return; }
      if (uri && nativeWalletLinks()) open(); else void copy();
    },
    onPointerDown: (event: React.PointerEvent) => {
      held.current = false; start.current = {x:event.clientX,y:event.clientY};
      if (uri && nativeWalletLinks()) timer.current = setTimeout(() => { held.current = true; open(); }, 500);
    },
    onPointerMove: (event: React.PointerEvent) => {
      if (start.current && Math.hypot(event.clientX-start.current.x,event.clientY-start.current.y)>10) cancel();
    },
    onPointerUp: cancel, onPointerCancel: cancel, onPointerLeave: cancel,
    onContextMenu: (event: React.MouseEvent) => {
      if (!uri || !nativeWalletLinks()) return;
      event.preventDefault(); cancel();
      if (!held.current) { held.current = true; open(); }
    },
  }};
}

export function PaymentTarget({uri, copyValue, children}: {uri: string; copyValue: string; children: ReactNode}) {
  const {t} = useT();
  const {failed,handlers} = usePaymentTarget(uri, () => copyTextConfirmed(copyValue));
  return <div style={{textAlign:'center'}}><button type="button" {...handlers}
    aria-label={nativeWalletLinks() ? t('payment.openWith') : t('common.copy')}
    style={{padding:0,border:0,background:'transparent',cursor:'pointer',touchAction:'manipulation',WebkitTouchCallout:'none',userSelect:'none'}}>{children}</button>
    {nativeWalletLinks() && <PaymentShareLink uri={uri} />}
    {failed && <div role="status">{failed}</div>}
  </div>;
}

/** Sharing is explicit; both tap and hold on the payment target open a wallet. */
export function PaymentShareLink({ uri }: { uri: string }) {
  const [error, setError] = useState(false);
  return <div><button type="button" onClick={() => {
    setError(false);
    void openWalletLink(uri, true).catch(() => setError(true));
  }} style={{ background: 'none', border: 0, color: 'inherit', textDecoration: 'underline', padding: '4px 8px', fontSize: 12, cursor: 'pointer' }}>Share</button>
    {error && <span role="status">Couldn’t open sharing.</span>}
  </div>;
}
