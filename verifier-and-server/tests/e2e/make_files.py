"""Builds the image files for the browser end-to-end test.

Takes camera originals from the experiment dataset, computes the phone-side
fingerprint exactly like MainActivity (sample-size decode + EXIF rotation of the
grid), and makes platform copies/edits. sign_and_register.js then signs and
registers them.

Usage: python make_files.py <experiment_out_dir> <e2e_out_dir>
"""
import io
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageOps

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "experiment"))
from scfp import rotate_thumbs, thumbnails  # noqa: E402

EXP, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)


def phone_thumb(jpeg):
    im = Image.open(io.BytesIO(jpeg))
    w, h = im.size
    rot = {6: 90, 3: 180, 8: 270}.get(im.getexif().get(274, 1), 0)
    s = 1
    while min(w, h) // (s * 2) >= 512:
        s *= 2
    im.draft("RGB", (w // s, h // s))
    t = rotate_thumbs(thumbnails(np.asarray(im.convert("RGB"))), rot)
    return t, (w, h) if rot % 180 == 0 else (h, w)


def display(jpeg):
    return ImageOps.exif_transpose(Image.open(io.BytesIO(jpeg))).convert("RGB")


def whatsapp(img, long_side=1600, q=75):
    w, h = img.size
    s = min(1, long_side / max(w, h))
    img = img.resize((round(w * s), round(h * s)), Image.BICUBIC)
    b = io.BytesIO()
    img.save(b, "JPEG", quality=q)
    return b.getvalue()


def write(name, data):
    with open(os.path.join(OUT, name), "wb") as f:
        f.write(data)


job = {"originals": []}
for oid, label in (("o00", "landscape"), ("o03", "portrait")):
    jpeg = open(os.path.join(EXP, oid + ".jpg"), "rb").read()
    t, (w, h) = phone_thumb(jpeg)
    write(f"{label}_camera.jpg", jpeg)
    write(f"{label}.thumb", t)
    job["originals"].append({"label": label, "jpeg": f"{label}_camera.jpg", "thumb": f"{label}.thumb", "w": w, "h": h})

land = display(open(os.path.join(EXP, "o00.jpg"), "rb").read())
port = display(open(os.path.join(EXP, "o03.jpg"), "rb").read())
write("C_whatsapp_copy.jpg", whatsapp(land))
write("D_portrait_whatsapp_copy.jpg", whatsapp(port))

edited = land.copy()
d = ImageDraw.Draw(edited)
W, H = edited.size
font = ImageFont.truetype(r"C:\Windows\Fonts\arialbd.ttf", 150)
d.text((int(W * 0.58), int(H * 0.62)), "FAKE 21:45", font=font, fill=(255, 255, 255), stroke_width=10, stroke_fill=(0, 0, 0))
write("E_edited_then_whatsapp.jpg", whatsapp(edited))

write("F_unrelated_photo.jpg", whatsapp(display(open(os.path.join(EXP, "o05.jpg"), "rb").read())))
crop = land.crop((int(W * 0.2), 0, int(W * 0.2) + int(H * 0.8), H))  # 4:5 portrait crop like Instagram
write("G_instagram_crop.jpg", whatsapp(crop, 1350, 78))
# Raw camera files that the signer script turns into an unregistered-key file and a v1 file.
write("unregistered_camera.jpg", open(os.path.join(EXP, "o06.jpg"), "rb").read())
write("v1_camera.jpg", open(os.path.join(EXP, "o07.jpg"), "rb").read())

with open(os.path.join(OUT, "job.json"), "w") as f:
    json.dump(job, f, indent=1)
print("wrote e2e files to", OUT)
