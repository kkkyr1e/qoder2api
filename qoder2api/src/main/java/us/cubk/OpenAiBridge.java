package us.cubk;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.File;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.UUID;

public final class OpenAiBridge {

    private static final ObjectMapper objectMapper = new ObjectMapper();
    private final BearerBuilder.SessionContext sess;
    private final BearerApiClient bearerClient;
    private final JsonNode templateBase;

    public OpenAiBridge(String pat) throws Exception {
        String mid = UUID.randomUUID().toString();
        String mtoken = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString((UUID.randomUUID().toString() + UUID.randomUUID()).substring(0, 50).getBytes());
        String mtype = UUID.randomUUID().toString().replace("-", "").substring(0, 18);
        var sigClient = new SignatureApiClient(mid, mtoken, mtype);
        JsonNode jt = sigClient.exchangeJobToken(pat);
        System.out.println("[bridge] session for " + jt.path("name").asText() + " (" + jt.path("id").asText() + ")");
        var identity = new BearerBuilder.AuthIdentity(jt.path("name").asText(""), jt.path("id").asText(""), jt.path("id").asText(""), "", "", "", jt.path("userType").asText("personal_standard"), jt.path("securityOauthToken").asText(), jt.path("refreshToken").asText());
        this.sess = BearerBuilder.newSession(identity, mid, mtoken, mtype);
        this.bearerClient = new BearerApiClient(sess);
        String basePrompt = new String(java.nio.file.Files.readAllBytes(new File("baseprompt.json").toPath()));
        basePrompt = basePrompt.replace("{UUID1}",UUID.randomUUID().toString());
        basePrompt = basePrompt.replace("{UUID2}",UUID.randomUUID().toString());
        basePrompt = basePrompt.replace("{UUID3}",UUID.randomUUID().toString());
        basePrompt = basePrompt.replace("{UUID4}",UUID.randomUUID().toString());
        basePrompt = basePrompt.replace("{UUID5}",UUID.randomUUID().toString());
        basePrompt = basePrompt.replace("{TIME1}",String.valueOf(System.currentTimeMillis()));
        this.templateBase = objectMapper.readTree(basePrompt);
    }

    public void start(int port) throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
        server.createContext("/v1/chat/completions", this::handleChat);
        server.setExecutor(java.util.concurrent.Executors.newFixedThreadPool(8));
        server.start();
        System.out.println("[bridge] listening http://127.0.0.1:" + port + "/v1/chat/completions");
    }

    private void handleChat(HttpExchange ex) throws IOException {
        try {
            if (!"POST".equals(ex.getRequestMethod())) {
                ex.sendResponseHeaders(405, -1); return;
            }
            JsonNode req = objectMapper.readTree(ex.getRequestBody());
            boolean stream = req.path("stream").asBoolean(false);
            String model = req.path("model").asText("lite");
            JsonNode messages = req.path("messages");

            ObjectNode body = templateBase.deepCopy();
            String nid = UUID.randomUUID().toString();
            body.put("request_id", nid);
            body.put("chat_record_id", nid);
            body.put("request_set_id", UUID.randomUUID().toString());
            body.put("session_id", UUID.randomUUID().toString());
            body.put("stream", true);
            body.put("aliyun_user_type", sess.identity().userType());
            ObjectNode mc = (ObjectNode) body.path("model_config");
            mc.put("key", model);
            ObjectNode biz = (ObjectNode) body.path("business");
            biz.put("id", UUID.randomUUID().toString());
            biz.put("begin_at", System.currentTimeMillis());

            String prompt = "";
            for (int i = messages.size() - 1; i >= 0; i--) {
                JsonNode m = messages.get(i);
                if ("user".equals(m.path("role").asText())) {
                    JsonNode c = m.path("content");
                    prompt = c.isTextual() ? c.asText() : c.toString();
                    break;
                }
            }
            ObjectNode ctx = (ObjectNode) body.path("chat_context");
            ((ObjectNode) ctx.path("text")).put("text", prompt);
            ((ObjectNode) ctx.path("extra").path("originalContent")).put("text", prompt);
            biz.put("name", prompt.length() > 30 ? prompt.substring(0, 30) : prompt);
            ArrayNode msgsArr = (ArrayNode) body.path("messages");
            ArrayNode rebuilt = objectMapper.createArrayNode();
            for (JsonNode msg : msgsArr) {
                if (!"user".equals(msg.path("role").asText())) {
                    rebuilt.add(msg);
                }
            }
            ObjectNode userMsg = objectMapper.createObjectNode();
            userMsg.put("role", "user"); userMsg.put("content", "");
            ArrayNode contents = objectMapper.createArrayNode();
            ObjectNode cn = objectMapper.createObjectNode();
            cn.put("type", "text"); cn.put("text", prompt);
            contents.add(cn);
            userMsg.set("contents", contents);
            ObjectNode rmu = objectMapper.createObjectNode();
            rmu.put("prompt_tokens", 0); rmu.put("completion_tokens", 0); rmu.put("total_tokens", 0);
            ObjectNode ctd = objectMapper.createObjectNode(); ctd.put("reasoning_tokens", 0); rmu.set("completion_tokens_details", ctd);
            ObjectNode ptd = objectMapper.createObjectNode(); ptd.put("cached_tokens", 0); rmu.set("prompt_tokens_details", ptd);
            ObjectNode rm = objectMapper.createObjectNode(); rm.put("id", ""); rm.set("usage", rmu);
            userMsg.set("response_meta", rm);
            userMsg.put("reasoning_content_signature", "");
            rebuilt.add(userMsg);
            body.set("messages", rebuilt);

            System.out.println("[bridge] prompt=" + (prompt.length() > 80 ? prompt.substring(0,80)+"..." : prompt));
            for (JsonNode msg : body.path("messages")) {
                String content = msg.path("content").asText();
                String contentsStr = msg.path("contents").toString();
                System.out.println("[bridge] msg role=" + msg.path("role").asText() + " content=" + (content.length()>40 ? content.substring(0,40)+"..." : content) + " contents=" + (contentsStr.length()>120 ? contentsStr.substring(0,120)+"..." : contentsStr));
            }

            String url = "https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation" + "?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";
            Map<String,String> extraHeaders = Map.of("x-model-key", model, "x-model-source", mc.path("source").asText("system"));

            String reqId = "chatcmpl-" + UUID.randomUUID().toString().replace("-", "").substring(0, 24);
            long created = System.currentTimeMillis() / 1000;

            if (stream) {
                ex.getResponseHeaders().add("Content-Type", "text/event-stream");
                ex.getResponseHeaders().add("Cache-Control", "no-cache");
                ex.sendResponseHeaders(200, 0);
                OutputStream out = ex.getResponseBody();
                bearerClient.openStreamLines(url, body, extraHeaders, line -> {
                    if (!line.startsWith("data:")) return;
                    String content = extractContent(line.substring(5).trim());
                    if (content == null || content.isEmpty()) return;
                    try {
                        ObjectNode chunk = makeChunk(reqId, created, model);
                        ((ObjectNode) chunk.path("choices").get(0).path("delta")).put("role", "assistant").put("content", content);
                        out.write(("data: " + objectMapper.writeValueAsString(chunk) + "\n\n").getBytes(StandardCharsets.UTF_8));
                        out.flush();
                    } catch (IOException ie) { throw new RuntimeException(ie); }
                });
                ObjectNode done = makeChunk(reqId, created, model);
                ((ObjectNode) done.path("choices").get(0)).put("finish_reason", "stop");
                ((ObjectNode) done.path("choices").get(0)).set("delta", objectMapper.createObjectNode());
                out.write(("data: " + objectMapper.writeValueAsString(done) + "\n\n").getBytes(StandardCharsets.UTF_8));
                out.write("data: [DONE]\n\n".getBytes(StandardCharsets.UTF_8));
                out.close();
            } else {
                StringBuilder full = new StringBuilder();
                bearerClient.openStreamLines(url, body, extraHeaders, line -> {
                    if (!line.startsWith("data:")) return;
                    String content = extractContent(line.substring(5).trim());
                    if (content != null) full.append(content);
                });
                ObjectNode out = objectMapper.createObjectNode();
                out.put("id", reqId); out.put("object", "chat.completion");
                out.put("created", created); out.put("model", model);
                ArrayNode choices = objectMapper.createArrayNode();
                ObjectNode ch = objectMapper.createObjectNode();
                ch.put("index", 0);
                ObjectNode msg = objectMapper.createObjectNode();
                msg.put("role", "assistant"); msg.put("content", full.toString());
                ch.set("message", msg);
                ch.put("finish_reason", "stop");
                choices.add(ch);
                out.set("choices", choices);
                ObjectNode usage = objectMapper.createObjectNode();
                usage.put("prompt_tokens", 0); usage.put("completion_tokens", 0); usage.put("total_tokens", 0);
                out.set("usage", usage);
                byte[] outBytes = objectMapper.writeValueAsBytes(out);
                ex.getResponseHeaders().add("Content-Type", "application/json");
                ex.sendResponseHeaders(200, outBytes.length);
                ex.getResponseBody().write(outBytes);
            }
        } catch (Exception e) {
            String err = "{\"error\":{\"message\":\"" + e.getMessage().replace("\"", "\\\"") + "\",\"type\":\"qoder_error\"}}";
            byte[] errBytes = err.getBytes(StandardCharsets.UTF_8);
            try {
                ex.getResponseHeaders().add("Content-Type", "application/json");
                ex.sendResponseHeaders(500, errBytes.length);
                ex.getResponseBody().write(errBytes);
            } catch (IOException ignore) {}
        } finally {
            ex.close();
        }
    }

    private void streamSseChunks(java.io.InputStream is, java.util.function.Consumer<String> onChunk) throws IOException {
        java.io.ByteArrayOutputStream lineBuf = new java.io.ByteArrayOutputStream();
        int b;
        while ((b = is.read()) != -1) {
            if (b == '\n') {
                String line = lineBuf.toString(StandardCharsets.UTF_8);
                lineBuf.reset();
                String trimmed = line.endsWith("\r") ? line.substring(0, line.length()-1) : line;
                if (trimmed.startsWith("data:")) {
                    String content = extractContent(trimmed.substring(5).trim());
                    if (content != null && !content.isEmpty()) onChunk.accept(content);
                }
            } else {
                lineBuf.write(b);
            }
        }
        if (lineBuf.size() > 0) {
            String line = lineBuf.toString(StandardCharsets.UTF_8);
            if (line.startsWith("data:")) {
                String content = extractContent(line.substring(5).trim());
                if (content != null && !content.isEmpty()) onChunk.accept(content);
            }
        }
    }

    private String extractContent(String dataLine) {
        try {
            JsonNode wrapper = objectMapper.readTree(dataLine);
            String inner = wrapper.path("body").asText("");
            if (inner.isEmpty()) return null;
            JsonNode innerJson = objectMapper.readTree(inner);
            for (JsonNode ch : innerJson.path("choices")) {
                JsonNode delta = ch.path("delta");
                if (delta.has("content") && !delta.path("content").asText().isEmpty()) {
                    return delta.path("content").asText();
                }
            }
        } catch (Exception ignore) {}
        return null;
    }

    private ObjectNode makeChunk(String id, long created, String model) {
        ObjectNode root = objectMapper.createObjectNode();
        root.put("id", id); root.put("object", "chat.completion.chunk");
        root.put("created", created); root.put("model", model);
        ArrayNode choices = objectMapper.createArrayNode();
        ObjectNode c = objectMapper.createObjectNode();
        c.put("index", 0);
        c.set("delta", objectMapper.createObjectNode());
        c.putNull("finish_reason");
        choices.add(c);
        root.set("choices", choices);
        return root;
    }

    public static void run(String pat, int port) throws Exception {
        if (pat == null || pat.isBlank()) {
            pat = System.getProperty("QODER_PAT");
            if (pat == null || pat.isBlank()) throw new RuntimeException("Token required!");
        }
        new OpenAiBridge(pat).start(port);
        Thread.currentThread().join();
    }

    public static void main(String[] args) throws Exception {
        run(null, 8963);
    }
}
