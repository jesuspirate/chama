# Hero film v12 — clean table and fixed phone

Higgsfield Seedance 2.5 edit job acc402c1-0726-4df2-8122-538c5739db29 removes the original phone and its shadow from source job a377a123-32b3-44c6-91b3-117a1a114bb7. The resulting footage contains bare wood throughout the phone region.

The approved first-frame phone is cut out along its full chassis silhouette, composited at fixed coordinates with a small antialiased edge and a soft contact shadow. No original moving phone remains underneath. No frozen tabletop patch, optical-flow tracking, per-frame warping or gradient-domain phone correction is used.

Output: 1600×1066, 24fps, 145 frames, silent H.264 CRF18 with faststart. Reviewed decoded phone crops at four-frame intervals and full-scene samples across both contributions and the basket lift. Screen pixels checked across all 145 encoded frames: maximum mean first-frame difference 0.091 on an 8-bit scale (encoding noise). Poster extracted from encoded first frame.
