import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.main import MagicPointerApp

# Bypass __init__ because we only test the pure detector method.
def detect(points):
    obj = object.__new__(MagicPointerApp)
    obj._mouse_points = points
    return MagicPointerApp._looks_like_mouse_shake(obj, points[-1][0])

# Clear left-right-left-right within 1s.
wiggle = [(0.00, 100, 100), (0.10, 145, 103), (0.20, 95, 101), (0.32, 150, 102), (0.45, 90, 100), (0.58, 138, 101), (0.70, 112, 103), (0.82, 130, 102)]
assert detect(wiggle) is True

# Mostly vertical movement should not trigger.
vertical = [(0.00, 100, 100), (0.10, 105, 135), (0.20, 108, 170), (0.32, 110, 210), (0.45, 112, 250), (0.58, 115, 290), (0.70, 118, 330), (0.82, 120, 370)]
assert detect(vertical) is False

# One-way horizontal travel should not trigger.
one_way = [(0.00, 100, 100), (0.10, 130, 102), (0.20, 165, 101), (0.32, 200, 103), (0.45, 235, 100), (0.58, 270, 102), (0.70, 305, 101), (0.82, 340, 102)]
assert detect(one_way) is False

print('gesture smoke ok')
