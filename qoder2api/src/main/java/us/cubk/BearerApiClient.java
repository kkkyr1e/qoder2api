package us.cubk;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Map;

public final class BearerApiClient {
    public static final ObjectMapper objectMapper = new ObjectMapper();
    private final BearerBuilder.SessionContext sess;
    private final HttpClient http = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).connectTimeout(Duration.ofSeconds(15)).build();

    public BearerApiClient(BearerBuilder.SessionContext sess) { this.sess = sess; }

    public JsonNode callPost(String fullUrl, Object jsonBody) throws Exception {
        return call("POST", fullUrl, jsonBody, null);
    }

    public JsonNode callGet(String fullUrl) throws Exception {
        return call("GET", fullUrl, null, null);
    }
    public HttpResponse<java.io.InputStream> openStream(String fullUrl, Object jsonBody, Map<String, String> extraHeaders) throws Exception {
        return openCallStream(fullUrl, jsonBody, extraHeaders);
    }

    public void openStreamLines(String fullUrl, Object jsonBody, Map<String, String> extraHeaders, java.util.function.Consumer<String> onLine) throws Exception {
        URI u = URI.create(fullUrl);
        String pathQuery = u.getRawPath();
        String pathSig = pathQuery.startsWith("/algo") ? pathQuery.substring("/algo".length()) : pathQuery;
        String body = jsonBody == null ? "" : QoderEncoding.encode(objectMapper.writeValueAsBytes(jsonBody));
        String payloadB64 = BearerBuilder.buildPayloadB64(sess.info());
        String date = String.valueOf(System.currentTimeMillis() / 1000);
        String sig = BearerBuilder.signRequest(payloadB64, sess.cosyKey(), date, body, pathSig);
        String bearer = BearerBuilder.composeBearer(payloadB64, sig);
        org.apache.hc.client5.http.classic.methods.HttpPost post = new org.apache.hc.client5.http.classic.methods.HttpPost(fullUrl);
        post.setHeader("cosy-data-policy", "AGREE");
        post.setHeader("content-type", "application/json");
        post.setHeader("cosy-machinetype", sess.machineType());
        post.setHeader("cosy-clienttype", "5");
        post.setHeader("cosy-date", date);
        post.setHeader("cosy-user", sess.identity().uid());
        post.setHeader("cosy-key", sess.cosyKey());
        post.setHeader("cache-control", "no-cache");
        post.setHeader("accept", "text/event-stream");
        post.setHeader("cosy-clientip", "169.254.198.161");
        post.setHeader("authorization", bearer);
        post.setHeader("accept-encoding", "identity");
        post.setHeader("cosy-version", "0.1.43");
        post.setHeader("cosy-machineid", sess.machineId());
        post.setHeader("cosy-machinetoken", sess.machineToken());
        post.setHeader("login-version", "v2");
        post.setHeader("user-agent", "Go-http-client/2.0");
        if (extraHeaders != null) extraHeaders.forEach(post::setHeader);
        post.setEntity(new org.apache.hc.core5.http.io.entity.StringEntity(body));
        try (org.apache.hc.client5.http.impl.classic.CloseableHttpClient client = org.apache.hc.client5.http.impl.classic.HttpClients.custom().setDefaultRequestConfig(org.apache.hc.client5.http.config.RequestConfig.custom().setConnectTimeout(org.apache.hc.core5.util.Timeout.ofSeconds(15)).setResponseTimeout(org.apache.hc.core5.util.Timeout.ofMinutes(5)).build()).useSystemProperties().build()) {
            client.execute(post, (org.apache.hc.core5.http.io.HttpClientResponseHandler<Void>) response -> {
                try {
                    return execHandler(response, onLine);
                } catch (java.io.IOException ioe) {
                    throw ioe;
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    throw new java.io.IOException(ie);
                } catch (Exception e) {
                    throw new java.io.IOException(e);
                }
            });
        }
    }

    private Void execHandler(org.apache.hc.core5.http.ClassicHttpResponse response, java.util.function.Consumer<String> onLine) throws Exception {
                if (response.getCode() != 200) {
                    String errBody = org.apache.hc.core5.http.io.entity.EntityUtils.toString(response.getEntity());
                    throw new RuntimeException("HTTP " + response.getCode() + " " + errBody);
                }
                java.io.InputStream is = response.getEntity().getContent();
                java.util.concurrent.BlockingQueue<Integer> queue = new java.util.concurrent.LinkedBlockingQueue<>();
                final int SENTINEL_EOF = -1;
                Thread reader = new Thread(() -> {
                    try {
                        int b;
                        while ((b = is.read()) != -1) queue.put(b);
                        queue.put(SENTINEL_EOF);
                    } catch (Exception e) {
                        try { queue.put(SENTINEL_EOF); } catch (InterruptedException ignore) {}
                    }
                }, "sse-reader");
                reader.setDaemon(true);
                reader.start();
                java.io.ByteArrayOutputStream lineBuf = new java.io.ByteArrayOutputStream();
                int idleMs = 0;
                while (true) {
                    Integer b = queue.poll(500, java.util.concurrent.TimeUnit.MILLISECONDS);
                    if (b == null) {
                        idleMs += 500;
                        if (idleMs >= 3000) break;
                        continue;
                    }
                    idleMs = 0;
                    if (b == SENTINEL_EOF) break;
                    if (b == '\n') {
                        String line = lineBuf.toString(java.nio.charset.StandardCharsets.UTF_8);
                        lineBuf.reset();
                        if (line.endsWith("\r")) line = line.substring(0, line.length()-1);
                        if (!line.isEmpty()) onLine.accept(line);
                    } else {
                        lineBuf.write(b);
                    }
                }
                reader.interrupt();
                try { is.close(); } catch (Exception ignore) {}
                System.out.println("[stream] read complete");
                return null;
    }

    private JsonNode call(String method, String fullUrl, Object jsonBody, Map<String,String> extraHeaders) throws Exception {
        URI u = URI.create(fullUrl);
        String pathQuery = u.getRawPath();
        String pathSig = pathQuery.startsWith("/algo") ? pathQuery.substring("/algo".length()) : pathQuery;

        String body = "";
        if (jsonBody != null) {
            byte[] plain = objectMapper.writeValueAsBytes(jsonBody);
            body = QoderEncoding.encode(plain);
        }

        String payloadB64 = BearerBuilder.buildPayloadB64(sess.info());
        String date = String.valueOf(System.currentTimeMillis() / 1000);
        String sig = BearerBuilder.signRequest(payloadB64, sess.cosyKey(), date, body, pathSig);
        String bearer = BearerBuilder.composeBearer(payloadB64, sig);

        HttpRequest.Builder b = HttpRequest.newBuilder(u)
                .timeout(Duration.ofSeconds(30))
                .header("cosy-data-policy", "AGREE")
                .header("content-type", "application/json")
                .header("cosy-machinetype", sess.machineType())
                .header("cosy-clienttype", "5")
                .header("cosy-date", date)
                .header("cosy-user", sess.identity().uid())
                .header("cosy-key", sess.cosyKey())
                .header("accept", "application/json")
                .header("cosy-clientip", "169.254.198.161")
                .header("authorization", bearer)
                .header("accept-encoding", "identity")
                .header("cosy-version", "0.1.43")
                .header("cosy-machineid", sess.machineId())
                .header("cosy-machinetoken", sess.machineToken())
                .header("login-version", "v2")
                .header("user-agent", "Go-http-client/2.0");
        if (extraHeaders != null) extraHeaders.forEach(b::header);
        if ("POST".equals(method)) {
            b.POST(HttpRequest.BodyPublishers.ofString(body));
        } else {
            b.GET();
        }
        HttpResponse<String> resp = http.send(b.build(), HttpResponse.BodyHandlers.ofString());
        if (resp.statusCode() != 200) {
            throw new RuntimeException("HTTP " + resp.statusCode() + " body=" + resp.body());
        }
        return objectMapper.readTree(resp.body());
    }

    private HttpResponse<java.io.InputStream> openCallStream(String fullUrl, Object jsonBody,
                                                             Map<String,String> extraHeaders) throws Exception {
        URI u = URI.create(fullUrl);
        String pathQuery = u.getRawPath();
        String pathSig = pathQuery.startsWith("/algo") ? pathQuery.substring("/algo".length()) : pathQuery;
        String body = jsonBody == null ? "" : QoderEncoding.encode(objectMapper.writeValueAsBytes(jsonBody));
        String payloadB64 = BearerBuilder.buildPayloadB64(sess.info());
        String date = String.valueOf(System.currentTimeMillis() / 1000);
        String sig = BearerBuilder.signRequest(payloadB64, sess.cosyKey(), date, body, pathSig);
        String bearer = BearerBuilder.composeBearer(payloadB64, sig);

        HttpRequest.Builder b = HttpRequest.newBuilder(u)
                .timeout(Duration.ofMinutes(5))
                .header("cosy-data-policy", "AGREE")
                .header("content-type", "application/json")
                .header("cosy-machinetype", sess.machineType())
                .header("cosy-clienttype", "5")
                .header("cosy-date", date)
                .header("cosy-user", sess.identity().uid())
                .header("cosy-key", sess.cosyKey())
                .header("cache-control", "no-cache")
                .header("accept", "text/event-stream")
                .header("cosy-clientip", "169.254.198.161")
                .header("authorization", bearer)
                .header("accept-encoding", "identity")
                .header("cosy-version", "0.1.43")
                .header("cosy-machineid", sess.machineId())
                .header("cosy-machinetoken", sess.machineToken())
                .header("login-version", "v2")
                .header("user-agent", "Go-http-client/2.0");
        if (extraHeaders != null) extraHeaders.forEach(b::header);
        b.POST(HttpRequest.BodyPublishers.ofString(body));
        HttpResponse<java.io.InputStream> resp = http.send(b.build(), HttpResponse.BodyHandlers.ofInputStream());
        if (resp.statusCode() != 200) {
            byte[] err = resp.body().readAllBytes();
            throw new RuntimeException("HTTP " + resp.statusCode() + " body=" + new String(err));
        }
        return resp;
    }
}
