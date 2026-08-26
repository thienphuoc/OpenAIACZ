# autoclaw-openai-api

Biến app **AutoClaw** đang chạy trên máy thành một **API server tương thích OpenAI Chat Completions** (`/v1/chat/completions`, `/v1/models`). Viết bằng Node.js thuần, **không cần cài dependency nào**.

Bất kỳ client nào hỗ trợ OpenAI API (Cursor, Continue, openai-python, LangChain, Cherry Studio, chatbox...) chỉ cần trỏ về:

```
http://127.0.0.1:8787/v1
```

## Yêu cầu

- **Node.js >= 22** (cần WebSocket global)
- App **AutoClaw đang chạy** (gateway `ws://127.0.0.1:18789` phải sống — script tự đọc device key + gateway token của app)

## Chạy

```bash
cd D:\projects\autoclaw
node src/server.js
# hoặc
npm start
```

Mặc định lắng nghe tại `http://127.0.0.1:8787`.

## Dùng thử

```bash
# Danh sách model
curl http://127.0.0.1:8787/v1/models

# Chat (non-stream)
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "main",
    "messages": [{"role": "user", "content": "Chào bạn, bạn là ai?"}]
  }'

# Chat (stream SSE)
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "main",
    "stream": true,
    "messages": [{"role": "user", "content": "Viết 1 câu thơ về mưa"}]
  }'
```

Python (openai SDK):

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="anything")
r = client.chat.completions.create(
    model="main",
    messages=[{"role": "user", "content": "hello"}],
)
print(r.choices[0].message.content)
```

## Endpoint

| Method | Path                   | Mô tả                                        |
|--------|------------------------|-----------------------------------------------|
| POST   | `/v1/chat/completions` | Chat completions, hỗ trợ `stream`, ảnh đầu vào, file đầu ra |
| GET    | `/v1/models`           | Danh sách model + agent của gateway           |
| GET    | `/v1/media?path=...`   | Tải file agent tạo (proxy qua gateway assistant-media) |
| GET    | `/health`              | Trạng thái server + gateway                   |
| GET    | `/`                    | Web UI chat (paste/drag ảnh, xem file ra)   |

## Cấu hình

Tạo `config.json` cạnh `package.json` (xem `config.example.json`), hoặc dùng biến môi trường (env ưu tiên hơn):

| Env                   | config.json        | Mặc định                     | Ý nghĩa |
|-----------------------|--------------------|------------------------------|---------|
| `HOST` / `PORT`       | `host` / `port`    | `127.0.0.1` / `8787`         | Địa chỉ lắng nghe |
| `API_KEYS`            | `apiKeys`          | `[]` (tắt auth)              | Danh sách API key (comma-separated) client phải gửi `Authorization: Bearer <key>` |
| `REQUEST_TIMEOUT_MS`  | `requestTimeoutMs` | `180000`                     | Timeout 1 lượt chat |
| `AUTOCLAW_WS`         | `gateway.url`      | `ws://127.0.0.1:18789`       | Địa chỉ gateway WS |
| `AUTOCLAW_STATE_DIR`  | `gateway.stateDir` | `~/.openclaw-autoclaw`       | State dir của gateway (chứa `.gateway-token`) |
| `AUTOCLAW_IDENTITY`   | `gateway.identityPath` | `%APPDATA%/autoclaw/identity/device.json` | Device key Ed25519 |

## Cách hoạt động

```
client ── HTTP/OpenAI format ──> server này ── WS protocol 4 ──> AutoClaw gateway (18789)
                                                      │
                                                      ├─ challenge: nhận nonce
                                                      ├─ ký payload v2 bằng Ed25519 device key
                                                      ├─ connect với gateway token (từ .gateway-token)
                                                      ├─ sessions.create + chat.send
                                                      └─ nhận event `chat` (delta/final) → SSE chunks
```

- Mỗi request tạo **session mới** trên gateway → API hoàn toàn stateless như OpenAI.
- Delta suy luận (`isReasoning`) được map sang `reasoning_content` trong stream chunk.
- Client ngắt kết nối giữa chừng → server gọi `chat.abort` để huỷ run trên gateway.
- `model` trong request: nếu trùng **id agent** của AutoClaw (vd `main`, `auto-coder`, `auto-designer`...) thì chat sẽ route sang agent đó; ngoài ra model chỉ mang tính thông tin — model LLM thật do app cấu hình (GLM-5.3).

## Function calling (chuẩn OpenAI) ✅

Request có `tools` (định nghĩa function theo format OpenAI) sẽ được proxy sang **endpoint gốc của gateway** (`gateway.http.endpoints.chatCompletions`) — nơi model (glm-5.3, deepseek...) gọi tool **native**:

1. Client gửi `tools` → model trả `tool_calls` + `finish_reason: "tool_calls"`
2. Client chạy function, gửi lại message `role:"tool"` kèm `tool_call_id`
3. Model đọc kết quả, trả câu trả lời cuối `finish_reason: "stop"`

```python
tools = [{
  "type": "function",
  "function": {
    "name": "get_weather",
    "description": "Get current weather for a city",
    "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]},
  },
}]
resp = client.chat.completions.create(model="zaicoding_glm-5.3", messages=msgs, tools=tools)
tc = resp.choices[0].message.tool_calls   # model gọi get_weather(city="Hanoi")
# ... chạy function, rồi gửi tool result message role="tool" ...
```

**Yêu cầu một lần:** bật `gateway.http.endpoints.chatCompletions.enabled = true` trong config gateway (`~/.openclaw-autoclaw/openclaw.json`) rồi restart app AutoClaw. Lệnh nhanh:

```bash
node ~/autoclaw-api/autoclaw-api.js ask config.get '{}'   # lấy hash
# set gateway.http.endpoints.chatCompletions={enabled:true} qua config.set với raw + baseHash
# rồi: node ~/autoclaw-api/autoclaw-api.js ask gateway.restart.request '{}'
```

Lưu ý: request có `tools` dùng model của agent đang cấu hình (model trong request mang tính định danh); `thinking` và `activity` không áp dụng trên path này.

## Điều chỉnh độ suy luận (thinking) 🧠

Thêm param `thinking` vào body request để kiểm soát mức suy luận của model (giống chọn max/high ở các engine):

| Giá trị | Ý nghĩa |
|---|---|
| `off` | Tắt suy luận — nhanh nhất |
| `minimal` / `low` | Suy luận tối thiểu / thấp |
| `medium` | Trung bình |
| `high` / `xhigh` | Cao / rất cao |
| `max` | Tối đa — chậm nhất, suy luận kỹ nhất |

```bash
curl http://127.0.0.1:8787/v1/chat/completions -H "Content-Type: application/json" -d '{
  "model": "zaicoding_glm-5.3",
  "thinking": "max",
  "messages": [{"role":"user","content":"câu hỏi khó"}]
}'
```

Với openai SDK Python: `client.chat.completions.create(..., extra_body={"thinking": "max"})` (param ngoài chuẩn OpenAI nên phải qua `extra_body`). Model không hỗ trợ reasoning sẽ tự bị gateway clamp về `off`.

## Ảnh đầu vào (image input)

Client gửi ảnh theo chuẩn OpenAI multimodal — `content` dạng mảng các part `{type:"image_url", image_url:{url}}`. Hai dạng URL đều được:

- **data URL** (`data:image/png;base64,...`) → gửi inline luôn, không qua mạng
- **http(s) URL** → server tự fetch về (timeout 20s), chuyển base64, gửi lên gateway

Server tự map thành `attachments` của gateway (base64 thô + mime sniffed). Giới hạn: ảnh ≤ 6MB/giải, tối đa 10 ảnh/text-only model. Chỉ model có `"image"` trong input (glm-4.5v, glm-4.6v...) nhận ảnh inline — model text thường thì ảnh được offload thành workspace file, agent tự mở.

UI: dán (Ctrl+V) hoặc kéo-thả ảnh vào ô nhập — ảnh hiển thị dạng chip preview, bấm ✕ để bỏ.

```bash
curl http://127.0.0.1:8787/v1/chat/completions -H "Content-Type: application/json" -d '{
  "model": "glm-4.5v",
  "messages": [{"role":"user","content":[
    {"type":"text","text":"Ảnh này có gì?"},
    {"type":"image_url","image_url":{"url":"data:image/png;base64,iVBORw0KGgo..."}}
  ]}]
}'
```

## File / media đầu ra

Khi agent tạo file (HTML, PDF, ảnh...), đường dẫn tuyệt đối file nằm trong workspace được trả về qua field `media_urls` trong response (non-stream) hoặc chunk cuối (stream):

```json
{ "media_urls": [{ "path": "C:\\Users\\...\\workspace\\demo.html", "url": "/v1/media?path=..." }] }
```

Tải file qua endpoint proxy `/v1/media?path=<đường dẫn tuyệt đối>` — server forward sang gateway `assistant-media` route (có gateway token), trả raw bytes với Content-Type sniffed.

**Giới hạn quan trọng:** gateway chỉ cho phép tải file trong workspace của **agent "main"** (identity mặc định). File do agent khác (auto-designer, auto-coder...) tạo trong workspace riêng (`~/.openclaw-autoclaw/agents/<id>/workspace/`) sẽ bị gateway trả `outside-allowed-folders`. Workaround: yêu cầu agent lưu file vào workspace chính (`~/.openclaw-autoclaw/workspace/`) trong prompt.

UI tự render link tải cho file (`📎 filename`) và ảnh inline (`<img>`) khi có `media_urls`.

## Giới hạn hiện tại

- `usage` là ước lượng (~4 ký tự/token) vì gateway không báo usage theo run — **trừ path function calling** (gateway báo usage thật, có cả reasoning_tokens).
- Function calling yêu cầu bật `gateway.http.endpoints.chatCompletions` (xem mục trên); request có `tools` đi path proxy riêng.
- `temperature`, `top_p`, `max_tokens`... được bỏ qua (dùng `thinking` để kiểm soát độ suy luận).
- Proxy `/v1/media` chỉ tải được file trong workspace agent "main" (giới hạn từ gateway, không phải từ server này).
- Token gateway (`.gateway-token`) thay đổi mỗi lần app khởi động lại — server tự đọc lại khi kết nối lại, không cần làm gì.
