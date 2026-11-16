"""Recovery coefficients for a NEMA IEC body phantom."""

from __future__ import annotations

import numpy as np


def recovery_coefficients(image: np.ndarray, layout: dict) -> list[dict]:
    """One dict per sphere: {"sphere", "diameter_mm", "rc_mean", "rc_max"}.

    `layout` is the content of data/spheres.json. Sphere and background ROIs are balls of the
    given diameter (spheres) or radius (background) around their centres, in mm.
    """
    raise NotImplementedError
