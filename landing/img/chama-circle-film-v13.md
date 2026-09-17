# Hero v13 — phone attached to table motion

Uses the same clean-table Higgsfield footage and approved phone cutout as v12. Wood-grain features outside the removed-phone region are tracked against the first frame with forward/backward Lucas–Kanade validation. RANSAC fits a similarity transform (translation, rotation, uniform scale); an eleven-frame centered quadratic filter removes measurement noise without lag.

Phone, static logo, silhouette and contact shadow receive the same transform. Premultiplied alpha avoids dark interpolation fringes. No independent logo movement or deforming corner warps.

Validation across 145 frames: minimum 16 fitting inliers; held-out wood-feature median residual 0.326px, 95th percentile 1.410px at 1764×1176. Phone center follows about 7.3px downward drift; maximum consecutive-frame step 0.556px. Reviewed encoded phone crops at four-frame intervals. Same 1600×1066, 24fps, six-second scene, silent H.264 CRF18.
