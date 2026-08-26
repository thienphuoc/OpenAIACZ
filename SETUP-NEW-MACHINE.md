# Setup máy mới vào pool AutoClaw

## Cách 1: Copy auth từ máy đang chạy (nhanh nhất)

Máy mới **không cần cài app AutoClaw**, chỉ cần project + Node.js + file auth.

### Bước 1: Cài Node.js trên máy mới
- Tải Node.js >= 22 từ https://nodejs.org

### Bước 2: Copy project
```bash
# Copy thư mục D:\projects\autoclaw sang máy mới (USB, network, git clone...)
git clone https://github.com/thienphuoc/OpenAIACZ.git
cd OpenAIACZ
```

### Bước 3: Export auth từ máy đang chạy
1. Mở admin panel: `http://<IP-máy-chủ>:8788/admin`
2. Bấm nút **📤 Export Auth** → tải file `autoclaw-auth-YYYY-MM-DD.json`

### Bước 4: Import auth lên máy mới
1. Trên máy mới, mở admin panel (nếu đã chạy hub): `http://localhost:8788/admin`
   - Hoặc nếu máy mới chỉ chạy node (không chạy hub): copy file `autoclaw-auth-*.json` vào thư mục project rồi chạy script import:
   ```bash
   node -e "
   const fs=require('fs'), os=require('os'), path=require('path');
   const auth=JSON.parse(fs.readFileSync('autoclaw-auth-2026-08-26.json','utf8'));
   const dir=path.join(os.homedir(),'.openclaw-autoclaw');
   fs.mkdirSync(path.join(dir,'identity'),{recursive:true});
   fs.writeFileSync(path.join(dir,'.gateway-token'),auth.gatewayToken+'\n');
   fs.writeFileSync(path.join(dir,'identity','device.json'),JSON.stringify(auth.deviceIdentity,null,2));
   console.log('✅ Auth copied to',dir);
   "
   ```
2. Hoặc import qua admin panel: bấm **📥 Import Auth** → chọn file JSON → restart node

### Bước 5: Khởi động node trên máy mới
```bash
npm start          # node chạy tại :8787
```

### Bước 6: Thêm node vào hub
1. Về admin panel máy chủ: `http://<IP-máy-chủ>:8788/admin`
2. **Add Node**: `http://<IP-máy-mới>:8787` → bấm Add
3. Hub tự probe health + thêm vào pool

---

## Cách 2: Máy mới chạy riêng app AutoClaw (account riêng — pool quota)

Mỗi máy đăng nhập account riêng → quota gấp N lần.

1. Cài app AutoClaw trên máy mới (như bình thường)
2. Login account khác
3. Copy project: `git clone https://github.com/thienphuoc/OpenAIACZ.git`
4. `npm start` — server tự đọc auth từ app AutoClaw trên máy đó
5. Thêm vào hub qua admin panel

---

## Lưu ý

- File auth chứa JWT + device key — **không commit lên git**, không share công khai
- JWT hết hạn theo ngày (24h) — app AutoClaw tự refresh; nếu máy mới không chạy app thì JWT sẽ hết hạn sau 24h, cần export lại
- `.gateway-token` đổi mỗi lần app AutoClaw restart — nếu máy mới dùng chung gateway máy chủ thì cần re-export token khi máy chủ restart app
- Cách 2 (account riêng) ổn định hơn: mỗi máy tự refresh JWT, không phụ thuộc máy chủ
