"""Makes platform copies / edits of REAL SecureCam photos pulled from the phone.

Usage: python make_real_copies.py <dir_with_SecureCam_jpgs> <out_dir>
Writes the copies plus cases.json for browser_test.js (CASES_JSON=...).
"""
import io
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont, ImageOps

SRC, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)
photos = sorted(f for f in os.listdir(SRC) if f.startswith("SecureCam_") and f.endswith(".jpg"))

PLATFORMS = {  # long side / fixed width, quality, resampling
    "whatsapp": (1600, None, 75, Image.BICUBIC),
    "whatsapp_hd": (4096, None, 85, Image.BICUBIC),
    "telegram": (1280, None, 87, Image.LANCZOS),
    "instagram": (None, 1080, 78, Image.BILINEAR),
    "facebook": (2048, None, 71, Image.LANCZOS),
    "low_quality": (1600, None, 55, Image.BICUBIC),
    "screenshot": (1080, None, "png", Image.BILINEAR),
}


def platform(img, name):
    long_side, width, q, res = PLATFORMS[name]
    w, h = img.size
    s = width / w if width else min(1, long_side / max(w, h))
    if s < 1:
        img = img.resize((round(w * s), round(h * s)), res)
    b = io.BytesIO()
    img.save(b, "PNG" if q == "png" else "JPEG", **({} if q == "png" else {"quality": q}))
    return b.getvalue(), "png" if q == "png" else "jpg"


cases = []
for n, f in enumerate(photos, 1):
    raw = open(os.path.join(SRC, f), "rb").read()
    tag = f"R{n}"
    with open(os.path.join(OUT, f"{tag}_original.jpg"), "wb") as o:
        o.write(raw)
    cases.append([f"{tag}_original.jpg", "AUTHENTIC"])
    disp = ImageOps.exif_transpose(Image.open(io.BytesIO(raw))).convert("RGB")
    for p in (PLATFORMS if n == 1 else ["whatsapp"]):
        data, ext = platform(disp, p)
        name = f"{tag}_{p}.{ext}"
        open(os.path.join(OUT, name), "wb").write(data)
        cases.append([name, "AUTHENTIC COPY"])
    if n == 1:
        W, H = disp.size
        # Edited, then sent: a caption added, and an area painted over (object removal).
        e = disp.copy()
        ImageDraw.Draw(e).text((int(W * 0.08), int(H * 0.45)), "FAKE 21:45", font=ImageFont.truetype(r"C:\Windows\Fonts\arialbd.ttf", W // 9),
                               fill=(255, 255, 255), stroke_width=W // 200, stroke_fill=(0, 0, 0))
        data, _ = platform(e, "whatsapp")
        open(os.path.join(OUT, f"{tag}_edited_caption_whatsapp.jpg"), "wb").write(data)
        cases.append([f"{tag}_edited_caption_whatsapp.jpg", "MODIFIED"])
        e2 = disp.copy()
        box = (int(W * 0.55), int(H * 0.2), int(W * 0.8), int(H * 0.35))
        e2.paste(disp.crop((int(W * 0.1), int(H * 0.7), int(W * 0.35), int(H * 0.85))), box[:2])
        data, _ = platform(e2, "whatsapp")
        open(os.path.join(OUT, f"{tag}_edited_clone_whatsapp.jpg"), "wb").write(data)
        cases.append([f"{tag}_edited_clone_whatsapp.jpg", "MODIFIED"])
        t = bytearray(raw)
        t[len(raw) // 3] ^= 0x04  # one byte inside the image data; signature block untouched
        open(os.path.join(OUT, f"{tag}_one_byte_changed.jpg"), "wb").write(t)
        cases.append([f"{tag}_one_byte_changed.jpg", "TAMPERED"])

json.dump(cases, open(os.path.join(OUT, "cases.json"), "w"), indent=1)
print(len(cases), "cases written to", OUT)
