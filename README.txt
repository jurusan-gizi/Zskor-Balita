Z-SKOR BALITA — pengolah z-score WHO 2006 (offline, data tetap di perangkat)

Cara pasang (GitHub Pages):
1. Buat repository baru, unggah SEMUA file di folder ini (index.html, logo-poltekkes.png, zscore.js, sav.js, who-lms.js,
   xlsx.full.min.js, sw.js, manifest.json, icon-192.png, icon-512.png).
2. Settings > Pages > Branch: main / root > Save.
3. Buka link-nya sekali (perlu internet), lalu "Install aplikasi" / "Tambahkan ke layar utama".
   Setelah itu aplikasi bisa dipakai tanpa internet.

Cara pakai tanpa hosting: TIDAK bisa dibuka dengan klik ganda index.html (fitur offline butuh http/https).
Kalau perlu lokal di laptop: buka folder ini di terminal, jalankan  python -m http.server 8000
lalu buka http://localhost:8000

Catatan:
- Simpan di browser: pilih masa simpan (1–30 hari) sebelum klik Proses. Data disimpan di browser
  perangkat itu saja dan terhapus otomatis setelah masa simpan habis. Jangan aktifkan di komputer bersama.
- Unduh: bila unduhan tidak muncul, pakai tautan 'klik di sini' atau tombol 'Bagikan / Simpan ke…' (HP).
- Format masukan: Excel/CSV atau SPSS (.sav / .zsav). File SPSS dibaca langsung di browser,
  termasuk label variabel, label nilai, tanggal, dan kode missing.
- Data hanya diolah di browser, tidak diunggah ke server mana pun (termasuk GitHub).
- Hasil diuji identik dengan output resmi WHO (igrowup) pada 498 data uji, 4 indikator.
- Prevalensi di layar = tanpa bobot survei. Untuk angka prevalensi resmi SSGI, pakai bobot/strata/klaster.
