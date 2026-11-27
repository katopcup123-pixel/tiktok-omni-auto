# TikTok Omni Auto

แอปสร้างและโพสวิดีโอ TikTok แนวตั้ง (9:16) ความยาว **2–3 นาที** อัตโนมัติทุกวัน โดยใช้ **Gemini 3.8 Flash** (วางสคริปต์/แตกฉาก) + **Gemini Omni 1.2 Flash** (เจนวิดีโอทีละฉากสูงสุด 15 วิ พร้อมต่อเฟรมสุดท้ายให้ภาพต่อเนื่อง) + **FFmpeg** (ต่อคลิปเป็น MP4 มาตรฐาน TikTok) + **TikTok Content Posting API**

- **Zero npm dependencies** — ใช้ Node.js built-in ล้วน ติดตั้งง่าย ไม่ติด dependency bloat
- **Web UI + Daily Scheduler** — ตั้งค่าธีมช่อง, เวลาโพสทุกวัน, เชื่อมต่อ TikTok OAuth, พรีวิวคลิป และกด Dry Run ฟรีได้ทันที
- **CLI + GitHub Actions** — รันแบบคำสั่งเดียวได้ (`node src/cli.js`)

## สิ่งที่ต้องมีในเครื่อง
1. **Node.js >= 20**
2. **FFmpeg** (อยู่ใน `PATH`)

## วิธีติดตั้งและใช้งาน (3 ขั้นตอน)

```bash
git clone https://github.com/katopcup123-pixel/tiktok-omni-auto.git
cd tiktok-omni-auto
cp .env.example .env
```

1. เปิดไฟล์ `.env` แล้วใส่ค่า:
   - `GEMINI_API_KEY` — จาก [Google AI Studio](https://aistudio.google.com/apikey)
   - `TIKTOK_CLIENT_KEY` และ `TIKTOK_CLIENT_SECRET` — จาก [TikTok for Developers](https://developers.tiktok.com/) (ตั้ง Redirect URI เป็น `http://localhost:3456/auth/tiktok/callback`)
2. รันแอป:
   ```bash
   node src/server.js
   ```
3. เปิดเบราว์เซอร์ไปที่ `http://localhost:3456`:
   - กด **ทดสอบระบบ (Dry Run ฟรี)** เพื่อทดสอบการต่อคลิปด้วย FFmpeg โดยไม่เสียเครดิต API
   - กด **เชื่อมต่อบัญชี TikTok (OAuth)**
   - ตั้งค่าธีมช่อง + เวลาโพสประจำวัน -> ติ๊ก **เปิดรันอัตโนมัติทุกวัน** -> กดบันทึก

## คำสั่ง CLI
```bash
node src/cli.js --dry-run   # ทดสอบสร้างคลิปจำลอง (ฟรี)
node src/cli.js             # สร้างและโพสจริง 1 คลิป
node --test test/pipeline.test.js  # รัน automated tests
```

## ข้อจำกัดที่ควรรู้
- **Gemini Omni 1.2 Flash** เจนคลิปได้ครั้งละ **3–15 วินาที** แอปจึงแตกสคริปต์เป็น 10–12 ฉาก แล้วต่อกันด้วย FFmpeg ให้ได้ 2–3 นาที (10–12 คลิป/วันมีต้นทุน API — แนะนำเริ่มที่ `720p`)
- **TikTok Content Posting API** จะโพสได้เฉพาะโหมด **Draft/ส่วนตัว (`SELF_ONLY`)** จนกว่าแอปของคุณจะผ่าน **TikTok Audit** ถึงจะเปลี่ยนเป็น `PUBLIC_TO_EVERYONE` ได้
- Token ของ TikTok หมดอายุทุก 24 ชม. แอปมีระบบ auto-refresh token ให้ใน `src/tiktok.js` แล้ว
