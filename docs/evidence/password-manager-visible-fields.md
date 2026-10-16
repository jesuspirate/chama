# Visible credential experiment — brief 6.4.22 D addendum

Run on the connected Mac in Firefox, Original profile, with its existing
Bitwarden extension. Disposable fixture only; no wallet was created or funded.

- Control: `https://fill.dev/form/login-simple` redirected to `/login`. Typed
  dummy, non-secret username/password and submitted. Bitwarden displayed its
  **Save login** banner on `/submit`. Dismissed without saving.
- Chama trial: temporarily replaced the generated nsec display in `NsecLogin`
  with a visible `password` input (`autocomplete=current-password`) and visible
  npub username (`autocomplete=username`), neither hidden nor read-only. Used
  the existing form submission handler, which validates the generated key and
  unmounts the form before handing off. Form autocomplete was enabled.
- On localhost:3211, Create → Continue showed the signing-in handoff. No
  Bitwarden save banner appeared, including a repeat with no preview reload
  between submission and observation. Generated credentials were never posted
  to a server or saved in Bitwarden. The test tabs were closed.

The control worked; this Chama form trial did not. This does not prove that all
managers ignore all programmatically populated inputs. It does establish that
this experiment is not a dependable save flow in Jet's Firefox setup.

## Revised D1 requested afterward

Jet subsequently asked to follow Claude’s updated brief: one **Save & continue**
submit, visible npub and password-type nsec inputs, and **It’s saved / Show key**
in Me. Implemented that newer D1 rather than the older addendum’s Copy-only
fallback. Browsers enforce password masking even with text-security styling. The real
password input stays visible, with a readable nsec output in the same key block;
neither credential field is hidden or read-only. The key remains present during handoff, until the parent
app navigates. No Copy or credential-store button appears on signup.

The final D/J/K revision supersedes the intermediate same-tap-copy request.
Save & continue now only submits: no clipboard write, no backup receipt, no
copy-success animation. Me’s explicit confirmation and successful Copy/Save
set the receipt. An unsaved reminder below the identity opens the one Wallet
key reveal; after confirmation only the Wallet row remains. Saved sign-out
uses the light dialog. A manager filling a prior key on the generated form
still needs the submit; the returning lane has only a current-password field
and automatically signs in after a valid paste. The revised J chooser mounts
only the selected flow. Returning has no submit button; Enter reads the actual
form value, including manager fills that do not fire React change events.
Automated Chromium checks cover that behavior, not a manager save prompt.

The negative trial above is evidence about that trial, not proof that the final
flow will always fail or always prompt. Firefox was actively being used when a
follow-up check was attempted, so the final manager prompt is still a device
acceptance item. Safari/PWA acceptance also needs the phones. No dummy login
was saved in Bitwarden and no nsec was posted to fill.dev or a local server.

## L supersedes the amber reveal shortcut

The final L table supplies the chooser, returning heading/paste line, backup and
sign-out copy verbatim in en/es/fr/sw. The amber reminder now has **Yes, I saved
it / Copy key**; Copy key verifies the active identity, copies, and acknowledges
only a successful write. It never navigates to Wallet or exposes plaintext. The
Wallet row is the one reveal, with Copy and supported Save.

For async key export, the ClipboardItem data is a promise and the write starts
inside the tap, following [WebKit’s clipboard gesture requirements](https://webkit.org/blog/10855/async-clipboard-api/).
Stub checks cover deferred export/write, rejection, wrong identity and external
signer; these do not replace the physical Safari/PWA copy check.
