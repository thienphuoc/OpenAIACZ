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

- `usage` là ước lượng (~4 ký tự/token) vì gateway không báo usage theo run.
- **Function calling chuẩn OpenAI chưa hỗ trợ** — gateway không cho client định nghĩa tools; agent có tools riêng chạy phía agent. Muốn model gọi tool của mình thì đăng ký MCP server trong config gateway.
- `temperature`, `top_p`, `max_tokens`... được bỏ qua.
- Proxy `/v1/media` chỉ tải được file trong workspace agent "main" (giới hạn từ gateway, không phải từ server này).
- Token gateway (`.gateway-token`) thay đổi mỗi lần app khởi động lại — server tự đọc lại khi kết nối lại, không cần làm gì.
