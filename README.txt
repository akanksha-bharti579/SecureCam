SecureCam - Secure Camera Authentication Using Hardware-Backed Digital Signatures
Subhajit Masanta (23BCE0292), Akanksha Bharti (23BCE0257)
Guide: Dr. Satish C. J.

FOLDERS
-------
SecureCam/               Android Studio project of the capture app (Kotlin, CameraX, Android Keystore)
                        Main code: SecureCam/app/src/main/java/com/example/securecam/
                          MainActivity.kt    - camera, key generation with attestation, signing, upload
                          Provenance.kt      - visual fingerprint, manifest and signed block
                          RegistryClient.kt  - sends the record to the registry
                          BenchmarkActivity.kt - timing of the capture steps
                        Unit test: SecureCam/app/src/test/java/com/example/securecam/ProvenanceTest.kt
SecureCam-app-debug.apk Built app, can be installed directly on an Android phone
verifier-and-server/    Web verifier, registry server, tests and tools
  index.html            Web verifier page (runs fully in the browser)
  securecam-core.js     Fingerprint and comparison code (used by verifier, server and tests)
  registry-server/      Node.js registry server (no npm packages needed)
    server.js           HTTP API, stores records
    attestation.js      Checks Android Key Attestation chain against Google roots
    der.js              Small DER (ASN.1) reader
    data/               Records of our photos (needed so the input files below verify)
  tests/                Unit, server, attestation and Kotlin-JavaScript tests
    experiment/vision/  Scripts and result files of the experiments in the paper
    transfer/           Results of real WhatsApp, Telegram, Signal and Instagram transfers
    timing/             Capture time logs from Samsung S23 and Realme 8 (100 photos each)
  tools/                Helper scripts (verify a folder of received photos, tamper test, re-sign test)
  start_demo.ps1        Starts the server and opens the verifier (Windows)
input-files/            9 test photos for checking the verifier

REQUIREMENTS
------------
- Node.js 18 or newer (tested with Node 24)
- Python 3 (only for the tools in tools/)
- Android Studio (only to build the app; the APK is already included)
- Chrome or Edge browser

HOW TO RUN THE VERIFIER
-----------------------
1. Open a terminal in the folder verifier-and-server
2. Run:   node registry-server/server.js
   (if there is no internet:  node registry-server/server.js --offline)
3. Open http://localhost:8787 in the browser
4. Drag a photo from input-files onto the page

Expected results:
  1_original.jpg                   AUTHENTIC        (original file from Samsung S23)
  1b_original_photo_B.jpg          AUTHENTIC        (second original photo)
  2a_whatsapp_real.jpg             AUTHENTIC COPY   (photo 1 really sent through WhatsApp)
  2b_signal_real.jpg               AUTHENTIC COPY   (photo 1 really sent through Signal)
  2c_telegram_real_of_photo_B.jpg  AUTHENTIC COPY   (photo 1b really sent through Telegram)
  3_edited_then_shared_sim.jpg     MODIFIED         ("FAKE" written on photo 1, then recompressed; edited regions shown in red)
  4_tampered_one_byte.jpg          TAMPERED         (one byte of photo 1 changed)
  5_hacker_resigned.jpg            SIGNATURE VALID - DEVICE NOT VERIFIED  (photo 1 re-signed with a laptop key)
  6_normal_photo.jpg               UNVERIFIED       (normal photo, never signed)

Optional strict mode: http://localhost:8787/?strict=1

Check all input files from the command line (no browser):
   python tools/verify_received.py ../input-files
   (this checks only the visual comparison, so originals show AUTHENTIC COPY here)

HOW TO RUN THE TESTS
--------------------
In verifier-and-server:
   node --test tests/core.test.js tests/attestation.test.js tests/server.test.js tests/kotlin-interop.test.js
Expected: 46 tests, 46 pass.

Android unit test: open the SecureCam folder in Android Studio and run ProvenanceTest
(or: gradlew test).

HOW TO USE THE APP
------------------
1. Install SecureCam-app-debug.apk on the phone
2. Start the registry server on the laptop (see above)
3. Connect the phone by USB and run:   adb reverse tcp:8787 tcp:8787
4. In the app set the registry address to http://localhost:8787 and take a photo
5. Open the photo (or a shared copy of it) in the verifier

NOT INCLUDED
------------
The public datasets used in the paper (VISION, Korus, COVERAGE, IMD2020, about 4 GB)
are not included because of their size. tests/experiment/vision/download.py downloads VISION;
the result files of all experiments are included in tests/experiment/vision/.
