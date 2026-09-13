"""Synthetic test chart: 8-step tone ramp + a shaded sphere + soft gradient."""
import numpy as np
from PIL import Image

def chart(w=800, h=520):
    g = np.ones((h, w))
    # tone ramp, 8 steps across the top third
    for i in range(8):
        g[0:h//3, i*w//8:(i+1)*w//8] = 1.0 - i/7.0
    # smooth horizontal gradient, middle band
    g[h//3:h//2, :] = np.linspace(1, 0, w)[None, :]
    # lambertian sphere, bottom half
    yy, xx = np.mgrid[0:h, 0:w]
    cx, cy, R = w*0.5, h*0.75, h*0.22
    r2 = ((xx-cx)**2 + (yy-cy)**2) / R**2
    inside = r2 <= 1
    z = np.sqrt(np.clip(1-r2, 0, 1))
    lx, ly, lz = -0.5, -0.6, 0.62
    nx, ny = (xx-cx)/R, (yy-cy)/R
    shade = np.clip(nx*lx + ny*ly + z*lz, 0, 1)
    g[inside] = np.clip(0.12 + 0.88*shade[inside], 0, 1)
    return g

if __name__ == "__main__":
    Image.fromarray((chart()*255).astype(np.uint8)).save("chart.png")
