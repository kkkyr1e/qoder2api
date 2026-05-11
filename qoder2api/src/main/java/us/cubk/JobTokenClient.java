package us.cubk;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

public final class JobTokenClient {
    private static final ObjectMapper objectMapper = new ObjectMapper();

    public record Session(String userId, String name, String securityOauthToken, String refreshToken, long expireTime, String email, String plan, String raw) {}

    public static Session exchange(String personalToken, String machineId, String machineToken, String machineType) throws Exception {
        String date = Signature.currentDate();
        String sig  = Signature.sign(date);

        ObjectNode inner = objectMapper.createObjectNode();
        inner.put("personalToken", personalToken);
        inner.put("securityOauthToken", "");
        inner.put("refreshToken", "");
        inner.put("needRefresh", false);
        inner.putObject("authInfo");

        ObjectNode outer = objectMapper.createObjectNode();
        outer.put("payload", objectMapper.writeValueAsString(inner));
        outer.put("encodeVersion", "1");

        byte[] plain = objectMapper.writeValueAsBytes(outer);
        String body = QoderEncoding.encode(plain);

        HttpClient client = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).connectTimeout(Duration.ofSeconds(15)).build();

        HttpRequest req = HttpRequest.newBuilder(URI.create("https://center.qoder.sh/algo/api/v3/user/jobToken?Encode=1"))
                .timeout(Duration.ofSeconds(15))
                .header("cosy-machinetoken", machineToken)
                .header("cosy-machinetype", machineType)
                .header("login-version", "v2")
                .header("appcode", Signature.APPCODE)
                .header("accept", "application/json")
                .header("accept-encoding", "identity")
                .header("cosy-version", "0.1.43")
                .header("cosy-clienttype", "5")
                .header("date", date)
                .header("signature", sig)
                .header("content-type", "application/json")
                .header("cosy-machineid", machineId)
                .header("user-agent", "Go-http-client/2.0")
                .POST(HttpRequest.BodyPublishers.ofByteArray(body.getBytes()))
                .build();

        HttpResponse<String> resp = client.send(req, HttpResponse.BodyHandlers.ofString());
        if (resp.statusCode() != 200) {
            throw new RuntimeException("jobToken HTTP " + resp.statusCode() + " body=" + resp.body());
        }

        var json = objectMapper.readTree(resp.body());
        return new Session(
                json.path("id").asText(),
                json.path("name").asText(),
                json.path("securityOauthToken").asText(),
                json.path("refreshToken").asText(),
                json.path("expireTime").asLong(),
                json.path("email").asText(),
                json.path("plan").asText(),
                resp.body());
    }
}
