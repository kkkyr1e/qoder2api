package us.cubk;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import javax.crypto.Cipher;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Base64;

public final class LocalAuth {

    private static final ObjectMapper OM = new ObjectMapper();

    public static Path defaultDir() {
        String home = System.getProperty("user.home");
        return Paths.get(home, ".qoder", ".auth");
    }

    public static String readMachineId() throws Exception {
        return new String(Files.readAllBytes(defaultDir().resolve("id")), StandardCharsets.UTF_8).trim();
    }

    public static JsonNode readUserInfo() throws Exception {
        String mid = readMachineId();
        byte[] cipherBytes = Base64.getDecoder().decode(new String(Files.readAllBytes(defaultDir().resolve("user")), StandardCharsets.UTF_8).trim());
        byte[] key = mid.substring(0, 16).getBytes(StandardCharsets.US_ASCII);
        Cipher c = Cipher.getInstance("AES/CBC/PKCS5Padding");
        c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new IvParameterSpec(key));
        byte[] plain = c.doFinal(cipherBytes);
        return OM.readTree(plain);
    }

    public static void main(String[] args) throws Exception {
        System.out.println(readUserInfo());
    }
}
