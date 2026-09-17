# Rigid phone plate — v7

Corrects residual wobble in v6: frame-by-frame screen-corner detections moved by up to six source pixels, independently deforming the screen artwork.

The entire first-frame phone, including the locked five-orange-seat artwork, camera, chassis and contact shadow, is now one rigid plate. A cubic fit to the shot's overall phone-center drift supplies translation only. There are no per-frame corner warps, rotations or scale changes. The artwork and phone therefore share exactly the same transform throughout the six-second clip. The matte is feathered outside the phone, onto the tabletop; its interior is fully opaque.

Source performance, contribution timing and basket handoff are unchanged. Export: 1600×1066, 24 fps, H.264 CRF20, silent, faststart. Poster extracted from the corrected export. v7 supersedes the earlier screen-only composite.
