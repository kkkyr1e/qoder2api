package us.cubk;

import java.util.Base64;

public final class QoderEncoding {

    public static final String CUSTOM_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
    public static final String STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    public static final char CUSTOM_PAD = '$';

    private static final int[] C2S = new int[128];
    private static final int[] S2C = new int[128];

    static {
        for (int i = 0; i < 128; i++) { C2S[i] = -1; S2C[i] = -1; }
        for (int i = 0; i < 64; i++) {
            C2S[CUSTOM_ALPHABET.charAt(i)] = STD_ALPHABET.charAt(i);
            S2C[STD_ALPHABET.charAt(i)] = CUSTOM_ALPHABET.charAt(i);
        }
        C2S[CUSTOM_PAD] = '=';
        S2C['='] = CUSTOM_PAD;
    }

    private QoderEncoding() {}

    public static String encode(byte[] plaintext) {
        String std = Base64.getEncoder().encodeToString(plaintext);
        int n = std.length();
        int a = n / 3;
        String rearranged = std.substring(n - a) + std.substring(a, n - a) + std.substring(0, a);
        StringBuilder sb = new StringBuilder(n);
        for (int i = 0; i < n; i++) {
            int c = rearranged.charAt(i);
            int m = (c < 128) ? S2C[c] : -1;
            if (m < 0) throw new IllegalArgumentException("char out of alphabet: " + c);
            sb.append((char) m);
        }
        return sb.toString();
    }

    public static byte[] decode(String encoded) {
        int n = encoded.length();
        StringBuilder sb = new StringBuilder(n);
        for (int i = 0; i < n; i++) {
            int c = encoded.charAt(i);
            int m = (c < 128) ? C2S[c] : -1;
            if (m < 0) throw new IllegalArgumentException("char out of custom alphabet: " + c);
            sb.append((char) m);
        }
        String mapped = sb.toString();
        int a = n / 3;
        String std = mapped.substring(n - a) + mapped.substring(a, n - a) + mapped.substring(0, a);
        return Base64.getDecoder().decode(std);
    }
}
