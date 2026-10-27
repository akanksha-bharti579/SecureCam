package com.example.securecam

import android.Manifest
import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ColorSpace
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.WindowManager
import android.provider.MediaStore
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.text.InputType
import android.util.Log
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.*
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.exifinterface.media.ExifInterface
import java.io.ByteArrayInputStream
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

class MainActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "SecureCam"
        // v2 key: generated with an attestation challenge so the registry can verify it is hardware-backed.
        // v3: new key whose attestation also carries the phone brand and model (Android 12+).
        // Records signed with the older securecam_key_v2 key stay valid in the registry.
        private const val KEY_ALIAS = "securecam_key_v3"
        private val ATTESTATION_CHALLENGE = "SecureCam-v2-attestation".toByteArray(Charsets.UTF_8)
        private const val AUTO_CAPTURES = 100   // bench build: captures per long-press
        private const val AUTO_GAP_MS = 2000L   // pause after each capture finishes
    }

    private lateinit var viewFinder: PreviewView
    private lateinit var hashResultText: TextView
    private lateinit var captureButton: Button
    private lateinit var shareButton: Button
    private lateinit var serverButton: Button

    private var imageCapture: ImageCapture? = null
    private var lastSavedUri: Uri? = null
    private lateinit var cameraExecutor: ExecutorService
    private lateinit var networkExecutor: ExecutorService
    private lateinit var registry: RegistryClient

    @Volatile private var keySecurity = "unknown"
    @Volatile private var lastCaptureText = ""
    @Volatile private var registryText = ""

    // Benchmark build only (BuildConfig.AUTO_CAPTURE): captures still to take after a long-press.
    @Volatile private var autoRemaining = 0
    private val mainHandler = Handler(Looper.getMainLooper())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        viewFinder     = findViewById(R.id.viewFinder)
        hashResultText = findViewById(R.id.hashResultText)
        captureButton  = findViewById(R.id.captureButton)
        shareButton    = findViewById(R.id.shareButton)
        serverButton   = findViewById(R.id.serverButton)

        cameraExecutor = Executors.newSingleThreadExecutor()
        networkExecutor = Executors.newSingleThreadExecutor()
        registry = RegistryClient(this)

        hashResultText.text = "Initialising secure key..."
        cameraExecutor.execute {
            keySecurity = try { ensureHardwareKey() } catch (e: Exception) { "ERROR: ${e.message}" }
            lastCaptureText = "🔒 Key ready — ${describe(keySecurity)}\nTap TAKE PHOTO."
            refreshStatus()
            flushRegistry()
        }

        if (allPermissionsGranted()) {
            startCamera()
        } else {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.CAMERA), 10)
        }

        captureButton.setOnClickListener { takePhotoSignAndSave() }
        shareButton.setOnClickListener   { shareLastPhoto() }
        serverButton.setOnClickListener  { editServerUrl() }
        if (BuildConfig.AUTO_CAPTURE) captureButton.setOnLongClickListener { startAutoCapture(AUTO_CAPTURES); true }
    }

    // ─── TIMING BENCHMARK (bench build only) ──────────────────────────────────

    /** Long-press: [n] captures, each started AUTO_GAP_MS after the previous one has finished. */
    private fun startAutoCapture(n: Int) {
        if (autoRemaining > 0) return
        autoRemaining = n
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        takePhotoSignAndSave()
    }

    private fun nextAutoCapture() {
        if (!BuildConfig.AUTO_CAPTURE || autoRemaining <= 0) return
        autoRemaining--
        if (autoRemaining > 0) {
            mainHandler.postDelayed({ takePhotoSignAndSave() }, AUTO_GAP_MS)
        } else {
            runOnUiThread { window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
        }
    }

    // ─── KEY (EC P-256, attested, StrongBox when available) ────────────────────

    private fun ensureHardwareKey(): String {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        if (!ks.containsAlias(KEY_ALIAS)) {
            // Prefer StrongBox, and an attestation that names the phone model; fall back step by step.
            val sb = Build.VERSION.SDK_INT >= 28
            val made = (sb && generateKey(strongBox = true, deviceProps = true)) || (sb && generateKey(strongBox = true, deviceProps = false)) ||
                generateKey(strongBox = false, deviceProps = true) || generateKey(strongBox = false, deviceProps = false)
            if (!made) error("could not create a hardware-backed signing key")
        }
        return securityLevel(ks)
    }

    private fun generateKey(strongBox: Boolean, deviceProps: Boolean): Boolean = try {
        if (deviceProps && Build.VERSION.SDK_INT < 31) error("device properties need Android 12")
        val spec = KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            // DIGEST_NONE lets us send only the 32-byte SHA-256 into the secure chip (fast path).
            .setDigests(KeyProperties.DIGEST_SHA256, KeyProperties.DIGEST_NONE)
            .setAttestationChallenge(ATTESTATION_CHALLENGE)
        if (Build.VERSION.SDK_INT >= 28) spec.setIsStrongBoxBacked(strongBox)
        // Brand, model and manufacturer go into the hardware-signed attestation, so the registry can show them.
        if (deviceProps && Build.VERSION.SDK_INT >= 31) spec.setDevicePropertiesAttestationIncluded(true)
        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
            .apply { initialize(spec.build()) }.generateKeyPair()
        true
    } catch (e: Exception) {
        Log.w(TAG, "key generation failed (strongBox=$strongBox, deviceProps=$deviceProps)", e)
        false
    }

    /** Reads where the key really lives, instead of assuming StrongBox. */
    @Suppress("DEPRECATION")
    private fun securityLevel(ks: KeyStore): String {
        val key = ks.getKey(KEY_ALIAS, null) as PrivateKey
        val info = KeyFactory.getInstance(key.algorithm, "AndroidKeyStore").getKeySpec(key, KeyInfo::class.java)
        if (Build.VERSION.SDK_INT >= 31) {
            return when (info.securityLevel) {
                KeyProperties.SECURITY_LEVEL_STRONGBOX -> "StrongBox"
                KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT -> "TEE"
                KeyProperties.SECURITY_LEVEL_SOFTWARE -> "Software"
                else -> "SecureHardware"
            }
        }
        return if (info.isInsideSecureHardware) "SecureHardware" else "Software"
    }

    private fun describe(level: String) = when (level) {
        "StrongBox" -> "StrongBox (dedicated secure chip, e.g. Knox Vault)"
        "TEE" -> "TEE (ARM TrustZone)"
        "Software" -> "SOFTWARE ONLY — not hardware-protected"
        else -> level
    }

    // ─── CAMERA ────────────────────────────────────────────────────────────────

    private fun startCamera() {
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener({
            val provider = future.get()
            val preview = Preview.Builder().build().also {
                it.setSurfaceProvider(viewFinder.surfaceProvider)
            }
            imageCapture = ImageCapture.Builder().build()
            try {
                provider.unbindAll()
                provider.bindToLifecycle(
                    this, CameraSelector.DEFAULT_BACK_CAMERA, preview, imageCapture
                )
            } catch (e: Exception) {
                Toast.makeText(this, "Camera error", Toast.LENGTH_SHORT).show()
            }
        }, ContextCompat.getMainExecutor(this))
    }

    // ─── FINGERPRINT (survives re-encoding; see securecam-core.js) ─────────────

    private class Fingerprint(val thumbs: Scfp.Thumbs, val width: Int, val height: Int)

    private fun fingerprint(jpeg: ByteArray): Fingerprint {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size, bounds)
        val w0 = bounds.outWidth
        val h0 = bounds.outHeight
        // Decode at reduced size (JPEG DCT scaling): the 128x128 fingerprint does not need full resolution.
        var sample = 1
        while (minOf(w0, h0) / (sample * 2) >= 512) sample *= 2
        val opts = BitmapFactory.Options().apply {
            inSampleSize = sample
            inPreferredConfig = Bitmap.Config.ARGB_8888
            inPreferredColorSpace = ColorSpace.get(ColorSpace.Named.SRGB) // browsers compare in sRGB
        }
        val bmp = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size, opts) ?: error("could not decode the captured JPEG")
        val px = IntArray(bmp.width * bmp.height)
        bmp.getPixels(px, 0, bmp.width, 0, 0, bmp.width, bmp.height)
        val rotation = ExifInterface(ByteArrayInputStream(jpeg)).rotationDegrees
        val thumbs = Scfp.rotate(Scfp.fromArgb(px, bmp.width, bmp.height), rotation)
        bmp.recycle()
        return if (rotation % 180 == 0) Fingerprint(thumbs, w0, h0) else Fingerprint(thumbs, h0, w0)
    }

    // ─── CAPTURE → HASH → FINGERPRINT → SIGN → SAVE → REGISTER ────────────────

    private fun takePhotoSignAndSave() {
        val imageCapture = imageCapture ?: return
        runOnUiThread { hashResultText.text = "📸 Capturing..." }

        imageCapture.takePicture(
            cameraExecutor,
            object : ImageCapture.OnImageCapturedCallback() {

                override fun onCaptureSuccess(image: ImageProxy) {
                    try {
                        // 1. Exact JPEG bytes from the camera (remaining() = real bytes, no padding)
                        val buf = image.planes[0].buffer
                        val rawJpeg = ByteArray(buf.remaining()).also { buf.get(it) }
                        image.close()

                        // 2. SHA-256 of the file bytes (exact proof)
                        val t0 = SystemClock.elapsedRealtimeNanos()
                        val fileSha = ScCrypto.sha256(rawJpeg)
                        val t1 = SystemClock.elapsedRealtimeNanos()

                        // 3. Visual fingerprint (proof that survives WhatsApp/Instagram re-encoding)
                        val fp = fingerprint(rawJpeg)
                        val thumbBytes = fp.thumbs.bytes()
                        val t2 = SystemClock.elapsedRealtimeNanos()

                        // 4. Manifest binding both proofs, signed inside secure hardware
                        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
                        val spki = ks.getCertificate(KEY_ALIAS).publicKey.encoded
                        val manifest = ScManifest.build(
                            app = packageName,
                            capturedUtc = Instant.now().truncatedTo(ChronoUnit.MILLIS).toString(),
                            fileSha256 = ScCrypto.hex(fileSha),
                            phash = Scfp.phash(fp.thumbs.y),
                            thumbSha256 = ScCrypto.hex(ScCrypto.sha256(thumbBytes)),
                            width = fp.width, height = fp.height,
                            keyId = ScCrypto.hex(ScCrypto.sha256(spki)),
                            security = keySecurity
                        )
                        val privateKey = ks.getKey(KEY_ALIAS, null) as PrivateKey
                        val der = Signature.getInstance("NONEwithECDSA").apply {
                            initSign(privateKey)
                            update(ScCrypto.sha256(manifest)) // only 32 bytes cross into the chip
                        }.sign()
                        val t3 = SystemClock.elapsedRealtimeNanos()
                        val sig = ScCrypto.derToRawEcdsa(der)

                        // 5. Append the v2 block after the JPEG's FF D9 and save to the gallery
                        val finalBytes = rawJpeg + ScTrailer.v2(manifest, sig, spki, thumbBytes)
                        val cv = ContentValues().apply {
                            put(MediaStore.Images.Media.DISPLAY_NAME, "SecureCam_${System.currentTimeMillis()}.jpg")
                            put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg")
                            put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/SecureCam")
                        }
                        val uri = contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, cv)
                            ?: error("could not create gallery entry")
                        contentResolver.openOutputStream(uri)?.use { it.write(finalBytes) }
                            ?: error("could not write gallery entry")
                        lastSavedUri = uri
                        val t4 = SystemClock.elapsedRealtimeNanos()

                        // 6. Queue the record for the registry (sent now if online, later otherwise)
                        val chain = ks.getCertificateChain(KEY_ALIAS)?.map { it.encoded } ?: emptyList()
                        registry.enqueue(ScTrailer.registryPayload(manifest, sig, spki, thumbBytes, chain))

                        fun ms(a: Long, b: Long) = "%.1f".format(java.util.Locale.US, (b - a) / 1e6)
                        // One line per capture for the timing benchmark (tools/capture_benchmark.py)
                        Log.i(TAG, "TIMING hash=${ms(t0, t1)} fingerprint=${ms(t1, t2)} sign=${ms(t2, t3)} " +
                            "save=${ms(t3, t4)} total=${ms(t0, t4)} bytes=${rawJpeg.size} w=${fp.width} h=${fp.height}")
                        lastCaptureText =
                            "✅ SIGNED & SAVED (v2)\n" +
                            "🔑 Key: ${describe(keySecurity)}\n" +
                            "#️⃣ SHA-256: ${ScCrypto.hex(fileSha).take(24)}…\n" +
                            "⏱ Hash ${ms(t0, t1)} ms · Fingerprint ${ms(t1, t2)} ms · Sign ${ms(t2, t3)} ms\n" +
                            "⚡ Total ${ms(t0, t4)} ms (incl. save)" +
                            (if (autoRemaining > 0) "\n🔁 Auto-capture ${AUTO_CAPTURES - autoRemaining + 1}/$AUTO_CAPTURES" else "")
                        refreshStatus()
                        flushRegistry()
                    } catch (e: Exception) {
                        Log.e(TAG, "capture failed", e)
                        runOnUiThread { hashResultText.text = "❌ Error: ${e.message}" }
                    } finally {
                        try { image.close() } catch (_: Exception) {}
                        nextAutoCapture()
                    }
                }

                override fun onError(exc: ImageCaptureException) {
                    runOnUiThread { hashResultText.text = "❌ ${exc.message}" }
                    nextAutoCapture()
                }
            }
        )
    }

    // ─── REGISTRY ──────────────────────────────────────────────────────────────

    private fun flushRegistry() {
        networkExecutor.execute {
            val r = registry.flush()
            registryText = when {
                r.message != null && r.pending > 0 -> "🌐 Registry: ${r.pending} waiting — ${r.message}"
                r.message != null -> "🌐 Registry: ${r.message}"
                r.sent > 0 -> "🌐 Registry: uploaded ✓ (${r.sent})"
                else -> "🌐 Registry: up to date"
            }
            refreshStatus()
        }
    }

    private fun refreshStatus() = runOnUiThread {
        hashResultText.text = listOf(lastCaptureText, registryText).filter { it.isNotEmpty() }.joinToString("\n")
    }

    private fun editServerUrl() {
        val input = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            hint = "http://192.168.1.5:8787"
            setText(registry.serverUrl)
        }
        AlertDialog.Builder(this)
            .setTitle("Registry server URL")
            .setMessage("Shown in the laptop terminal when the server starts.")
            .setView(input)
            .setPositiveButton("Save") { _, _ ->
                registry.serverUrl = input.text.toString()
                flushRegistry()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    // ─── SHARE ─────────────────────────────────────────────────────────────────

    private fun shareLastPhoto() {
        val uri = lastSavedUri ?: run {
            Toast.makeText(this, "Take a photo first!", Toast.LENGTH_SHORT).show()
            return
        }
        startActivity(Intent.createChooser(
            Intent(Intent.ACTION_SEND).apply {
                type = "image/jpeg"
                putExtra(Intent.EXTRA_STREAM, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }, "Share signed photo via..."
        ))
    }

    // ─── PERMISSIONS ───────────────────────────────────────────────────────────

    override fun onRequestPermissionsResult(
        requestCode: Int, permissions: Array<String>, grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 10 && allPermissionsGranted()) startCamera()
    }

    private fun allPermissionsGranted() = ContextCompat.checkSelfPermission(
        baseContext, Manifest.permission.CAMERA
    ) == PackageManager.PERMISSION_GRANTED

    override fun onDestroy() {
        super.onDestroy()
        cameraExecutor.shutdown()
        networkExecutor.shutdown()
    }
}
