"""SUV computation and simple spherical VOI statistics."""

from __future__ import annotations

from datetime import datetime

import numpy as np

F18_HALF_LIFE_S = 6586.2


def suv_bw(activity: np.ndarray, injected_dose_mbq: float, weight_kg: float, injection_time: datetime, scan_start: datetime, half_life_s: float = F18_HALF_LIFE_S) -> np.ndarray:
    raise NotImplementedError


def sphere_stats(image: np.ndarray, spacing_mm: tuple[float, float, float], center_mm: tuple[float, float, float], radius_mm: float) -> tuple[float, float, int]:
    raise NotImplementedError
