"""NumPy port of the scfp1 thumbnail step (securecam-core.js thumbnailsFromRGBA).

Used only to make the experiment fast. analyze.js re-checks a sample of images
against the JavaScript implementation and refuses to report if they differ.
"""
import numpy as np

N, NC = 128, 32


def thumbnails(rgb: np.ndarray) -> bytes:
    """rgb: HxWx3 uint8 array in display orientation. Returns Y|Cb|Cr bytes (18432)."""
    h, w, _ = rgb.shape
    if w < N or h < N:
        raise ValueError(f"image too small: {w}x{h}")
    R = rgb[:, :, 0].astype(np.int32)
    G = rgb[:, :, 1].astype(np.int32)
    B = rgb[:, :, 2].astype(np.int32)
    Y = (19595 * R + 38470 * G + 7471 * B + 32768) >> 16
    Cb = np.clip(((-11059 * R - 21709 * G + 32768 * B + 32768) >> 16) + 128, 0, 255)
    Cr = np.clip(((32768 * R - 27439 * G - 5329 * B + 32768) >> 16) + 128, 0, 255)
    # Cell (r, c) holds the pixels with floor(y*N/h) == r and floor(x*N/w) == c: contiguous
    # row and column bands, so exact integer sums come from two reduceat passes.
    rs = np.searchsorted((np.arange(h) * N) // h, np.arange(N))
    cs = np.searchsorted((np.arange(w) * N) // w, np.arange(N))
    cnt = (np.diff(np.append(rs, h))[:, None] * np.diff(np.append(cs, w))[None, :]).astype(np.int64)

    def cell(a):
        return np.add.reduceat(np.add.reduceat(a, rs, axis=0, dtype=np.int64), cs, axis=1)

    sY, sCb, sCr = cell(Y), cell(Cb), cell(Cr)
    y = (2 * sY + cnt) // (2 * cnt)
    f = N // NC

    def pool(s):
        return s.reshape(NC, f, NC, f).sum(axis=(1, 3))

    tn = pool(cnt)
    cb = (2 * pool(sCb) + tn) // (2 * tn)
    cr = (2 * pool(sCr) + tn) // (2 * tn)
    return (y.astype(np.uint8).tobytes() + cb.astype(np.uint8).ravel().tobytes()
            + cr.astype(np.uint8).ravel().tobytes())


def rotate_grid(g: np.ndarray, deg: int) -> np.ndarray:
    """Grid of the image rotated clockwise by deg (matches rotateGrid in JS)."""
    k = (deg // 90) % 4
    return np.rot90(g, -k).copy()


def rotate_thumbs(t: bytes, deg: int) -> bytes:
    y = np.frombuffer(t[:N * N], np.uint8).reshape(N, N)
    cb = np.frombuffer(t[N * N:N * N + NC * NC], np.uint8).reshape(NC, NC)
    cr = np.frombuffer(t[N * N + NC * NC:], np.uint8).reshape(NC, NC)
    return (rotate_grid(y, deg).tobytes() + rotate_grid(cb, deg).tobytes()
            + rotate_grid(cr, deg).tobytes())
