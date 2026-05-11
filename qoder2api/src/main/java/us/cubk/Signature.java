package us.cubk;

import java.security.MessageDigest;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.Locale;

public final class Signature {
    public static final String APPCODE = "cosy";
    public static final String SECRET = "d2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw=="; // base64("war, war never changes")
    public static final String SEP = "&";

    private static final DateTimeFormatter RFC1123 = DateTimeFormatter.ofPattern("EEE, dd MMM yyyy HH:mm:ss 'GMT'", Locale.ENGLISH).withZone(ZoneOffset.UTC);

    private Signature() {}

    public static String currentDate() {
        return RFC1123.format(Instant.now());
    }

    public static String sign(String date) {
        return md5(APPCODE + SEP + SECRET + SEP + date);
    }

    private static String md5(String s) {
        try {
            byte[] h = MessageDigest.getInstance("MD5").digest(s.getBytes());
            StringBuilder sb = new StringBuilder(32);
            for (byte b : h) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Exception e) { throw new RuntimeException(e); }
    }
}
