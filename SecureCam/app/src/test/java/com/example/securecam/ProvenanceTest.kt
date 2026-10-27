package com.example.securecam

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.spec.ECGenParameterSpec

class ProvenanceTest {

    /** Kotlin twin of tests/synth.js — must generate identical pixels. */
    private fun synthArgb(w: Int, h: Int, seed: Int): IntArray {
        var x = seed
        fun next(): Int { x = x xor (x shl 13); x = x xor (x ushr 17); x = x xor (x shl 5); return x }
        fun u(v: Int, m: Int) = ((v.toLong() and 0xFFFFFFFFL) % m).toInt()
        val r = IntArray(w * h); val g = IntArray(w * h); val b = IntArray(w * h)
        for (py in 0 until h) for (px in 0 until w) {
            val i = py * w + px
            r[i] = px * 255 / (w - 1); g[i] = py * 255 / (h - 1); b[i] = (px + py) * 255 / (w + h - 2)
        }
        repeat(12) {
            val rx = u(next(), w); val ry = u(next(), h)
            val rw = 1 + u(next(), w / 3); val rh = 1 + u(next(), h / 3)
            val col = next()
            for (py in ry until minOf(h, ry + rh)) for (px in rx until minOf(w, rx + rw)) {
                val i = py * w + px
                r[i] = (col ushr 16) and 255; g[i] = (col ushr 8) and 255; b[i] = col and 255
            }
        }
        fun cl(v: Int) = if (v < 0) 0 else if (v > 255) 255 else v
        for (p in 0 until w * h) {
            val n = next()
            r[p] = cl(r[p] + (n and 15) - 8)
            g[p] = cl(g[p] + ((n ushr 4) and 15) - 8)
            b[p] = cl(b[p] + ((n ushr 8) and 15) - 8)
        }
        return IntArray(w * h) { (0xFF shl 24) or (r[it] shl 16) or (g[it] shl 8) or b[it] }
    }

    private fun vectorsJson(): String =
        javaClass.classLoader!!.getResourceAsStream("scfp1_vectors.json")!!.readBytes().toString(Charsets.UTF_8)

    @Test
    fun fingerprintMatchesJavaScriptReference() {
        val json = vectorsJson()
        val cosSum = Regex("\"cosSum\":\\s*(-?\\d+)").find(json)!!.groupValues[1].toInt()
        assertEquals("DCT table differs from JS", cosSum, Scfp.COS.sum())
        val objects = Regex("\\{[^{}]*\"phash\"[^{}]*\\}").findAll(json).map { it.value }.toList()
        assertTrue("no vectors found", objects.size >= 6)
        for (o in objects) {
            fun num(k: String) = Regex("\"$k\":\\s*(-?\\d+)").find(o)!!.groupValues[1].toInt()
            fun str(k: String) = Regex("\"$k\":\\s*\"([0-9a-f]+)\"").find(o)!!.groupValues[1]
            val w = num("w"); val h = num("h")
            val t = Scfp.rotate(Scfp.fromArgb(synthArgb(w, h, num("seed")), w, h), num("rot"))
            assertEquals("pHash for $o", str("phash"), Scfp.phash(t.y))
            assertEquals("thumbnail for $o", str("thumbSha256"), ScCrypto.hex(ScCrypto.sha256(t.bytes())))
        }
    }

    @Test
    fun rotationIsExactForAlignedImages() {
        // 256x256 image: rotating the pixels and rotating the thumbnail grid must agree exactly.
        val w = 256
        val px = synthArgb(w, w, 5)
        val rot90 = IntArray(w * w)
        for (r in 0 until w) for (c in 0 until w) rot90[r * w + c] = px[(w - 1 - c) * w + r]
        val a = Scfp.rotate(Scfp.fromArgb(px, w, w), 90).bytes()
        val b = Scfp.fromArgb(rot90, w, w).bytes()
        assertArrayEquals(a, b)
    }

    @Test
    fun derToRawMatchesJavaP1363() {
        val kpg = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }
        val kp = kpg.generateKeyPair()
        repeat(300) { i ->
            val msg = "message $i".toByteArray()
            val der = Signature.getInstance("SHA256withECDSA").apply { initSign(kp.private); update(msg) }.sign()
            val raw = ScCrypto.derToRawEcdsa(der)
            assertEquals(64, raw.size)
            val ok = Signature.getInstance("SHA256withECDSAinP1363Format").apply { initVerify(kp.public); update(msg) }.verify(raw)
            assertTrue("raw signature $i does not verify", ok)
        }
    }

    /**
     * Builds a v2 signed "photo" exactly the way MainActivity does (NONEwithECDSA over the
     * SHA-256 of the manifest), and writes it to build/interop for the JavaScript tests
     * (tests/kotlin-interop.test.js) to verify with securecam-core.js and the server.
     */
    @Test
    fun writesInteropSampleForJavaScript() {
        val kp = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        val w = 640; val h = 480
        val thumbs = Scfp.fromArgb(synthArgb(w, h, 77), w, h)
        val thumbBytes = thumbs.bytes()
        // Fake JPEG body: SOI + filler + EOI. Only the bytes matter for the exact proof.
        val jpeg = byteArrayOf(0xFF.toByte(), 0xD8.toByte()) + ByteArray(5000) { (it * 31).toByte() } +
            byteArrayOf(0xFF.toByte(), 0xD9.toByte())
        val spki = kp.public.encoded
        val manifest = ScManifest.build(
            app = "com.example.securecam", capturedUtc = "2026-09-27T10:15:30.123Z",
            fileSha256 = ScCrypto.hex(ScCrypto.sha256(jpeg)), phash = Scfp.phash(thumbs.y),
            thumbSha256 = ScCrypto.hex(ScCrypto.sha256(thumbBytes)), width = w, height = h,
            keyId = ScCrypto.hex(ScCrypto.sha256(spki)), security = "TEST"
        )
        val der = Signature.getInstance("NONEwithECDSA").apply {
            initSign(kp.private); update(ScCrypto.sha256(manifest))
        }.sign()
        val sig = ScCrypto.derToRawEcdsa(der)
        val file = jpeg + ScTrailer.v2(manifest, sig, spki, thumbBytes)
        val dir = File("build/interop").apply { mkdirs() }
        File(dir, "kotlin_v2_sample.bin").writeBytes(file)
        File(dir, "kotlin_v2_registry_payload.json").writeText(ScTrailer.registryPayload(manifest, sig, spki, thumbBytes, emptyList()))
        assertTrue(file.size > jpeg.size)
    }
}
