# SecureCam: Secure Camera Authentication Using Hardware-Backed Digital Signatures

**Authors:** Subhajit Masanta (23BCE0292), Akanksha Bharti (23BCE0257)  
**Guide:** Dr. Satish C. J.

---

## 📌 Overview

**SecureCam** is an end-to-end image provenance and tamper-detection framework designed to verify authentic photos and distinguish genuine social media compression/transmission copies from malicious image tampering. It utilizes Android Keystore hardware-backed cryptographic signing, key attestation, visual perceptual fingerprinting, and client-side web verification.

---

## 📂 Repository Structure

```
├── SecureCam/               # Android Studio project for capture app (Kotlin, CameraX, Android Keystore)
│   ├── app/src/main/java/com/example/securecam/
│   │   ├── MainActivity.kt        # Camera, hardware-backed key generation with attestation, signing, upload
│   │   ├── Provenance.kt          # Perceptual visual fingerprint, manifest & signed block builder
│   │   ├── RegistryClient.kt      # Uploads records to the verification registry
│   │   └── BenchmarkActivity.kt   # Capture and pipeline step latency benchmarks
│   └── app/src/test/java/com/example/securecam/ProvenanceTest.kt
├── SecureCam-app-debug.apk  # Pre-built debug APK ready to install on Android
├── verifier-and-server/     # Web verifier, registry server, tests, and tools
│   ├── index.html           # In-browser image verifier UI
│   ├── securecam-core.js    # Perceptual fingerprinting & comparison engine (shared across stack)
│   ├── registry-server/     # Node.js registry server (zero external dependencies)
│   │   ├── server.js        # HTTP API for storing & looking up provenance records
│   │   ├── attestation.js   # Android Key Attestation certificate chain validation (Google roots)
│   │   ├── der.js           # Lightweight ASN.1 DER parser
│   │   └── data/            # Pre-registered records for test photos
│   ├── tests/               # Unit, integration, attestation, and Kotlin-JS cross-validation tests
│   │   ├── experiment/vision/ # Benchmarking scripts & experiment dataset results
│   │   ├── transfer/        # Test transfers via WhatsApp, Telegram, Signal, Instagram
│   │   └── timing/          # Capture latency logs (Samsung S23 & Realme 8, 100 photos each)
│   ├── tools/               # Command-line tools (folder verification, tamper simulation, re-sign tests)
│   └── start_demo.ps1       # One-click demo launcher (starts server & opens verifier)
└── input-files/             # Test photos for validating the verifier
```

---

## ⚙️ Prerequisites

- **Node.js** 18 or newer (tested with Node 24)
- **Python 3** (optional, required only for helper CLI tools in `tools/`)
- **Android Studio** (optional, required only to build from source; APK is included)
- **Modern Web Browser** (Chrome or Edge)

---

## 🚀 Quick Start: Running the Verifier

### 1. Launch the Registry Server
Navigate to `verifier-and-server`:
```bash
cd verifier-and-server
node registry-server/server.js
```
*(If offline / no internet connection to fetch Google CRLs: `node registry-server/server.js --offline`)*

Or on Windows PowerShell, run:
```powershell
.\start_demo.ps1
```

### 2. Verify an Image
1. Open [http://localhost:8787](http://localhost:8787) in your browser.
2. Drag and drop any image from `input-files/` directly onto the web interface.

### Expected Results for Sample Inputs

| File | Expected Verdict | Description |
|---|---|---|
| `1_original.jpg` | **AUTHENTIC** | Direct original capture from Samsung Galaxy S23 |
| `1b_original_photo_B.jpg` | **AUTHENTIC** | Second distinct original capture |
| `2a_whatsapp_real.jpg` | **AUTHENTIC COPY** | Photo 1 transmitted through WhatsApp |
| `2b_signal_real.jpg` | **AUTHENTIC COPY** | Photo 1 transmitted through Signal |
| `2c_telegram_real_of_photo_B.jpg` | **AUTHENTIC COPY** | Photo 1b transmitted through Telegram |
| `3_edited_then_shared_sim.jpg` | **MODIFIED** | "FAKE" text added to Photo 1 + recompressed (modified regions highlighted in red) |
| `4_tampered_one_byte.jpg` | **TAMPERED** | One byte altered in original photo |
| `5_hacker_resigned.jpg` | **SIGNATURE VALID - DEVICE NOT VERIFIED** | Re-signed using non-hardware laptop key |
| `6_normal_photo.jpg` | **UNVERIFIED** | Standard untracked camera capture |

*Strict mode available at:* `http://localhost:8787/?strict=1`

### Command-line Batch Verification
```bash
python tools/verify_received.py ../input-files
```

---

## 🧪 Running Automated Tests

Run the test suite in `verifier-and-server`:
```bash
cd verifier-and-server
node --test tests/core.test.js tests/attestation.test.js tests/server.test.js tests/kotlin-interop.test.js
```
*Expected output: 46 passing tests.*

### Android Unit Tests
Open the `SecureCam` project in Android Studio and run `ProvenanceTest`, or execute:
```bash
cd SecureCam
./gradlew test
```

---

## 📱 Testing on an Android Device

1. Install `SecureCam-app-debug.apk` on an Android phone.
2. Start the local registry server on your development machine (see above).
3. Connect the phone via USB with USB debugging enabled, then forward port 8787:
   ```bash
   adb reverse tcp:8787 tcp:8787
   ```
4. In the app settings, set the registry endpoint to `http://localhost:8787` and capture a photo.
5. Upload or drag the captured photo into the web verifier to inspect the provenance and cryptographic verification!
