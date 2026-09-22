#!/usr/bin/env python3
"""Export the user-approved canonical master without recolouring. Requires Pillow.
Run from any directory: python3 scripts/brand/sync-marks.py
The master is 1254px. Never use an animation frame as a static logo source.
"""
from pathlib import Path
import hashlib
import json
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'assets/brand/chama-mark-master.png'
metadata = json.loads((ROOT/'assets/brand/master.json').read_text())
if hashlib.sha256(SOURCE.read_bytes()).hexdigest() != metadata['sha256']:
    raise SystemExit('Canonical logo changed: require explicit approval before exporting.')
with Image.open(SOURCE) as source:
    source.seek(0)
    mark = source.convert('RGBA')


def render(size, fraction=1, background=None):
    canvas = Image.new('RGBA', (size, size), background or (0, 0, 0, 0))
    side = round(size * fraction)
    canvas.alpha_composite(mark.resize((side, side), Image.Resampling.LANCZOS), ((size-side)//2, (size-side)//2))
    return canvas.convert('RGB') if background else canvas


def save(path, size, fraction=1, background=None):
    render(size, fraction, background).save(ROOT/path)


for folder in ['public/icons', 'landing/icons']:
    for file in (ROOT/folder).glob('favicon-*x*.png'):
        save(file.relative_to(ROOT), int(file.stem.split('-')[1].split('x')[0]))
    render(256).save(ROOT/folder/'favicon.ico', sizes=[(s,s) for s in [16,24,32,48,64,128,256]])
    # Ordinary installed icons keep the requested dark plate. Maskable has
    # its own extra inset so an OS circle/squircle cannot crop the rings.
    for size in [192,512]:
        save(f'{folder}/android-chrome-{size}x{size}.png',size,.9,'#000000')
    save(f'{folder}/maskable-512x512.png',512,.7,'#000000')
    save(f'{folder}/apple-touch-icon.png',180,.82,'#000000')

save('public/icons/chama-mark-256.png',256)
# Compatibility URL used by currently deployed bundles: approved pixels only.
save('public/icons/chama-woven-trust-mark-transparent-64.png',64)
for size in [64,128,256,512,1024]:
    save(f'public/icons/profile-pics/chama-profile-mark-black-{size}.png',size,1,'#000000')
for size in [64,128,256,512,1024]:
    save(f'landing/icons/chama-mark-{size}.png',size)
save('icon.png',512)
save('src-tauri/icons/icon.png',1024)
render(1024).save(ROOT/'src-tauri/icons/icon.icns')

res = ROOT/'android/app/src/main/res'
for file in res.glob('mipmap-*/*.png'):
    if not file.name.startswith('ic_launcher'): continue
    with Image.open(file) as old: size=old.width
    # Android adaptive foregrounds are composited over the existing dark XML
    # background. Keep foreground transparency for future theme changes.
    foreground = file.stem.endswith('foreground')
    save(file.relative_to(ROOT),size,.7 if foreground else .9,None if foreground else '#000000')
save('android/app/src/main/res/drawable-nodpi/chama_splash_mark.png',1024)
# Preserve the approved native lockup typography; only replace its top mark.
file=res/'drawable-nodpi/chama_splash_lockup.png'
with Image.open(file) as source: lockup=source.convert('RGBA')
lockup.paste((0,0,0,0),(0,0,lockup.width,1080))
lockup.alpha_composite(mark.resize((900,900),Image.Resampling.LANCZOS),(450,150))
lockup.save(file)
print('Exported clean-star app, landing, browser, PWA, and native marks from the approved canonical master.')

# Preserve the landing share card's existing composition and typography.
with Image.open(ROOT/'assets/brand/templates/people-base.png') as image:
    people = image.convert('RGBA')
people.alpha_composite(mark.resize((52,52),Image.Resampling.LANCZOS),(58,49))
people.convert('RGB').save(ROOT/'landing/icons/chama-social-people.png')
with Image.open(ROOT/'assets/brand/templates/community-base.png') as image:
    community = image.convert('RGBA')
community.alpha_composite(mark.resize((144,144),Image.Resampling.LANCZOS),(100,126))
community.convert('RGB').save(ROOT/'landing/img/chama-community-banner.png')

# Previously published share URLs remain compatible, with approved artwork.
people.convert('RGB').save(ROOT/'landing/icons/og-image-people-v13.jpg',quality=94,subsampling=0)
community.convert('RGB').save(ROOT/'landing/img/chama-community-banner-v2.png')
