import React from 'react';
import { createRoot } from 'react-dom/client';
import { LangProvider } from '../../src/i18n/index.js';
import { SavedHandlesPanel } from '../../src/ui/panels/SavedHandlesPanel.js';
import { setLocalStorageUserScope } from '../../src/storage/user-scope.js';

// Disposable UI data only; no signer, wallet, relay or payment action.
setLocalStorageUserScope('payment-autofill-fixture');
createRoot(document.getElementById('root')!).render(
  <LangProvider><SavedHandlesPanel communitySlug="us-blf" onClose={() => {}} /></LangProvider>,
);
