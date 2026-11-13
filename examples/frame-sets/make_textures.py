"""Regenerate the example panel textures: deterministic, seamless (FFT-filtered) greyscale tiles."""
from pathlib import Path
import numpy as np
from PIL import Image

OUT = Path(__file__).resolve().parent / 'assets'


def periodic_noise(size, rng, sx, sy):
    """Gaussian-filtered noise in the frequency domain is periodic, so tiles repeat without seams."""
    fy, fx = np.meshgrid(np.fft.fftfreq(size), np.fft.fftfreq(size), indexing='ij')
    spectrum = np.fft.fft2(rng.standard_normal((size, size))) * np.exp(-((fx*sx)**2 + (fy*sy)**2))
    field = np.real(np.fft.ifft2(spectrum))
    return (field - field.mean()) / (field.std() + 1e-9)


def save(name, field, low, high):
    image = np.clip((field + 3) / 6, 0, 1) * (high - low) + low
    Image.fromarray(image.astype('uint8'), 'L').convert('RGB').save(OUT / name)


def main():
    OUT.mkdir(exist_ok=True)
    rng = np.random.default_rng(20261101)
    save('felt.png', periodic_noise(256, rng, 90, 90) + .12*periodic_noise(256, rng, 10, 10), 90, 170)
    save('parchment.png', .6*periodic_noise(512, rng, 3, 3) + .4*periodic_noise(512, rng, 40, 40), 150, 255)
    save('brushed.png', periodic_noise(512, rng, 160, 2) + .25*periodic_noise(512, rng, 60, 60), 60, 220)
    starglass(rng)


def starglass(rng, edge=32):
    """A nine-slice panel skin: night glass with a bevelled rim. The centre is two copies of a periodic tile and the
    rim is uniform along each side, so fill "tile" repeats seamlessly at any panel size."""
    tile = periodic_noise(256, rng, 30, 30)
    centre = np.tile(tile, (1, 2))
    field = np.pad(centre, edge, mode='wrap')
    base = np.array([18, 26, 48], float)
    glow = np.array([40, 56, 96], float)
    image = base + (np.clip(field, -2, 2)[..., None]+2)/4*(glow-base)
    h, w = field.shape
    yy, xx = np.mgrid[0:h, 0:w]
    rim = np.minimum.reduce([yy, xx, h-1-yy, w-1-xx]).astype(float)
    bevel = np.clip(1-rim/edge, 0, 1)[..., None]**1.5
    image = image*(1-bevel) + np.array([78, 98, 150], float)*bevel
    Image.fromarray(np.clip(image, 0, 255).astype('uint8'), 'RGB').save(OUT / 'starglass-skin.png')


if __name__ == '__main__':
    main()
