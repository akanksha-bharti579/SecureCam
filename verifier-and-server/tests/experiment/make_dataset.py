"""Builds the robustness dataset for the scfp1 visual fingerprint.

For each source photo it creates a "camera original" (4000x3000 JPEG q95 with
sensor noise; every 4th one is stored sideways with EXIF orientation 6 like a
portrait phone photo), then:
  * clean platform copies (WhatsApp, Telegram, Instagram, ... simulations),
  * edited copies (clone, splice, text, recolour, blur, flat fill), each saved
    by an editor and then optionally sent through a platform.
Fingerprints are written as raw thumbnail files; analyze.js does the scoring
with the real JavaScript implementation.

Usage: python make_dataset.py <out_dir>
"""
import io
import json
import math
import os
import random
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

from scfp import rotate_thumbs, thumbnails

OUT = sys.argv[1]
THUMBS = os.path.join(OUT, "thumbs")
os.makedirs(THUMBS, exist_ok=True)

SOURCES = [
    r"C:\Windows\Web\Screen\img100.jpg", r"C:\Windows\Web\Screen\img101.jpg",
    r"C:\Windows\Web\Screen\img102.jpg", r"C:\Windows\Web\Screen\img103.jpg",
    r"C:\Windows\Web\Screen\img104.jpg", r"C:\Windows\Web\Wallpaper\Spotlight\img14.jpg",
] + [rf"C:\Windows\Web\Wallpaper\Theme{t}\img{n}.jpg"
     for t, ns in (("A", (20, 22, 23)), ("B", range(24, 28)), ("C", range(28, 32)), ("D", range(32, 36)))
     for n in ns] + [r"C:\Windows\Web\Wallpaper\Windows\img19.jpg"]
# Excluded: ThemeA\img21.jpg (same picture as Screen\img101.jpg) and Windows\img0.jpg
# (same picture as Spotlight\img14.jpg). Theme colour variants are kept on purpose:
# they are near-identical in brightness and must still be told apart.

rng = random.Random(1234)
nrng = np.random.default_rng(1234)

# name: (long side or None, fixed width or None, quality or "png", resample)
PLATFORMS = {
    "whatsapp_std": (1600, None, 75, Image.BICUBIC),
    "whatsapp_hd": (4096, None, 85, Image.BICUBIC),
    "telegram": (1280, None, 87, Image.LANCZOS),
    "instagram": (None, 1080, 78, Image.BILINEAR),
    "facebook": (2048, None, 71, Image.LANCZOS),
    "email_resize": (1280, None, 80, Image.BILINEAR),
    "low_quality": (1600, None, 55, Image.BICUBIC),
    "screenshot_png": (1080, None, "png", Image.BILINEAR),
}


def encode(img, quality, exif=None):
    buf = io.BytesIO()
    if quality == "png":
        img.save(buf, "PNG")
    else:
        kw = {"quality": quality}
        if exif is not None:
            kw["exif"] = exif
        img.save(buf, "JPEG", **kw)
    return buf.getvalue()


def platform(img, name):
    if name == "wa_then_telegram":
        return platform(decode(platform(img, "whatsapp_std")), "telegram")
    long_side, width, q, res = PLATFORMS[name]
    w, h = img.size
    if width:
        scale = width / w
    else:
        scale = min(1.0, long_side / max(w, h))
    if scale < 1.0:
        img = img.resize((round(w * scale), round(h * scale)), res)
    return encode(img, q)


def decode(data):
    im = Image.open(io.BytesIO(data))
    im = ImageOps.exif_transpose(im)
    return im.convert("RGB")


def save_thumb(tid, t):
    with open(os.path.join(THUMBS, tid + ".bin"), "wb") as f:
        f.write(t)
    return tid


def phone_thumb(jpeg, exif_deg):
    """Emulates MainActivity: decode with a power-of-two sample size (min side >= 512),
    fingerprint the stored pixels, then rotate the grid by the EXIF rotation."""
    im = Image.open(io.BytesIO(jpeg))
    w, h = im.size
    s = 1
    while min(w, h) // (s * 2) >= 512:
        s *= 2
    im.draft("RGB", (w // s, h // s))
    arr = np.asarray(im.convert("RGB"))
    return rotate_thumbs(thumbnails(arr), exif_deg), (w, h), arr.shape[1::-1]


def rand_box(W, H, frac):
    side = int(math.sqrt(frac * W * H))
    x = rng.randint(0, W - side)
    y = rng.randint(0, H - side)
    return (x, y, x + side, y + side)


def font(size):
    for f in (r"C:\Windows\Fonts\arialbd.ttf", r"C:\Windows\Fonts\arial.ttf"):
        if os.path.exists(f):
            return ImageFont.truetype(f, size)
    return ImageFont.load_default()


def apply_edit(img, kind, frac, others):
    img = img.copy()
    W, H = img.size
    box = rand_box(W, H, frac)
    x0, y0, x1, y1 = box
    if kind == "clone":  # object removal / duplication inside the same photo
        sx, sy, _, _ = rand_box(W, H, frac)
        img.paste(img.crop((sx, sy, sx + x1 - x0, sy + y1 - y0)), (x0, y0))
    elif kind == "splice":  # object inserted from another photo
        o = rng.choice(others)
        ox, oy, _, _ = rand_box(o.size[0], o.size[1], frac * (W * H) / (o.size[0] * o.size[1]))
        img.paste(o.crop((ox, oy, ox + x1 - x0, oy + y1 - y0)), (x0, y0))
    elif kind == "text":  # e.g. a changed caption / date / number plate
        d = ImageDraw.Draw(img)
        fs = max(12, (y1 - y0) // 2)
        d.text((x0, y0 + (y1 - y0) // 4), "FAKE 21:45", font=font(fs), fill=(255, 255, 255),
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
    x0, y0, x1, y1 = box
    A = np.asarray(a.crop(box)).astype(np.int32)
    B = np.asarray(b.crop(box)).astype(np.int32)
    ya = (19595 * A[..., 0] + 38470 * A[..., 1] + 7471 * A[..., 2]) >> 16
    yb = (19595 * B[..., 0] + 38470 * B[..., 1] + 7471 * B[..., 2]) >> 16
    return float(np.abs(ya - yb).mean()), float(np.abs(A - B).mean())


EDITS = [("clone", 0.01), ("clone", 0.03), ("splice", 0.01), ("splice", 0.03), ("text", 0.02),
         ("recolor", 0.03), ("blur", 0.02), ("flatfill", 0.01), ("clone", 0.004), ("text", 0.008)]
EDIT_PLATFORMS = ["editor_save", "whatsapp_std", "whatsapp_hd"]

jobs = {"originals": [], "variants": [], "parity": []}
display_images = []

for idx, src in enumerate(SOURCES):
    base = Image.open(src).convert("RGB")
    w, h = base.size
    cw = min(w, h * 4 // 3)
    ch = cw * 3 // 4
    base = base.crop(((w - cw) // 2, (h - ch) // 2, (w - cw) // 2 + cw, (h - ch) // 2 + ch)).resize((4000, 3000), Image.LANCZOS)
    arr = np.asarray(base).astype(np.float32) + nrng.normal(0, 2.5, (3000, 4000, 3))
    stored = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
    portrait = idx % 4 == 3
    exif = Image.Exif()
    exif[274] = 6 if portrait else 1
    jpeg = encode(stored, 95, exif.tobytes())
    oid = f"o{idx:02d}"
    with open(os.path.join(OUT, oid + ".jpg"), "wb") as f:
        f.write(jpeg)
    pt, stored_size, decoded_size = phone_thumb(jpeg, 90 if portrait else 0)
    display = decode(jpeg)
    display_images.append(display)
    jobs["originals"].append({
        "id": oid, "src": os.path.basename(src), "portrait": portrait, "stored": stored_size,
        "phoneDecoded": decoded_size, "display": display.size,
        "phoneThumb": save_thumb(oid + "_phone", pt),
        "fullThumb": save_thumb(oid + "_full", thumbnails(np.asarray(display))),
    })
    print(f"[{idx + 1}/{len(SOURCES)}] {oid} {os.path.basename(src)} portrait={portrait}", flush=True)

    for pname in list(PLATFORMS) + ["wa_then_telegram"]:
        data = platform(display, pname)
        im = decode(data)
        vid = f"{oid}_{pname}"
        jobs["variants"].append({"id": vid, "ref": oid, "kind": "clean", "platform": pname, "size": im.size,
                                 "bytes": len(data), "thumb": save_thumb(vid, thumbnails(np.asarray(im)))})
        if idx < 3 and pname in ("telegram", "screenshot_png", "instagram"):
            raw = os.path.join(OUT, vid + ".rgba")
            with open(raw, "wb") as f:
                f.write(np.asarray(im.convert("RGBA")).tobytes())
            jobs["parity"].append({"raw": raw, "w": im.size[0], "h": im.size[1], "thumb": vid})

for idx, display in enumerate(display_images):
    oid = f"o{idx:02d}"
    others = [d for j, d in enumerate(display_images) if j != idx]
    for kind, frac in EDITS:
        edited, box = apply_edit(display, kind, frac, others)
        magY, magRGB = magnitude(display, edited, box)
        W, H = display.size
        nbox = [box[0] / W, box[1] / H, box[2] / W, box[3] / H]
        saved = encode(edited, 92)
        for pname in EDIT_PLATFORMS:
            data = saved if pname == "editor_save" else platform(decode(saved), pname)
            im = decode(data)
            vid = f"{oid}_{kind}{frac}_{pname}"
            jobs["variants"].append({"id": vid, "ref": oid, "kind": "edit", "edit": kind, "frac": frac,
                                     "platform": pname, "box": nbox, "magY": magY, "magRGB": magRGB,
                                     "thumb": save_thumb(vid, thumbnails(np.asarray(im)))})
    print(f"edits done for {oid}", flush=True)

with open(os.path.join(OUT, "jobs.json"), "w") as f:
    json.dump(jobs, f, indent=1)
print("variants:", len(jobs["variants"]))
