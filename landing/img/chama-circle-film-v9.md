# Hero film v9

Derived from the same multi-contribution source as v8. No scene or timing regeneration.

The entire phone, screen, camera, shadow and surrounding table patch are composited from the original single-coin first frame at fixed coordinates throughout all 145 frames. Translation and deformation are zero. The feathered patch covers the union of the previous drifting phone positions.

Output: 1600 × 1066, 24 fps, silent H.264, faststart. Poster extracted from encoded first frame.

The website captures the decoded ending frame into a canvas before hiding the video layer, preserving its exact crop for the scroll exit. Progress updates on requestAnimationFrame; the desktop exit transform uses time-based easing. Reduced motion disables the bouncing cue.
