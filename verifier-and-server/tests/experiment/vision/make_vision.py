"""Large-scale robustness dataset built on VISION (real smartphone photos).

For every downloaded photo (see download.py) this script produces fingerprints for:
  * the registered record (what the phone would register: reduced-size decode),
  * REAL platform copies shipped with VISION: WhatsApp, Facebook high, Facebook low,
  * simulated platform copies (same profiles as the small experiment, plus WebP),
  * edited copies (clone, splice, text, recolour, blur, flat fill), saved by an
    editor and also sent through the simulated WhatsApp profile.
It also computes baseline scores against the original for every copy: aHash, dHash,
BlockHash (256 bit), global SSIM, minimum regional SSIM and PSNR on a 256x256
greyscale reduction. analyze_vision.js does the scfp1 scoring with securecam-core.js.

Usage: python make_vision.py <vision_dir> <out_dir> [workers=5] [limit]
"""
import hashlib
import io
import json
import math
import os
import random
import struct
import subprocess
import sys
from multiprocessing import Pool

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from scfp import rotate_thumbs  # noqa: E402
from scfp import thumbnails as thumbnails_numpy  # noqa: E402

_node = None


def thumbnails(img):
    """scfp1 thumbnail of a PIL RGB image in display orientation, computed by securecam-core.js
    through thumb_server.js (about ten times faster than the NumPy port, and the real code)."""
    global _node
    if os.environ.get("SCFP_NUMPY"):
        return thumbnails_numpy(np.asarray(img))
    if _node is None:
        _node = subprocess.Popen(["node", os.path.join(os.path.dirname(os.path.abspath(__file__)), "thumb_server.js")],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    w, h = img.size
    _node.stdin.write(struct.pack("<II", w, h))
    _node.stdin.write(img.convert("RGBA").tobytes())
    _node.stdin.flush()
    out = _node.stdout.read(18432)
    if len(out) != 18432:
        raise RuntimeError("thumb_server.js stopped")
    return out


SRC, OUT = sys.argv[1], sys.argv[2]
WORKERS = int(sys.argv[3]) if len(sys.argv) > 3 else 5
LIMIT = int(sys.argv[4]) if len(sys.argv) > 4 else None
THUMBS = os.path.join(OUT, "thumbs")
META = os.path.join(OUT, "meta")

# name: (long side or None, fixed width or None, quality, resample, format)
PLATFORMS = {
    "whatsapp_std": (1600, None, 75, Image.BICUBIC, "JPEG"),
    "whatsapp_hd": (4096, None, 85, Image.BICUBIC, "JPEG"),
    "telegram": (1280, None, 87, Image.LANCZOS, "JPEG"),
    "instagram": (None, 1080, 78, Image.BILINEAR, "JPEG"),
    "facebook": (2048, None, 71, Image.LANCZOS, "JPEG"),
    "email_resize": (1280, None, 80, Image.BILINEAR, "JPEG"),
    "low_quality": (1600, None, 55, Image.BICUBIC, "JPEG"),
    "screenshot_png": (1080, None, None, Image.BILINEAR, "PNG"),
    "webp_q80": (1600, None, 80, Image.BICUBIC, "WEBP"),
}
REAL = {"natWA": "real_whatsapp", "natFBH": "real_facebook_high", "natFBL": "real_facebook_low"}
EDITS = [("clone", 0.01), ("clone", 0.03), ("splice", 0.01), ("splice", 0.03), ("text", 0.02),
         ("recolor", 0.03), ("blur", 0.02), ("flatfill", 0.01), ("clone", 0.004), ("text", 0.008)]
EDIT_PLATFORMS = ["editor_save", "whatsapp_std"]
EXIF_DEG = {1: 0, 3: 180, 6: 90, 8: 270}


def encode(img, quality, fmt="JPEG"):
    buf = io.BytesIO()
    if fmt == "PNG":
        img.save(buf, "PNG")
    else:
        img.save(buf, fmt, quality=quality)
    return buf.getvalue()


def decode(data):
    im = Image.open(io.BytesIO(data))
    return ImageOps.exif_transpose(im).convert("RGB")


def platform(img, name):
    if name == "wa_then_telegram":
        return platform(decode(platform(img, "whatsapp_std")), "telegram")
    long_side, width, q, res, fmt = PLATFORMS[name]
    w, h = img.size
    scale = width / w if width else min(1.0, long_side / max(w, h))
    if scale < 1.0:
        img = img.resize((round(w * scale), round(h * scale)), res)
    return encode(img, q, fmt)


def phone_thumb(path):
    """Emulates MainActivity: decode with a power-of-two sample size (min side >= 512),
    fingerprint the stored pixels, then rotate the grid by the EXIF rotation."""
    im = Image.open(path)
    deg = EXIF_DEG.get(im.getexif().get(274, 1), 0)
    w, h = im.size
    s = 1
    while min(w, h) // (s * 2) >= 512:
        s *= 2
    im.draft("RGB", (w // s, h // s))
    return rotate_thumbs(thumbnails(im.convert("RGB")), deg), deg, (w, h)


# ---- baselines (all on a 256x256 greyscale box reduction) ------------------

def grey256(img):
    return np.asarray(img.convert("L").resize((256, 256), Image.BOX), dtype=np.float64)


def block_mean(g, n):
    f = g.shape[0] // n
    return g.reshape(n, f, n, f).mean(axis=(1, 3))


def ahash(g):
    b = block_mean(g, 8)
    return (b > b.mean()).ravel()


def dhash(g):
    b = np.asarray(Image.fromarray(g.astype(np.uint8)).resize((9, 8), Image.BOX), dtype=np.float64)
    return (b[:, 1:] > b[:, :-1]).ravel()


def blockhash(g):
    """BlockHash (Yang, Gu, Niu 2006), 16x16 blocks, median per group of 4 rows."""
    b = block_mean(g, 16)
    out = np.zeros((16, 16), bool)
    for band in range(4):
        rows = slice(band * 4, band * 4 + 4)
        out[rows] = b[rows] > np.median(b[rows])
    return out.ravel()


def bits_hex(b):
    return np.packbits(b).tobytes().hex()


def ssim_map(a, b, win=8):
    sw = np.lib.stride_tricks.sliding_window_view
    A, B = sw(a, (win, win)), sw(b, (win, win))
    ma, mb = A.mean((2, 3)), B.mean((2, 3))
    va = (A * A).mean((2, 3)) - ma * ma
    vb = (B * B).mean((2, 3)) - mb * mb
    cov = (A * B).mean((2, 3)) - ma * mb
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    return ((2 * ma * mb + c1) * (2 * cov + c2)) / ((ma * ma + mb * mb + c1) * (va + vb + c2))


def baseline(ref, img, try_rotations=False):
    """ref: dict of reference features; img: PIL image of the copy."""
    best = None
    for k in ((0, 1, 2, 3) if try_rotations else (0,)):
        g = grey256(img.rotate(-90 * k, expand=True) if k else img)
        m = ssim_map(ref["g"], g)
        if best is None or m.mean() > best[1].mean():
            best = (g, m)
    g, m = best
    # regional SSIM: mean of the SSIM map over a 16x16 grid of regions, then the minimum
    h = m.shape[0]
    edges = [(i * h) // 16 for i in range(17)]
    regional = min(m[edges[r]:edges[r + 1], edges[c]:edges[c + 1]].mean() for r in range(16) for c in range(16))
    mse = float(((ref["g"] - g) ** 2).mean())
    return {
        "ahash": int((ahash(g) != ref["ahash"]).sum()),
        "dhash": int((dhash(g) != ref["dhash"]).sum()),
        "bhash": int((blockhash(g) != ref["bhash"]).sum()),
        "ssim": round(float(m.mean()), 5),
        "ssimMin": round(float(regional), 5),
        "psnr": round(99.0 if mse == 0 else 10 * math.log10(255 * 255 / mse), 3),
    }


# ---- edits -----------------------------------------------------------------

def rand_box(rng, W, H, frac):
    side = int(math.sqrt(frac * W * H))
    x = rng.randint(0, W - side)
    y = rng.randint(0, H - side)
    return (x, y, x + side, y + side)


def font(size):
    for f in (r"C:\Windows\Fonts\arialbd.ttf", r"C:\Windows\Fonts\arial.ttf"):
        if os.path.exists(f):
            return ImageFont.truetype(f, size)
    return ImageFont.load_default()


def apply_edit(rng, img, kind, frac, other_path):
    img = img.copy()
    W, H = img.size
    box = rand_box(rng, W, H, frac)
    x0, y0, x1, y1 = box
    bw, bh = x1 - x0, y1 - y0
    if kind == "clone":  # object removal / duplication inside the same photo
        sx, sy, _, _ = rand_box(rng, W, H, frac)
        img.paste(img.crop((sx, sy, sx + bw, sy + bh)), (x0, y0))
    elif kind == "splice":  # object inserted from another photo
        o = ImageOps.exif_transpose(Image.open(other_path)).convert("RGB")
        side = max(16, int(math.sqrt(frac * o.size[0] * o.size[1])))
        ox = rng.randint(0, o.size[0] - side)
        oy = rng.randint(0, o.size[1] - side)
        img.paste(o.crop((ox, oy, ox + side, oy + side)).resize((bw, bh), Image.BICUBIC), (x0, y0))
    elif kind == "text":  # e.g. a changed caption / date / number plate
        d = ImageDraw.Draw(img)
        fs = max(12, bh // 2)
        d.text((x0, y0 + bh // 4), "FAKE 21:45", font=font(fs), fill=(255, 255, 255),
               stroke_width=max(2, fs // 12), stroke_fill=(0, 0, 0))
    elif kind == "recolor":  # colour of an object changed (luma mostly kept)
        r, g, b = img.crop(box).split()
        img.paste(Image.merge("RGB", (b, g, r)), (x0, y0))
    elif kind == "blur":  # face / plate hidden
        img.paste(img.crop(box).filter(ImageFilter.GaussianBlur(W / 250)), (x0, y0))
    elif kind == "flatfill":  # crude object removal
        med = tuple(int(v) for v in np.median(np.asarray(img.crop(box)).reshape(-1, 3), axis=0))
        ImageDraw.Draw(img).rectangle(box, fill=med)
    return img, box


def magnitude(a, b, box):
    A = np.asarray(a.crop(box)).astype(np.int32)
    B = np.asarray(b.crop(box)).astype(np.int32)
    ya = (19595 * A[..., 0] + 38470 * A[..., 1] + 7471 * A[..., 2]) >> 16
    yb = (19595 * B[..., 0] + 38470 * B[..., 1] + 7471 * B[..., 2]) >> 16
    return float(np.abs(ya - yb).mean()), float(np.abs(A - B).mean())


def save_thumb(tid, t):
    with open(os.path.join(THUMBS, tid + ".bin"), "wb") as f:
        f.write(t)
    return tid


def process(job):
    entry, other_path, dump_parity = job
    oid = entry["id"]
    meta_path = os.path.join(META, oid + ".json")
    if os.path.exists(meta_path):
        return oid
    rng = random.Random(int(hashlib.sha256(oid.encode()).hexdigest()[:12], 16))
    nat = os.path.join(SRC, entry["files"]["nat"])
    pt, deg, stored = phone_thumb(nat)
    if entry.get("trailerThumb"):  # real capture: use the fingerprint the phone itself computed and signed
        pt = open(os.path.join(SRC, entry["trailerThumb"]), "rb").read()
    display = ImageOps.exif_transpose(Image.open(nat)).convert("RGB")
    g = grey256(display)
    ref = {"g": g, "ahash": ahash(g), "dhash": dhash(g), "bhash": blockhash(g)}
    out = {
        "original": {"id": oid, "device": entry["device"], "model": entry["model"], "stored": stored,
                     "exifDeg": deg, "display": display.size, "bytes": os.path.getsize(nat),
                     "phoneThumb": save_thumb(oid + "_phone", pt),
                     "fullThumb": save_thumb(oid + "_full", thumbnails(display)),
                     "ahash": bits_hex(ref["ahash"]), "dhash": bits_hex(ref["dhash"]), "bhash": bits_hex(ref["bhash"])},
        "variants": [], "parity": [],
    }

    def add(vid, im, extra, rot=False):
        v = {"id": vid, "ref": oid, "size": im.size, "thumb": save_thumb(vid, thumbnails(im)),
             "base": baseline(ref, im, rot)}
        v.update(extra)
        out["variants"].append(v)

    for key, pname in REAL.items():
        if key not in entry["files"]:
            continue
        path = os.path.join(SRC, entry["files"][key])
        im = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
        add(f"{oid}_{pname}", im, {"kind": "clean", "real": True, "platform": pname, "bytes": os.path.getsize(path)}, rot=True)

    for pname in list(PLATFORMS) + ["wa_then_telegram"]:
        data = platform(display, pname)
        im = decode(data)
        vid = f"{oid}_{pname}"
        add(vid, im, {"kind": "clean", "real": False, "platform": pname, "bytes": len(data)})
        if dump_parity and pname == "telegram":
            raw = os.path.join(OUT, vid + ".rgba")
            with open(raw, "wb") as f:
                f.write(np.asarray(im.convert("RGBA")).tobytes())
            out["parity"].append({"raw": os.path.basename(raw), "w": im.size[0], "h": im.size[1], "thumb": vid})

    W, H = display.size
    for kind, frac in EDITS:
        edited, box = apply_edit(rng, display, kind, frac, other_path)
        magY, magRGB = magnitude(display, edited, box)
        nbox = [box[0] / W, box[1] / H, box[2] / W, box[3] / H]
        saved = encode(edited, 92)
        for pname in EDIT_PLATFORMS:
            data = saved if pname == "editor_save" else platform(decode(saved), pname)
            add(f"{oid}_{kind}{frac}_{pname}", decode(data),
                {"kind": "edit", "real": False, "edit": kind, "frac": frac, "platform": pname, "box": nbox,
                 "magY": round(magY, 3), "magRGB": round(magRGB, 3)})

    with open(meta_path + ".part", "w") as f:
        json.dump(out, f)
    os.replace(meta_path + ".part", meta_path)
    return oid


def main():
    os.makedirs(THUMBS, exist_ok=True)
    os.makedirs(META, exist_ok=True)
    index = json.load(open(os.path.join(SRC, "index.json")))
    index = [e for e in index if all(os.path.exists(os.path.join(SRC, f)) for f in e["files"].values())]
    if LIMIT:
        step = len(index) / LIMIT
        index = [index[int(i * step)] for i in range(LIMIT)]
    n = len(index)
    # Splice donor: a photo from a different device, chosen deterministically.
    jobs = [(e, os.path.join(SRC, index[(i + n // 2 + 7) % n]["files"]["nat"]), i < 5) for i, e in enumerate(index)]
    if os.environ.get("REVERSE"):  # lets a second instance work from the other end
        jobs.reverse()
    done = 0
    with Pool(WORKERS) as pool:
        for oid in pool.imap_unordered(process, jobs):
            done += 1
            if done % 20 == 0 or done == n:
                print(f"{done}/{n}", flush=True)
    merged = {"originals": [], "variants": [], "parity": []}
    missing = [e["id"] for e in index if not os.path.exists(os.path.join(META, e["id"] + ".json"))]
    if missing:
        sys.exit(f"{len(missing)} photos not processed yet (another instance running?) - rerun to merge")
    for e in index:
        m = json.load(open(os.path.join(META, e["id"] + ".json")))
        merged["originals"].append(m["original"])
        merged["variants"] += m["variants"]
        merged["parity"] += m["parity"]
    with open(os.path.join(OUT, "jobs.json"), "w") as f:
        json.dump(merged, f)
    print("originals:", len(merged["originals"]), "variants:", len(merged["variants"]))


if __name__ == "__main__":
    main()
