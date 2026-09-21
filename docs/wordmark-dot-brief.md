# Brief — unify the wordmark dot (app + landing)

Status: ready for Codex. Small, self-contained, no behaviour change.
Author: Claude. Verified against `334aeaed` on `main`, working tree clean.

## Why

The dot after "chama" renders differently on every surface. Not a styling
preference — two separate causes, both mechanical.

### Cause 1 — the glyph is never drawn in our typeface

`●` is U+25CF. It is outside every `unicode-range` we declare:

- app: `public/fonts/fonts.css` — the latin subset ends at `U+2215`, and the
  latin-ext ranges (`U+0100-02BA`, `U+1E00-1E9F`, `U+A720-A7FF`, …) do not
  cover it either.
- landing: loads Manrope from the Google Fonts CSS, which carries the same
  subsetting.

So neither Manrope 800 nor DM Sans is ever consulted for that character. It
always falls through to `-apple-system` (app) or generic `sans-serif`
(landing). The dot's actual diameter and its height above the baseline are
decided by the OS, not by our CSS — which is why the surfaces diverge in ways
the declared numbers do not explain, and why they diverge differently per
device.

### Cause 2 — the size is derived from four different `size` values

`Wordmark` computes the dot as `Math.max(6, Math.round(size / 3))`:

| Surface | Call site | `size` | dot |
|---|---|---|---|
| Onboarding (connect, globe picker) | `BrandHeader.tsx:36` | 27 | 9px |
| App header (Browse) | `App.tsx:3277` | 24 | 8px |
| Fund wallet modal | `FundWalletModal.tsx:301` | 17 | 6px (floor) |
| Landing desktop | `story.css:89` | 31 | 10px |

The modal is the worst of these: the `Math.max(6, …)` floor fires, so a 6px
dot sits against 17px type — proportionally the fattest of the four.

The landing also uses a different ink (`#c65b17`, hardcoded) from the app
(`T.accent`), and its own dot is inconsistent page to page: `cinema.css:252`
re-shows it in the nav below 760px at 8px, while `story.css:774` sets
`display:none` below 650px — so on `index.html` the nav dot survives on
mobile (specificity: `.nav .brand-dot` beats `.brand-dot`, and cinema.css
loads second) but on `faq.html` / `faq.es.html` / `faq.fr.html`, which load
`story.css` + `faq.css` and never `cinema.css`, it disappears. The
`index.html:123` footer lockup has no dot at all.

### Note on the previous attempt

An earlier attempt replaced the glyph with a drawn circle and was reverted
because it floated near cap height. The cause was `align-self: baseline` on an
**empty flex item** — a box with no in-flow line content has no text baseline,
so flexbox falls back to its border box. The fix below avoids that by taking
the dot *out of the flex row* entirely: an empty inline-block's baseline is
its bottom margin edge, so `vertical-align: baseline` lands it exactly on the
text baseline, like a period. Do not re-introduce `align-self` here.

## Part A — `src/ui/components/Wordmark.tsx`

Replace the third flex child with a drawn circle nested inside the text span.

```tsx
const dot = Math.max(5, Math.round(size * 0.30));
```

```tsx
      <span>
        chama
        <span
          aria-hidden="true"
          style={{
            display: "inline-block",
            width: dot,
            height: dot,
            borderRadius: "50%",
            background: T.accent,
            verticalAlign: "baseline",
            marginLeft: Math.round(size * 0.10),
          }}
        />
      </span>
```

Delete the old `<span aria-hidden="true">●</span>` sibling entirely.

Three things that must not be carried over:

1. **Drop the negative `marginLeft`.** The `-Math.round(size / 8)` existed to
   cancel the parent's flex `gap` (`Math.round(size * 0.25)`). Once the dot is
   inside the text span it is no longer a flex item and no gap applies, so a
   negative margin would overlap the final "a".
2. **Drop `alignSelf` and `marginBottom`.** Both were manual fudges for the
   glyph's font-dependent position. `verticalAlign: "baseline"` replaces them.
3. **Keep `aria-hidden`.** An empty span is fine; it carries no text now.

Resulting sizes — `0.30` ratio, floor 5: 17 → 5px, 24 → 7px, 27 → 8px. All
three scale identically off `size`; nothing hits the floor in practice.

The text span carries the parent's negative `letterSpacing`, which adds its
tracking after the inline-block too and pulls the dot roughly 1.3px left of
where `marginLeft` alone would put it. `0.10` already accounts for that — if
you retune, retune that constant, not by re-adding a negative margin.

Update the component's doc comment: it currently claims the dot is "matched to
the landing page's `.brand` rule" and cites the 8px/-3px/4px glyph numbers.
Both become false with this change.

## Part B — landing

Same treatment by hand; the landing cannot import from `src/`, and it is
scp'd, so this lands separately from the app build.

### B1 — markup (4 files, 7 sites)

The dot is currently a direct flex child of `.brand`. Wrap the word and the
dot together so the dot becomes inline within the text flow, and empty the
span:

```html
<span class="brand-word">chama<span class="brand-dot"></span></span>
```

Sites: `index.html:41`; `faq.html:30` and `:79`; `faq.es.html:30` and `:79`;
`faq.fr.html:30` and `:79`. Leave `index.html:123` (the footer lockup) alone —
it has no dot today and adding one is a separate call.

### B2 — `story.css`

Add the ink as a variable alongside the other tokens in `:root` (line 1–10),
mirroring `T.accent`'s light value so the two brands actually match:

```css
  --dot:#c47308;
```

Replace the `.brand-dot` rule at line 89:

```css
.brand-dot {
  display:inline-block;
  width:9px;
  height:9px;
  border-radius:50%;
  background:var(--dot);
  vertical-align:baseline;
  margin-left:3px
}
```

At the `max-width:650px` block (line 774), replace `display:none` with a size
that tracks the 26px type set two rules above:

```css
  .brand-dot {
    width:8px;
    height:8px
  }
```

### B3 — `cinema.css`

Line 252, inside `@media(max-width:760px)` — the `.nav .brand` is 24px there:

```css
  .nav .brand-dot{display:inline-block;width:7px;height:7px;margin-left:2px}
```

Add the dark-mode ink to the `html[data-theme=dark]` token line (178), so the
dot gets the full `#f7931a` it needs on `#11100e`, matching `T.accent` dark:

```css
--dot:#f7931a
```

The `max-width:380px` block (line 256) sets `.nav .brand` to 21px; add
`width:6px;height:6px` for the dot there.

The FAQ pages never load `cinema.css`, so they stay light-only at `#c47308`.
That is correct — they have no theme toggle.

## Verification

- `export ESBUILD_BINARY_PATH=$HOME/esb/node_modules/@esbuild/linux-arm64/bin/esbuild && npm test`
- `npx tsc --noEmit`
- Eyeball the three app surfaces at the same zoom: connect screen, Browse
  header, fund-wallet modal. The dot should sit on the baseline, not float,
  and read as the same weight relative to the type at all three sizes.
- Landing: `index.html` nav at desktop / 700px / 360px, light and dark; and
  `faq.html` nav and footer at desktop and 600px.

## Out of scope

- `index.html:123` footer lockup (no dot today).
- Any change to `T.accent` itself or to `--orange`.
