package us.cubk;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;


public final class SignatureApiClient {
    public static final ObjectMapper objectMapper = new ObjectMapper();
    private final HttpClient http = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).connectTimeout(Duration.ofSeconds(15)).build();

    private final String machineId;
    private final String machineToken;
    private final String machineType;

    public SignatureApiClient(String machineId, String machineToken, String machineType) {
        this.machineId = machineId;
        this.machineToken = machineToken;
        this.machineType = machineType;
    }

    public JsonNode exchangeJobToken(String personalToken) throws Exception {
        var inner = objectMapper.createObjectNode();
        inner.put("personalToken", personalToken);
        inner.put("securityOauthToken", "");
        inner.put("refreshToken", "");
        inner.put("needRefresh", false);
        inner.putObject("authInfo");
        var outer = objectMapper.createObjectNode();
        outer.put("payload", objectMapper.writeValueAsString(inner));
        outer.put("encodeVersion", "1");
        return postEncoded("https://center.qoder.sh/algo/api/v3/user/jobToken?Encode=1", outer);
    }

    public JsonNode userStatus(String userId) throws Exception {
        var inner = objectMapper.createObjectNode();
        inner.put("userId", userId);
        inner.put("personalToken", "");
        inner.put("securityOauthToken", "");
        inner.put("refreshToken", "");
        inner.put("needRefresh", false);
        inner.putObject("authInfo");
        var outer = objectMapper.createObjectNode();
        outer.put("payload", objectMapper.writeValueAsString(inner));
        outer.put("encodeVersion", "1");
        return postEncoded("https://center.qoder.sh/algo/api/v3/user/status?Encode=1", outer);
    }

    public JsonNode heartbeat() throws Exception {
        var hb = objectMapper.createObjectNode();
        hb.put("event_time", System.currentTimeMillis());
        hb.put("event_type", "cosy_heartbeat");
        hb.put("mid", machineId);
        hb.put("os_arch", System.getProperty("os.arch").equals("amd64") ? "windows_amd64" : System.getProperty("os.arch"));
        hb.put("os_version", System.getProperty("os.name") + " " + System.getProperty("os.version"));
        hb.put("ide_type", "qodercli");
        hb.put("ide_version", "0.1.43");
        hb.putObject("extra_info");
        return postEncoded("https://center.qoder.sh/algo/api/v1/heartbeat?Encode=1", hb);
    }

    private JsonNode postEncoded(String url, Object obj) throws Exception {
        String date = Signature.currentDate();
        String sig  = Signature.sign(date);
        byte[] plain = objectMapper.writeValueAsBytes(obj);
        String body = QoderEncoding.encode(plain);

        HttpRequest req = HttpRequest.newBuilder(URI.create(url))
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

        HttpResponse<String> resp = http.send(req, HttpResponse.BodyHandlers.ofString());
        if (resp.statusCode() != 200) {
            throw new RuntimeException("HTTP " + resp.statusCode() + " at " + url + " body=" + resp.body());
        }
        return objectMapper.readTree(resp.body());
    }
}
