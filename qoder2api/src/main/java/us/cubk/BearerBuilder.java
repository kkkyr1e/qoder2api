package us.cubk;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import javax.crypto.Cipher;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.spec.X509EncodedKeySpec;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

public final class BearerBuilder {

    public static final String SERVER_PUBKEY_PEM = (
            "-----BEGIN PUBLIC KEY-----\n"
          + "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc\n"
          + "4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l\n"
          + "6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17\n"
          + "XcW+ML9FoCI6AOvOzwIDAQAB\n"
          + "-----END PUBLIC KEY-----");

    private static final ObjectMapper objectMapper = new ObjectMapper();
    public record AuthIdentity(String name, String aid, String uid, String yxUid, String organizationId, String organizationName, String userType, String securityOauthToken, String refreshToken) {}

    public record SessionContext(byte[] tempKey, String cosyKey, String info, AuthIdentity identity, String machineId, String machineToken, String machineType) {
    }

    public static SessionContext newSession(AuthIdentity id, String machineId, String machineToken, String machineType) throws Exception {
        byte[] tempKey = UUID.randomUUID().toString().replace("-", "").substring(0, 16).getBytes(StandardCharsets.US_ASCII);
        String cosyKey = Base64.getEncoder().encodeToString(rsaEncrypt(tempKey));
        String info = Base64.getEncoder().encodeToString(aesEncrypt(authPayloadJson(id), tempKey));
        return new SessionContext(tempKey, cosyKey, info, id, machineId, machineToken, machineType);
    }

    public static String signRequest(String payloadB64, String cosyKey, String cosyDate, String body, String pathWithoutAlgo) throws Exception {
        String s = payloadB64 + "\n" + cosyKey + "\n" + cosyDate + "\n" + body + "\n" + pathWithoutAlgo;
        return md5Hex(s);
    }

    public static String buildPayloadB64(String info) throws Exception {
        Map<String, String> m = new LinkedHashMap<>();
        m.put("cosyVersion", "0.1.43");
        m.put("ideVersion", "");
        m.put("info", info);
        m.put("requestId", UUID.randomUUID().toString());
        m.put("version", "v1");
        var sorted = new java.util.TreeMap<>(m);
        return Base64.getEncoder().encodeToString(objectMapper.writeValueAsBytes(sorted));
    }

    public static String composeBearer(String payloadB64, String sig) {
        return "Bearer COSY." + payloadB64 + "." + sig;
    }

    static byte[] authPayloadJson(AuthIdentity id) throws Exception {
        ObjectNode n = objectMapper.createObjectNode();
        n.put("name", id.name());
        n.put("aid", id.aid());
        n.put("uid", id.uid());
        n.put("yx_uid", id.yxUid());
        n.put("organization_id", id.organizationId());
        n.put("organization_name", id.organizationName());
        n.put("user_type", id.userType());
        n.put("security_oauth_token", id.securityOauthToken());
        n.put("refresh_token", id.refreshToken());
        return objectMapper.writeValueAsBytes(n);
    }

    static byte[] rsaEncrypt(byte[] tempKey) throws Exception {
        String b64 = SERVER_PUBKEY_PEM.replace("-----BEGIN PUBLIC KEY-----", "").replace("-----END PUBLIC KEY-----", "").replaceAll("\\s+", "");
        byte[] der = Base64.getDecoder().decode(b64);
        PublicKey pk = KeyFactory.getInstance("RSA").generatePublic(new X509EncodedKeySpec(der));
        Cipher c = Cipher.getInstance("RSA/ECB/PKCS1Padding");
        c.init(Cipher.ENCRYPT_MODE, pk);
        return c.doFinal(tempKey);
    }

    static byte[] aesEncrypt(byte[] plain, byte[] key) throws Exception {
        Cipher c = Cipher.getInstance("AES/CBC/PKCS5Padding");
        c.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new IvParameterSpec(key));
        return c.doFinal(plain);
    }

    static String md5Hex(String s) throws Exception {
        byte[] h = MessageDigest.getInstance("MD5").digest(s.getBytes(StandardCharsets.UTF_8));
        StringBuilder sb = new StringBuilder(32);
        for (byte b : h) sb.append(String.format("%02x", b));
        return sb.toString();
    }
}
