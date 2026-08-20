# CARA PASANG - APLIKASI ABSEN QR SISWA

Aplikasi ini dibuat dengan **HTML + CSS + JavaScript murni (tanpa framework)**, Firebase Authentication + Cloud Firestore, dan GitHub Pages.

Fitur utama:

- Login admin dengan Firebase Authentication.
- Scan QR dengan `navigator.mediaDevices.getUserMedia()`.
- Mode **Absen Masuk** dan **Absen Pulang**.
- Kamera tetap hidup setelah satu scan; langsung arahkan ke QR siswa berikutnya.
- Anti scan berulang saat kartu yang sama masih berada di depan kamera.
- Status otomatis **Hadir / Terlambat** sesuai jam masuk + toleransi.
- Data siswa: tambah, edit, nonaktif, hapus.
- Import siswa dari Excel dengan validasi dan preview.
- Download template Excel langsung dari aplikasi.
- Export data siswa ke Excel.
- Rekap absensi berdasarkan tanggal / kelas / status.
- Input dan koreksi absensi manual (Hadir, Terlambat, Izin, Sakit, Alpha).
- Export rekap ke file `.xlsx` dengan sheet `REKAP_ABSEN` dan `RINGKASAN`.
- Cetak kartu QR B2 **65 x 105 mm** ke PDF kertas A4, 6 kartu per halaman.
- Pengaturan nama sekolah, nama singkat, tahun pelajaran, alamat, jam masuk, toleransi, warna kartu, dan logo sekolah.
- Logo dikompres lalu disimpan langsung di Cloud Firestore, jadi aplikasi **tidak membutuhkan Firebase Storage**.

---

## 1. BUAT PROJECT FIREBASE

1. Buka Firebase Console.
2. Klik **Create a project / Buat project**.
3. Beri nama project, misalnya `absen-smp-almiftah`.
4. Google Analytics boleh dimatikan jika tidak dibutuhkan.
5. Setelah project selesai, buka halaman Project Overview.

---

## 2. TAMBAHKAN WEB APP

1. Pada Project Overview, tekan ikon **Web `</>`**.
2. Isi nickname, misalnya `Absen QR Siswa`.
3. Tidak perlu mengaktifkan Firebase Hosting karena website akan memakai GitHub Pages.
4. Tekan **Register app**.
5. Firebase menampilkan konfigurasi seperti ini:

```js
const firebaseConfig = {
  apiKey: "...",
  authDomain: "...firebaseapp.com",
  projectId: "...",
  storageBucket: "...",
  messagingSenderId: "...",
  appId: "..."
};
```

Untuk aplikasi ini yang wajib dipakai adalah:

- `apiKey`
- `authDomain`
- `projectId`
- `appId`

Buka file:

`js/firebase-config.js`

Ganti isi contoh menjadi data project Anda, misalnya:

```js
export const firebaseConfig = {
  apiKey: "AIza....",
  authDomain: "absen-smp-almiftah.firebaseapp.com",
  projectId: "absen-smp-almiftah",
  appId: "1:123456789:web:abcdef123456"
};
```

**Jangan mengubah nama `firebaseConfig`.**

---

## 3. AKTIFKAN LOGIN EMAIL/PASSWORD

1. Firebase Console → **Authentication**.
2. Tekan **Get started**.
3. Buka **Sign-in method**.
4. Pilih **Email/Password**.
5. Aktifkan **Email/Password**, kemudian Save.

### Buat akun admin

1. Masuk ke Authentication → **Users**.
2. Tekan **Add user**.
3. Contoh:
   - Email: `admin@sekolah.sch.id`
   - Password: buat password yang kuat.
4. Simpan.

Aplikasi sengaja **tidak memiliki tombol daftar akun**, sehingga orang lain tidak bisa membuat akun admin dari halaman login.

> Semua akun yang Anda buat di Firebase Authentication untuk project ini dianggap admin dan memiliki akses aplikasi. Jadi hanya buat akun untuk petugas yang dipercaya.

---

## 4. BUAT CLOUD FIRESTORE

1. Firebase Console → **Firestore Database**.
2. Tekan **Create database**.
3. Pilih **Production mode**.
4. Pilih lokasi database yang sesuai.
5. Setelah database aktif, buka tab **Rules**.
6. Buka file `firestore.rules` dari paket aplikasi.
7. Salin seluruh isinya ke tab Rules di Firebase.
8. Tekan **Publish**.

Rules yang disediakan hanya mengizinkan user yang sudah login Firebase Authentication untuk membaca atau mengubah data.

Koleksi Firestore dibuat otomatis oleh aplikasi saat dipakai:

- `students`
- `attendance`
- `settings`

Anda tidak perlu membuat koleksi satu per satu.

---

## 5. TIDAK PERLU FIREBASE STORAGE

Logo sekolah dikompres di browser lalu disimpan sebagai data gambar di dokumen `settings/school` pada Firestore.

Jadi **jangan khawatir jika menu Firebase Storage meminta upgrade billing**. Aplikasi ini tidak memakai Storage.

---

## 6. SIAPKAN GITHUB

1. Masuk ke GitHub.
2. Tekan **New repository**.
3. Nama contoh: `absen-qr-siswa`.
4. Pilih Public atau Private sesuai akun GitHub/dukungan Pages Anda.
5. Tekan **Create repository**.

### Upload file aplikasi

Upload **isi folder aplikasi**, yaitu:

```text
.nojekyll
index.html
firestore.rules
CARA-PASANG.md
css/
js/
assets/
```

Pastikan `index.html` berada di bagian paling luar/root repository, bukan terbungkus lagi di folder lain.

Cara termudah:

1. Buka repository.
2. **Add file → Upload files**.
3. Drag semua file/folder hasil ekstrak ZIP.
4. Tekan **Commit changes**.

---

## 7. AKTIFKAN GITHUB PAGES

1. Di repository GitHub → **Settings**.
2. Pilih **Pages**.
3. Pada **Build and deployment**:
   - Source: **Deploy from a branch**
   - Branch: **main**
   - Folder: **/(root)**
4. Tekan **Save**.
5. Tunggu beberapa saat sampai alamat website tampil.

Biasanya alamat seperti:

`https://USERNAME.github.io/absen-qr-siswa/`

GitHub Pages menggunakan HTTPS, sehingga kamera browser dapat memakai `getUserMedia()`.

---

## 8. TAMBAHKAN DOMAIN GITHUB KE FIREBASE AUTH

Agar aman untuk penggunaan web, tambahkan domain GitHub Pages Anda:

1. Firebase Console → Authentication → **Settings**.
2. Cari **Authorized domains**.
3. Tambahkan:

`USERNAME.github.io`

Jangan memasukkan `https://` dan jangan memasukkan `/nama-repository`.

---

## 9. LOGIN PERTAMA

1. Buka website GitHub Pages.
2. Login menggunakan email/password admin yang dibuat di Firebase Authentication.
3. Masuk menu **Pengaturan**.
4. Isi:
   - Nama sekolah.
   - Nama singkat.
   - Tahun pelajaran.
   - Alamat.
   - Logo sekolah.
   - Jam masuk.
   - Toleransi terlambat.
   - Warna kartu.
5. Tekan Simpan.

---

## 10. MASUKKAN DATA SISWA

### Cara A - tambah manual

Data Siswa → **+ Tambah Siswa**.

NISN divalidasi 10 digit dan harus unik.

### Cara B - upload Excel

1. Data Siswa → **Template Excel**.
2. Buka file template.
3. Isi data tanpa mengubah nama header.
4. Kolom yang tersedia:

| Kolom | Wajib | Contoh |
|---|---|---|
| NISN | Ya | 0012345678 |
| NAMA | Ya | AHMAD FAUZI |
| KELAS | Ya | 7A |
| JK | Tidak | L atau P |
| AKTIF | Tidak | YA / TIDAK |
| NAMA_ORANG_TUA | Tidak | BUDI |
| NO_HP_ORANG_TUA | Tidak | 081234567890 |

5. Kembali ke aplikasi → **Import Excel**.
6. Pilih file.
7. Aplikasi menampilkan preview:
   - Valid
   - NISN salah
   - NISN sudah ada
   - NISN duplikat di file
   - Nama/kelas kosong
8. Tekan **Import Data Valid**.

File besar diproses bertahap agar tidak melewati batas batch Firestore.

---

## 11. CETAK KARTU ABSEN

1. Masuk menu **Kartu Absen**.
2. Filter kelas jika perlu.
3. Centang siswa atau tekan **Pilih semua yang tampil**.
4. Tekan **Download PDF A4**.

Pengaturan PDF:

- Kertas: A4 portrait.
- Kartu: **B2 65 × 105 mm**.
- Isi: 6 kartu per halaman (3 kolom × 2 baris).
- QR berisi token ID internal siswa, bukan password.
- Desain biru-putih mengikuti contoh gambar yang diberikan.

Cetak PDF dengan pengaturan printer:

- **Actual size / 100%**.
- Jangan pilih “Fit to page” jika Anda ingin ukuran fisik kartu tetap 65 × 105 mm.

---

## 12. CARA SCAN ABSEN

1. Buka **Scan Absen**.
2. Pilih **Absen Masuk** atau **Absen Pulang**.
3. Tekan **Mulai Kamera**.
4. Izinkan akses kamera pada browser.
5. Arahkan QR kartu siswa ke kotak scanner.

### Kamera tidak tertutup setelah scan

Setelah QR berhasil:

- Kamera tetap hidup.
- Hasil siswa muncul di sisi kanan.
- Langsung pindahkan kartu dan arahkan QR siswa berikutnya.
- QR yang sama tidak akan diproses berulang selama masih terlihat di kamera.

### Absen masuk

- Pertama kali scan pada hari tersebut → tersimpan sebagai masuk.
- Jika waktunya melewati `Jam Masuk + Toleransi`, status otomatis menjadi **Terlambat**.
- Scan masuk kedua siswa yang sama akan ditolak sebagai duplikat.

### Absen pulang

- Siswa harus sudah absen masuk.
- Scan pulang pertama disimpan.
- Scan pulang kedua ditolak sebagai duplikat.

---

## 13. REKAP DAN EXCEL

1. Buka **Rekap Absen**.
2. Pilih tanggal awal dan akhir.
3. Filter kelas/status jika diperlukan.
4. Tekan **Tampilkan**.
5. Tekan **Download Excel**.

File Excel mempunyai:

- Sheet `REKAP_ABSEN`
- Sheet `RINGKASAN`

Anda juga dapat menekan **Input Manual** untuk:

- Hadir
- Terlambat
- Izin
- Sakit
- Alpha

Baris rekap dapat diedit atau dihapus oleh admin.

---

## 14. JIKA KAMERA TIDAK BISA DIBUKA

Periksa:

1. Website dibuka melalui URL GitHub Pages `https://...`, bukan file HTML yang dibuka langsung dari penyimpanan HP.
2. Browser sudah mendapat izin kamera.
3. Coba Chrome/Edge/Safari versi terbaru.
4. Jika HP memiliki beberapa kamera, tekan **Muat Kamera** lalu pilih kamera lain.
5. Tutup aplikasi lain yang sedang menggunakan kamera.

---

## 15. JIKA LOGIN GAGAL

Periksa berurutan:

1. `js/firebase-config.js` sudah menggunakan project Firebase yang benar.
2. Firebase Authentication → Sign-in method → Email/Password sudah ON.
3. Authentication → Users → akun admin benar-benar ada.
4. Password benar.
5. Firestore Rules sudah dipublish.
6. Domain `USERNAME.github.io` sudah ditambahkan ke Authorized domains.
7. Buka Developer Tools browser → Console bila masih gagal dan lihat pesan error.

---

## 16. JIKA MUNCUL “MISSING OR INSUFFICIENT PERMISSIONS”

Artinya Firestore Rules belum benar.

Buka Firebase Console → Firestore Database → Rules → tempel isi `firestore.rules` → **Publish**.

---

## 17. STRUKTUR PROJECT

```text
absen-qr-siswa/
├── .nojekyll
├── index.html
├── firestore.rules
├── CARA-PASANG.md
├── css/
│   └── style.css
├── js/
│   ├── firebase-config.js   ← FILE YANG HARUS ANDA ISI
│   ├── firebase.js
│   └── app.js
└── assets/
    └── referensi-kartu-b2.jpg
```

---

## CATATAN KEAMANAN

- Jangan membuat fitur signup umum untuk aplikasi ini.
- Gunakan password admin yang kuat.
- Hanya akun Firebase Authentication yang dapat membaca/menulis Firestore dengan rules yang disertakan.
- Jangan mengganti Firestore Rules menjadi `allow read, write: if true;` pada aplikasi produksi.
- Data siswa termasuk data pribadi; batasi akses akun admin dan jangan membagikan password.

