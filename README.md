# Smart Shelf Tilt Warning System — Dashboard Node.js

Dashboard pemantauan kemiringan rak (pitch & roll), beban muatan, dan kendali servo palang.
Tanpa dependensi eksternal (hanya modul bawaan Node.js, butuh Node >= 18).

## Menjalankan

```bash
cd smart-shelf
npm start            # atau: node server.js
# buka http://localhost:3000
```

Opsi environment: `PORT=3000`, `API_KEY=rahasia` (jika diisi, `POST /api/telemetry` wajib header `x-api-key`).

Tanpa ESP32, server memakai **simulator sensor**. Pilih mode Normal / Waspada / Bahaya lewat dropdown "Simulasi" di pojok kanan atas.

## Struktur

```
server.js          server HTTP, REST API, SSE, simulator, logika ambang batas
public/index.html  tampilan
public/style.css   gaya
public/app.js      logika frontend (gauge, grafik SVG, slider, riwayat)
data/settings.json dibuat otomatis saat ambang batas disimpan
```

## Logika status

| Parameter | Waspada | Bahaya |
|---|---|---|
| Pitch / Roll | >= Batas Waspada | >= Batas Bahaya |
| Beban | >= 80% beban maksimal | > beban maksimal |

Saat status **Bahaya** dan mode otomatis aktif, palang menutup sendiri dan insiden dicatat.
Palang membuka kembali otomatis setelah kondisi Aman selama 15 detik (hanya jika ditutup otomatis).

## API

| Method | Path | Fungsi |
|---|---|---|
| GET | `/api/stream` | SSE, state live tiap detik |
| GET | `/api/state` | snapshot state |
| GET | `/api/history?range=1h\|24h` | data grafik |
| GET | `/api/incidents` | riwayat peringatan |
| GET/PUT | `/api/settings` | ambil / ubah `{warn, danger, maxLoad}` |
| POST | `/api/servo` | `{action:"open"\|"close"}` dan/atau `{auto:true\|false}` |
| POST | `/api/simulate` | `{scenario:"normal"\|"warn"\|"danger"}` |
| POST | `/api/telemetry` | dipanggil ESP32 |

## Menghubungkan ESP32

ESP32 mengirim telemetri berkala (mis. tiap 1 detik) dan membaca perintah servo dari balasan:

```bash
curl -X POST http://IP_SERVER:3000/api/telemetry \
  -H 'Content-Type: application/json' \
  -d '{"pitch":4.0,"roll":3.0,"load":1.2,"rssi":-52}'
# balasan: {"ok":true,"status":"safe","alarm":false,"led":{"color":"green","rgb":[0,255,0]},"servo":{"command":"open","angle":30}}
```

LED RGB (1 buah) mengikuti status: hijau = Aman, kuning = Waspada, merah = Bahaya (buzzer ikut aktif saat Bahaya).
ESP32 cukup memakai nilai `led.rgb` dari balasan untuk mengatur pin R, G, B.

Jika telemetri berhenti > 10 detik, server kembali memakai simulator.

## Catatan

- Data riwayat sudut dan insiden disimpan di memori (hilang saat server restart); hanya ambang batas yang disimpan ke file.
- Komunikasi memakai HTTP + SSE (bukan MQTT). Untuk TLS, taruh di belakang reverse proxy (nginx/Caddy).
