"""Generates synthetic Android key-attestation chains for the server tests.

A test root stands in for Google's root (the tests pass it explicitly; the
real server only trusts Google's published roots). Each case has its own leaf
key so a test can sign a SecureCam manifest with the attested key.

Usage: python make_attestation_fixtures.py [out.json]
"""
import base64
import datetime as dt
import hashlib
import json
import os
import sys

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "attestation.json")
CHALLENGE = b"SecureCam-v2-attestation"
PACKAGE = b"com.example.securecam"
KD_OID = x509.ObjectIdentifier("1.3.6.1.4.1.11129.2.1.17")


# ── tiny DER encoder ──────────────────────────────────────────────────────────
def _len(n):
    if n < 0x80:
        return bytes([n])
    b = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return bytes([0x80 | len(b)]) + b


def tlv(tag: bytes, content: bytes) -> bytes:
    return tag + _len(len(content)) + content


def INT(n):
    return tlv(b"\x02", n.to_bytes(max(1, (n.bit_length() + 8) // 8), "big", signed=True))


def ENUM(n):
    return tlv(b"\x0a", n.to_bytes(1, "big"))


def OCT(b):
    return tlv(b"\x04", b)


def BOOL(v):
    return tlv(b"\x01", b"\xff" if v else b"\x00")


def SEQ(*items):
    return tlv(b"\x30", b"".join(items))


def SET(*items):
    return tlv(b"\x31", b"".join(sorted(items)))


def EXPLICIT(n, content):
    if n < 31:
        tag = bytes([0xA0 | n])
    else:
        digits = []
        while True:
            digits.insert(0, n & 0x7F)
            n >>= 7
            if not n:
                break
        tag = bytes([0xBF] + [d | 0x80 for d in digits[:-1]] + [digits[-1]])
    return tlv(tag, content)


def key_description(sec=2, challenge=CHALLENGE, package=PACKAGE, boot_state=0, locked=True, origin=0, device_ids=False):
    app_id = SEQ(SET(SEQ(OCT(package), INT(1))), SET(OCT(hashlib.sha256(b"debug-cert").digest())))
    sw = SEQ(EXPLICIT(701, INT(1790000000000)), EXPLICIT(709, OCT(app_id)))
    hw = SEQ(
        EXPLICIT(1, SET(INT(2), INT(3))),
        EXPLICIT(2, INT(3)),
        EXPLICIT(3, INT(256)),
        EXPLICIT(5, SET(INT(0), INT(4))),
        EXPLICIT(10, INT(1)),
        EXPLICIT(702, INT(origin)),
        EXPLICIT(704, SEQ(OCT(b"\x11" * 32), BOOL(locked), ENUM(boot_state), OCT(b"\x22" * 32))),
        EXPLICIT(705, INT(150000)),
        EXPLICIT(706, INT(202609)),
        # device identity, as attested when the app calls setDevicePropertiesAttestationIncluded(true)
        *([EXPLICIT(710, OCT(b"samsung")), EXPLICIT(711, OCT(b"dm1q")), EXPLICIT(712, OCT(b"dm1qxxx")),
           EXPLICIT(716, OCT(b"samsung")), EXPLICIT(717, OCT(b"SM-S911B"))] if device_ids else []),
    )
    return SEQ(INT(300), ENUM(sec), INT(300), ENUM(sec), OCT(challenge), OCT(b""), sw, hw)


# ── certificates ──────────────────────────────────────────────────────────────
NOW = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)


def name(cn):
    return x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn)])


def cert(subject_key, subject_cn, issuer_key, issuer_cn, ca, serial=None, ext=None, valid=None):
    b = (x509.CertificateBuilder()
         .subject_name(name(subject_cn)).issuer_name(name(issuer_cn))
         .public_key(subject_key.public_key())
         .serial_number(serial or x509.random_serial_number())
         .not_valid_before(valid[0] if valid else NOW).not_valid_after(valid[1] if valid else NOW + dt.timedelta(days=3650))
         .add_extension(x509.BasicConstraints(ca=ca, path_length=None), critical=True))
    if ext is not None:
        b = b.add_extension(x509.UnrecognizedExtension(KD_OID, ext), critical=False)
    return b.sign(issuer_key, hashes.SHA256())


def der(c):
    return base64.b64encode(c.public_bytes(serialization.Encoding.DER)).decode()


root_key = ec.generate_private_key(ec.SECP384R1())
root = cert(root_key, "Test Attestation Root", root_key, "Test Attestation Root", True)
other_key = ec.generate_private_key(ec.SECP384R1())
other_root = cert(other_key, "Untrusted Root", other_key, "Untrusted Root", True)
inter_key = ec.generate_private_key(ec.SECP256R1())
inter = cert(inter_key, "Test Attestation Intermediate", root_key, "Test Attestation Root", True)
revoked_serial = 0x5EC0CA2026
revoked_inter = cert(inter_key, "Revoked Intermediate", root_key, "Test Attestation Root", True, serial=revoked_serial)
other_inter = cert(inter_key, "Intermediate under other root", other_key, "Untrusted Root", True)
stranger_key = ec.generate_private_key(ec.SECP256R1())

CASES = {
    "good_strongbox": {},
    "good_tee": {"sec": 1},
    "good_strongbox_device_ids": {"device_ids": True},
    "expired_root_copy": {"_chain": "old_root"},
    "expired_intermediate": {"_chain": "old_inter"},
    "wrong_challenge": {"challenge": b"some other challenge"},
    "software_key": {"sec": 0},
    "unverified_boot": {"boot_state": 2},
    "unlocked_bootloader": {"locked": False},
    "wrong_package": {"package": b"com.evil.fakecam"},
    "imported_key": {"origin": 2},
    "untrusted_root": {"_chain": "other"},
    "broken_chain": {"_chain": "broken"},
    "revoked_intermediate": {"_chain": "revoked"},
    "no_extension": {"_noext": True},
}

out = {"testRootPem": root.public_bytes(serialization.Encoding.PEM).decode(),
       "challenge": CHALLENGE.decode(), "package": PACKAGE.decode(),
       "revocationStatus": {"entries": {format(revoked_serial, "x"): {"status": "REVOKED", "reason": "KEY_COMPROMISE"}}},
       "cases": {}}

for case, p in CASES.items():
    leaf_key = ec.generate_private_key(ec.SECP256R1())
    kd = None if p.get("_noext") else key_description(**{k: v for k, v in p.items() if not k.startswith("_")})
    mode = p.get("_chain")
    if mode == "other":
        leaf = cert(leaf_key, "Android Keystore Key", inter_key, "Intermediate under other root", False, ext=kd)
        chain = [leaf, other_inter, other_root]
    elif mode == "broken":
        leaf = cert(leaf_key, "Android Keystore Key", stranger_key, "Test Attestation Intermediate", False, ext=kd)
        chain = [leaf, inter, root]
    elif mode == "old_root":  # same root key, but the device's copy of the root certificate has expired
        old_root = cert(root_key, "Test Attestation Root", root_key, "Test Attestation Root", True,
                        valid=(NOW - dt.timedelta(days=3650), NOW - dt.timedelta(days=30)))
        leaf = cert(leaf_key, "Android Keystore Key", inter_key, "Test Attestation Intermediate", False, ext=kd)
        chain = [leaf, inter, old_root]
    elif mode == "old_inter":  # an expired intermediate must still be refused
        old_inter = cert(inter_key, "Test Attestation Intermediate", root_key, "Test Attestation Root", True,
                         valid=(NOW - dt.timedelta(days=3650), NOW - dt.timedelta(days=30)))
        leaf = cert(leaf_key, "Android Keystore Key", inter_key, "Test Attestation Intermediate", False, ext=kd)
        chain = [leaf, old_inter, root]
    elif mode == "revoked":
        leaf = cert(leaf_key, "Android Keystore Key", inter_key, "Revoked Intermediate", False, ext=kd)
        chain = [leaf, revoked_inter, root]
    else:
        leaf = cert(leaf_key, "Android Keystore Key", inter_key, "Test Attestation Intermediate", False, ext=kd)
        chain = [leaf, inter, root]
    out["cases"][case] = {
        "chain": [der(c) for c in chain],
        "leafKeyPkcs8Pem": leaf_key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                                  serialization.NoEncryption()).decode(),
    }

with open(OUT, "w") as f:
    json.dump(out, f, indent=1)
print("wrote", OUT, "with", len(CASES), "cases")
