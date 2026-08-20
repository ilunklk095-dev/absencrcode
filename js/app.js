import { auth, db, firebaseConfigured } from "./firebase.js";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  deleteDoc,
  query,
  where,
  serverTimestamp,
  writeBatch,
  runTransaction,
  Timestamp
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";

const $ = (id) => document.getElementById(id);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const DEFAULT_SETTINGS = {
  schoolName: "SMP AL-MIFTAH",
  schoolShort: "SMP AL-MIFTAH",
  academicYear: "2026/2027",
  address: "",
  startTime: "07:00",
  lateTolerance: 10,
  cardSideText: "SMP AL-MIFTAH KETAPANG",
  primaryColor: "#34528e",
  accentColor: "#6aa7e8",
  logoDataUrl: ""
};

const PAGE_META = {
  dashboard: ["Dashboard", "Ringkasan absensi hari ini"],
  scanner: ["Scan Absen", "Scan QR untuk absen masuk dan pulang"],
  students: ["Data Siswa", "Kelola siswa dan import Excel"],
  reports: ["Rekap Absen", "Filter, koreksi, dan export data"],
  cards: ["Kartu Absen", "Cetak kartu QR B2 ke PDF A4"],
  settings: ["Pengaturan", "Identitas sekolah dan aturan absensi"]
};

const state = {
  user: null,
  settings: { ...DEFAULT_SETTINGS },
  students: [],
  studentsById: new Map(),
  attendanceToday: [],
  reportRows: [],
  importRows: [],
  stream: null,
  scannerActive: false,
  scanLoopId: null,
  scanMode: "masuk",
  blockedCode: null,
  noCodeSince: 0,
  processingScan: false,
  lastScanFrameAt: 0,
  torchOn: false,
  currentPage: "dashboard"
};

// ---------- UTILITIES ----------
function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function localDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function monthStartKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-01`;
}

function dateToIndo(dateStr) {
  if (!dateStr) return "-";
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return new Intl.DateTimeFormat("id-ID", { day: "2-digit", month: "short", year: "numeric" }).format(dt);
}

function formatTime(value) {
  if (!value) return "-";
  let d;
  if (typeof value?.toDate === "function") d = value.toDate();
  else if (value instanceof Date) d = value;
  else d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(d);
}

function timestampMs(value) {
  if (!value) return 0;
  if (typeof value?.toMillis === "function") return value.toMillis();
  if (typeof value?.toDate === "function") return value.toDate().getTime();
  const n = new Date(value).getTime();
  return Number.isNaN(n) ? 0 : n;
}

function latestAttendanceMs(row) {
  return Math.max(timestampMs(row.pulangAt), timestampMs(row.masukAt), timestampMs(row.updatedAt));
}

function statusBadge(status) {
  const s = status || "-";
  const cls = s === "Hadir" ? "green" : s === "Terlambat" ? "orange" : s === "Alpha" ? "red" : s === "Izin" || s === "Sakit" ? "blue" : "gray";
  return `<span class="badge ${cls}">${escapeHtml(s)}</span>`;
}

function toast(title, message = "", type = "info", timeout = 3600) {
  const root = $("toastRoot");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerHTML = `<div><strong>${escapeHtml(title)}</strong>${message ? `<span>${escapeHtml(message)}</span>` : ""}</div><button aria-label="Tutup">✕</button>`;
  el.querySelector("button").addEventListener("click", () => el.remove());
  root.appendChild(el);
  setTimeout(() => el.remove(), timeout);
}

function setBusy(button, busy, label = "Memproses...") {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.textContent = label;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    button.disabled = false;
  }
}

function openModal(id) { $(id)?.classList.remove("hidden"); }
function closeModal(id) { $(id)?.classList.add("hidden"); }

function applyTheme() {
  document.documentElement.style.setProperty("--primary", state.settings.primaryColor || DEFAULT_SETTINGS.primaryColor);
  document.documentElement.style.setProperty("--primary-2", state.settings.primaryColor || DEFAULT_SETTINGS.primaryColor);
  document.documentElement.style.setProperty("--accent", state.settings.accentColor || DEFAULT_SETTINGS.accentColor);
}

function classListFromStudents() {
  return [...new Set(state.students.filter(s => s.active !== false).map(s => String(s.kelas || "").trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "id", { numeric: true }));
}

function fillClassSelect(select, includeAllLabel = "Semua Kelas") {
  if (!select) return;
  const current = select.value;
  select.innerHTML = `<option value="">${includeAllLabel}</option>` + classListFromStudents().map(k => `<option value="${escapeHtml(k)}">${escapeHtml(k)}</option>`).join("");
  if ([...select.options].some(o => o.value === current)) select.value = current;
}

function populateClassSelects() {
  fillClassSelect($("studentClassFilter"));
  fillClassSelect($("reportClass"));
  fillClassSelect($("cardClassFilter"));
}

function studentById(id) { return state.studentsById.get(id) || null; }

function validateLibraries() {
  const missing = [];
  if (!window.jsQR) missing.push("jsQR");
  if (!window.QRCode) missing.push("QRCode");
  if (!window.XLSX) missing.push("SheetJS/XLSX");
  if (!window.jspdf?.jsPDF) missing.push("jsPDF");
  if (missing.length) toast("Library gagal dimuat", `Periksa koneksi internet: ${missing.join(", ")}`, "error", 7000);
}

function toIsoTimeString(date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function timeForInput(value) {
  if (!value) return "";
  const d = typeof value?.toDate === "function" ? value.toDate() : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return toIsoTimeString(d);
}

function buildDateTime(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const d = new Date(`${dateStr}T${timeStr}:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isLate(date = new Date()) {
  const [h, m] = String(state.settings.startTime || "07:00").split(":").map(Number);
  const threshold = h * 60 + m + Number(state.settings.lateTolerance || 0);
  const nowMinutes = date.getHours() * 60 + date.getMinutes();
  return nowMinutes > threshold;
}

function sanitizeNisn(value) {
  let s = String(value ?? "").trim().replace(/\.0$/, "").replace(/\s/g, "");
  if (/^\d+$/.test(s) && s.length < 10) s = s.padStart(10, "0");
  return s;
}

function normalizeGender(value) {
  const v = String(value || "").trim().toUpperCase().replace(/[_-]/g, " ");
  if (["L", "LAKI LAKI", "LAKI-LAKI", "MALE"].includes(v)) return "L";
  if (["P", "PEREMPUAN", "FEMALE"].includes(v)) return "P";
  return "";
}

function parseActive(value) {
  const v = String(value ?? "YA").trim().toUpperCase();
  return !["TIDAK", "NONAKTIF", "FALSE", "0", "NO"].includes(v);
}

// ---------- AUTH ----------
async function handleLogin(e) {
  e.preventDefault();
  const button = $("loginBtn");
  setBusy(button, true, "Masuk...");
  try {
    await signInWithEmailAndPassword(auth, $("loginEmail").value.trim(), $("loginPassword").value);
  } catch (err) {
    console.error(err);
    toast("Login gagal", "Periksa email/password dan pastikan Email/Password sudah diaktifkan di Firebase Authentication.", "error", 5500);
  } finally { setBusy(button, false); }
}

async function handlePasswordReset() {
  const email = $("loginEmail").value.trim();
  if (!email) return toast("Isi email", "Masukkan email admin terlebih dahulu.", "warning");
  try {
    await sendPasswordResetEmail(auth, email);
    toast("Email reset dikirim", "Periksa inbox/spam email admin.", "success");
  } catch (err) {
    console.error(err);
    toast("Gagal mengirim reset", "Pastikan email terdaftar di Firebase Authentication.", "error");
  }
}

async function bootstrapSignedIn(user) {
  state.user = user;
  $("loginScreen").classList.add("hidden");
  $("appShell").classList.remove("hidden");
  $("userEmailMini").textContent = user.email || "-";
  $("settingsUserEmail").textContent = user.email || "-";
  try {
    await loadSettings();
    await loadStudents();
    await loadTodayAttendance();
    renderAllCoreViews();
    refreshCameraList().catch(() => {});
  } catch (err) {
    console.error(err);
    toast("Gagal memuat data", readableFirebaseError(err), "error", 7000);
  }
}

function readableFirebaseError(err) {
  const code = err?.code || "";
  if (code.includes("permission-denied")) return "Akses ditolak Firestore. Pasang firestore.rules dari paket aplikasi lalu Publish.";
  if (code.includes("failed-precondition")) return "Firestore belum siap atau memerlukan konfigurasi tambahan.";
  if (code.includes("unavailable")) return "Firebase tidak dapat dijangkau. Periksa internet.";
  return err?.message || "Terjadi kesalahan Firebase.";
}

// ---------- SETTINGS ----------
async function loadSettings() {
  const snap = await getDoc(doc(db, "settings", "school"));
  state.settings = snap.exists() ? { ...DEFAULT_SETTINGS, ...snap.data() } : { ...DEFAULT_SETTINGS };
  applyTheme();
  renderSettings();
}

function renderSettings() {
  const s = state.settings;
  $("sidebarSchoolName").textContent = s.schoolName;
  $("settingSchoolName").value = s.schoolName || "";
  $("settingSchoolShort").value = s.schoolShort || "";
  $("settingAcademicYear").value = s.academicYear || "";
  $("settingAddress").value = s.address || "";
  $("settingStartTime").value = s.startTime || "07:00";
  $("settingLateTolerance").value = s.lateTolerance ?? 10;
  $("settingCardSideText").value = s.cardSideText || s.schoolName || "";
  $("settingPrimaryColor").value = s.primaryColor || DEFAULT_SETTINGS.primaryColor;
  $("settingAccentColor").value = s.accentColor || DEFAULT_SETTINGS.accentColor;
  const preview = $("settingsLogoPreview");
  preview.innerHTML = s.logoDataUrl ? `<img alt="Logo sekolah" src="${s.logoDataUrl}">` : "LOGO";
  renderCardPreview();
}

async function saveSchoolSettings(e) {
  e.preventDefault();
  const patch = {
    schoolName: $("settingSchoolName").value.trim() || DEFAULT_SETTINGS.schoolName,
    schoolShort: $("settingSchoolShort").value.trim() || $("settingSchoolName").value.trim(),
    academicYear: $("settingAcademicYear").value.trim(),
    address: $("settingAddress").value.trim(),
    updatedAt: serverTimestamp()
  };
  try {
    await setDoc(doc(db, "settings", "school"), patch, { merge: true });
    Object.assign(state.settings, patch);
    renderSettings();
    toast("Identitas tersimpan", "Nama dan identitas sekolah sudah diperbarui.", "success");
  } catch (err) { toast("Gagal menyimpan", readableFirebaseError(err), "error"); }
}

async function saveAttendanceSettings(e) {
  e.preventDefault();
  const patch = {
    startTime: $("settingStartTime").value || "07:00",
    lateTolerance: Math.max(0, Number($("settingLateTolerance").value || 0)),
    cardSideText: $("settingCardSideText").value.trim(),
    primaryColor: $("settingPrimaryColor").value,
    accentColor: $("settingAccentColor").value,
    updatedAt: serverTimestamp()
  };
  try {
    await setDoc(doc(db, "settings", "school"), patch, { merge: true });
    Object.assign(state.settings, patch);
    applyTheme();
    renderSettings();
    toast("Aturan tersimpan", "Jam masuk, toleransi, dan warna kartu sudah diperbarui.", "success");
  } catch (err) { toast("Gagal menyimpan", readableFirebaseError(err), "error"); }
}

function imageFileToCompressedDataUrl(file, maxDimension = 420) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const scale = Math.min(1, maxDimension / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        let quality = .86;
        let data = canvas.toDataURL("image/jpeg", quality);
        while (data.length > 320000 && quality > .45) {
          quality -= .1;
          data = canvas.toDataURL("image/jpeg", quality);
        }
        if (data.length > 500000) reject(new Error("Logo masih terlalu besar. Gunakan gambar yang lebih kecil."));
        else resolve(data);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function handleLogoUpload(file) {
  if (!file) return;
  if (!file.type.startsWith("image/")) return toast("File tidak valid", "Pilih file gambar PNG/JPG/WebP.", "warning");
  try {
    const dataUrl = await imageFileToCompressedDataUrl(file);
    await setDoc(doc(db, "settings", "school"), { logoDataUrl: dataUrl, updatedAt: serverTimestamp() }, { merge: true });
    state.settings.logoDataUrl = dataUrl;
    renderSettings();
    toast("Logo tersimpan", "Logo sudah dipakai pada kartu dan panel.", "success");
  } catch (err) { toast("Gagal memproses logo", err.message, "error"); }
}

async function removeLogo() {
  if (!confirm("Hapus logo sekolah dari aplikasi?")) return;
  await setDoc(doc(db, "settings", "school"), { logoDataUrl: "", updatedAt: serverTimestamp() }, { merge: true });
  state.settings.logoDataUrl = "";
  renderSettings();
  toast("Logo dihapus", "Anda dapat mengunggah logo baru kapan saja.", "success");
}

// ---------- STUDENTS ----------
async function loadStudents() {
  const snap = await getDocs(collection(db, "students"));
  state.students = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => String(a.nama || "").localeCompare(String(b.nama || ""), "id"));
  state.studentsById = new Map(state.students.map(s => [s.id, s]));
  populateClassSelects();
  populateManualStudentSelect();
  renderStudents();
  renderCardSelection();
}

function renderStudents() {
  const term = $("studentSearch")?.value.trim().toLowerCase() || "";
  const kelas = $("studentClassFilter")?.value || "";
  const activeFilter = $("studentActiveFilter")?.value || "active";
  const rows = state.students.filter(s => {
    const matchTerm = !term || String(s.nama || "").toLowerCase().includes(term) || String(s.nisn || "").toLowerCase().includes(term);
    const matchClass = !kelas || s.kelas === kelas;
    const isActive = s.active !== false;
    const matchActive = activeFilter === "all" || (activeFilter === "active" && isActive) || (activeFilter === "inactive" && !isActive);
    return matchTerm && matchClass && matchActive;
  });
  $("studentCountLabel").textContent = `${rows.length} siswa`;
  $("studentsBody").innerHTML = rows.length ? rows.map(s => `
    <tr>
      <td>${escapeHtml(s.nisn || "-")}</td>
      <td><strong>${escapeHtml(s.nama || "-")}</strong></td>
      <td>${escapeHtml(s.kelas || "-")}</td>
      <td>${escapeHtml(s.jk || "-")}</td>
      <td>${s.active === false ? '<span class="badge gray">Nonaktif</span>' : '<span class="badge green">Aktif</span>'}</td>
      <td><code>${escapeHtml((s.qrToken || s.id).slice(0, 10))}…</code></td>
      <td class="text-right"><div class="table-actions"><button class="action-btn" data-edit-student="${s.id}">Edit</button><button class="action-btn red" data-delete-student="${s.id}">Hapus</button></div></td>
    </tr>`).join("") : `<tr><td colspan="7" class="empty-cell">Tidak ada siswa yang sesuai filter.</td></tr>`;
}

function openStudentEditor(id = "") {
  const s = id ? studentById(id) : null;
  $("studentModalTitle").textContent = s ? "Edit Siswa" : "Tambah Siswa";
  $("studentId").value = s?.id || "";
  $("studentNisn").value = s?.nisn || "";
  $("studentName").value = s?.nama || "";
  $("studentClass").value = s?.kelas || "";
  $("studentGender").value = s?.jk || "";
  $("studentActive").value = String(s?.active !== false);
  $("studentParentName").value = s?.parentName || "";
  $("studentParentPhone").value = s?.parentPhone || "";
  openModal("studentModal");
}

async function saveStudent(e) {
  e.preventDefault();
  const button = $("saveStudentBtn");
  setBusy(button, true, "Menyimpan...");
  try {
    const id = $("studentId").value;
    const nisn = sanitizeNisn($("studentNisn").value);
    if (!/^\d{10}$/.test(nisn)) throw new Error("NISN harus berisi 10 digit angka.");
    const duplicate = state.students.find(s => s.nisn === nisn && s.id !== id);
    if (duplicate) throw new Error(`NISN sudah dipakai oleh ${duplicate.nama}.`);
    const payload = {
      nisn,
      nama: $("studentName").value.trim(),
      kelas: $("studentClass").value.trim(),
      jk: $("studentGender").value,
      active: $("studentActive").value === "true",
      parentName: $("studentParentName").value.trim(),
      parentPhone: $("studentParentPhone").value.trim(),
      updatedAt: serverTimestamp()
    };
    if (!payload.nama || !payload.kelas) throw new Error("Nama dan kelas wajib diisi.");
    if (id) {
      await setDoc(doc(db, "students", id), payload, { merge: true });
    } else {
      const ref = doc(collection(db, "students"));
      await setDoc(ref, { ...payload, qrToken: ref.id, createdAt: serverTimestamp() });
    }
    closeModal("studentModal");
    await loadStudents();
    renderDashboard();
    toast("Data siswa tersimpan", payload.nama, "success");
  } catch (err) {
    toast("Tidak dapat menyimpan", err.message || readableFirebaseError(err), "error");
  } finally { setBusy(button, false); }
}

async function deleteStudent(id) {
  const s = studentById(id);
  if (!s || !confirm(`Hapus ${s.nama} dari data siswa? Riwayat absensi lama tidak ikut dihapus.`)) return;
  try {
    await deleteDoc(doc(db, "students", id));
    await loadStudents();
    renderDashboard();
    toast("Siswa dihapus", s.nama, "success");
  } catch (err) { toast("Gagal menghapus", readableFirebaseError(err), "error"); }
}

function downloadStudentTemplate() {
  if (!window.XLSX) return toast("XLSX belum tersedia", "Periksa koneksi internet.", "error");
  const data = [
    ["NISN", "NAMA", "KELAS", "JK", "AKTIF", "NAMA_ORANG_TUA", "NO_HP_ORANG_TUA"],
    ["0012345678", "AHMAD FAUZI", "7A", "L", "YA", "BUDI", "081234567890"],
    ["0012345679", "SITI AISYAH", "7A", "P", "YA", "SITI AMINAH", "081234567891"]
  ];
  const ws = XLSX.utils.aoa_to_sheet(data);
  ws["!cols"] = [{ wch: 16 }, { wch: 28 }, { wch: 12 }, { wch: 8 }, { wch: 10 }, { wch: 24 }, { wch: 20 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "DATA_SISWA");
  XLSX.writeFile(wb, "template-import-siswa.xlsx");
  toast("Template diunduh", "Isi data tanpa mengubah nama kolom.", "success");
}

async function parseExcelImport(file) {
  if (!window.XLSX) return toast("XLSX belum tersedia", "Periksa koneksi internet.", "error");
  try {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array" });
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    const rawRows = XLSX.utils.sheet_to_json(firstSheet, { defval: "", raw: false });
    if (!rawRows.length) throw new Error("File Excel tidak berisi data.");
    const existing = new Set(state.students.map(s => s.nisn));
    const seen = new Set();
    state.importRows = rawRows.map((raw, idx) => {
      const normalized = {};
      for (const [key, value] of Object.entries(raw)) normalized[String(key).trim().toUpperCase()] = value;
      const nisn = sanitizeNisn(normalized.NISN);
      const nama = String(normalized.NAMA || "").trim();
      const kelas = String(normalized.KELAS || "").trim();
      const jk = normalizeGender(normalized.JK);
      const active = parseActive(normalized.AKTIF);
      const errors = [];
      if (!/^\d{10}$/.test(nisn)) errors.push("NISN harus 10 digit");
      if (!nama) errors.push("Nama kosong");
      if (!kelas) errors.push("Kelas kosong");
      if (normalized.JK && !jk) errors.push("JK harus L/P");
      if (existing.has(nisn)) errors.push("NISN sudah ada");
      if (seen.has(nisn)) errors.push("NISN duplikat di file");
      if (nisn) seen.add(nisn);
      return {
        rowNumber: idx + 2,
        nisn, nama, kelas, jk, active,
        parentName: String(normalized.NAMA_ORANG_TUA || "").trim(),
        parentPhone: String(normalized.NO_HP_ORANG_TUA || "").trim(),
        valid: errors.length === 0,
        errors
      };
    });
    renderImportPreview();
    openModal("importModal");
  } catch (err) {
    console.error(err);
    toast("Gagal membaca Excel", err.message || "Format file tidak sesuai.", "error");
  } finally {
    $("excelFileInput").value = "";
  }
}

function renderImportPreview() {
  const valid = state.importRows.filter(r => r.valid).length;
  const invalid = state.importRows.length - valid;
  $("importSummary").innerHTML = `<span class="summary-chip">Total ${state.importRows.length}</span><span class="summary-chip valid">Valid ${valid}</span><span class="summary-chip invalid">Bermasalah ${invalid}</span>${state.importRows.length > 200 ? '<span class="summary-chip">Preview 200 baris pertama</span>' : ""}`;
  $("importPreviewBody").innerHTML = state.importRows.slice(0, 200).map(r => `
    <tr>
      <td>${r.rowNumber}</td><td>${escapeHtml(r.nisn)}</td><td>${escapeHtml(r.nama)}</td><td>${escapeHtml(r.kelas)}</td><td>${escapeHtml(r.jk || "-")}</td>
      <td>${r.valid ? '<span class="badge green">Valid</span>' : '<span class="badge red">Tidak valid</span>'}</td>
      <td>${escapeHtml(r.errors.join(", ") || "Siap diimpor")}</td>
    </tr>`).join("");
  $("confirmImportBtn").disabled = valid === 0;
}

async function confirmImport() {
  const button = $("confirmImportBtn");
  const validRows = state.importRows.filter(r => r.valid);
  if (!validRows.length) return;
  setBusy(button, true, "Mengimpor...");
  try {
    for (let i = 0; i < validRows.length; i += 400) {
      const chunk = validRows.slice(i, i + 400);
      const batch = writeBatch(db);
      for (const r of chunk) {
        const ref = doc(collection(db, "students"));
        batch.set(ref, {
          nisn: r.nisn,
          nama: r.nama,
          kelas: r.kelas,
          jk: r.jk,
          active: r.active,
          parentName: r.parentName,
          parentPhone: r.parentPhone,
          qrToken: ref.id,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        });
      }
      await batch.commit();
    }
    closeModal("importModal");
    state.importRows = [];
    await loadStudents();
    renderDashboard();
    toast("Import selesai", `${validRows.length} siswa berhasil ditambahkan.`, "success", 5000);
  } catch (err) {
    console.error(err);
    toast("Import gagal", readableFirebaseError(err), "error", 6500);
  } finally { setBusy(button, false); }
}

function exportStudents() {
  if (!window.XLSX) return toast("XLSX belum tersedia", "Periksa koneksi internet.", "error");
  const rows = state.students.map((s, i) => ({
    NO: i + 1,
    NISN: s.nisn || "",
    NAMA: s.nama || "",
    KELAS: s.kelas || "",
    JK: s.jk || "",
    AKTIF: s.active === false ? "TIDAK" : "YA",
    NAMA_ORANG_TUA: s.parentName || "",
    NO_HP_ORANG_TUA: s.parentPhone || "",
    QR_ID: s.qrToken || s.id
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  ws["!cols"] = [{ wch: 6 }, { wch: 16 }, { wch: 28 }, { wch: 12 }, { wch: 8 }, { wch: 10 }, { wch: 24 }, { wch: 20 }, { wch: 25 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "DATA_SISWA");
  XLSX.writeFile(wb, `data-siswa-${localDateKey()}.xlsx`);
}

// ---------- ATTENDANCE / DASHBOARD ----------
async function loadTodayAttendance() {
  const today = localDateKey();
  const snap = await getDocs(query(collection(db, "attendance"), where("date", "==", today)));
  state.attendanceToday = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  renderDashboard();
  renderScannerHistory();
}

function renderDashboard() {
  const activeStudents = state.students.filter(s => s.active !== false);
  const present = state.attendanceToday.filter(r => ["Hadir", "Terlambat"].includes(r.status));
  $("statTotalStudents").textContent = activeStudents.length;
  $("statPresent").textContent = present.length;
  $("statLate").textContent = state.attendanceToday.filter(r => r.status === "Terlambat").length;
  $("statCheckout").textContent = state.attendanceToday.filter(r => r.pulangAt).length;
  $("dashboardGreeting").textContent = state.settings.schoolName ? `Selamat datang, ${state.settings.schoolName}` : "Selamat datang";

  const recent = [...state.attendanceToday].sort((a, b) => latestAttendanceMs(b) - latestAttendanceMs(a)).slice(0, 10);
  $("recentAttendanceBody").innerHTML = recent.length ? recent.map(r => `
    <tr><td><strong>${escapeHtml(r.nama || "-")}</strong></td><td>${escapeHtml(r.kelas || "-")}</td><td>${statusBadge(r.status)}</td><td>${formatTime(r.masukAt)}</td><td>${formatTime(r.pulangAt)}</td></tr>`).join("") : `<tr><td colspan="5" class="empty-cell">Belum ada absensi hari ini.</td></tr>`;

  const counts = new Map();
  for (const s of activeStudents) counts.set(s.kelas || "Tanpa kelas", (counts.get(s.kelas || "Tanpa kelas") || 0) + 1);
  const max = Math.max(1, ...counts.values());
  $("classSummary").innerHTML = counts.size ? [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0], "id", { numeric: true })).map(([kelas, count]) => `
    <div class="class-row"><strong>${escapeHtml(kelas)}</strong><div class="class-track"><i style="width:${Math.round(count / max * 100)}%"></i></div><span>${count}</span></div>`).join("") : `<div class="empty-state-mini">Belum ada data siswa.</div>`;
}

function renderAllCoreViews() {
  renderSettings();
  renderStudents();
  renderDashboard();
  renderScannerHistory();
  renderCardSelection();
  renderCardPreview();
}

// ---------- SCANNER ----------
async function refreshCameraList() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter(d => d.kind === "videoinput");
  const select = $("cameraSelect");
  const current = select.value;
  select.innerHTML = '<option value="">Kamera belakang (otomatis)</option>' + cams.map((d, i) => `<option value="${escapeHtml(d.deviceId)}">${escapeHtml(d.label || `Kamera ${i + 1}`)}</option>`).join("");
  if ([...select.options].some(o => o.value === current)) select.value = current;
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    toast("Kamera tidak tersedia", "Buka aplikasi melalui HTTPS (GitHub Pages), lalu izinkan akses kamera.", "error", 6000);
    return;
  }
  if (state.scannerActive) return;
  const button = $("startCameraBtn");
  setBusy(button, true, "Membuka...");
  try {
    const deviceId = $("cameraSelect").value;
    const videoConstraints = deviceId
      ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
      : { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } };
    state.stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
    const video = $("scannerVideo");
    video.srcObject = state.stream;
    await video.play();
    state.scannerActive = true;
    state.blockedCode = null;
    state.noCodeSince = 0;
    $("cameraPlaceholder").classList.add("hidden");
    $("startCameraBtn").disabled = true;
    $("stopCameraBtn").disabled = false;
    $("cameraStatus").textContent = state.scanMode === "masuk" ? "Mode: Absen Masuk" : "Mode: Absen Pulang";
    await refreshCameraList();
    setupTorchAvailability();
    scanLoop();
    toast("Kamera aktif", "Scanner siap membaca QR berikutnya.", "success");
  } catch (err) {
    console.error(err);
    let msg = "Tidak dapat membuka kamera.";
    if (err?.name === "NotAllowedError") msg = "Izin kamera ditolak. Izinkan kamera pada browser lalu coba lagi.";
    if (err?.name === "NotFoundError") msg = "Kamera tidak ditemukan pada perangkat ini.";
    toast("Kamera gagal dibuka", msg, "error", 6000);
  } finally { setBusy(button, false); }
}

function stopCamera() {
  if (state.scanLoopId) cancelAnimationFrame(state.scanLoopId);
  state.scanLoopId = null;
  state.stream?.getTracks().forEach(t => t.stop());
  state.stream = null;
  state.scannerActive = false;
  state.torchOn = false;
  $("scannerVideo").srcObject = null;
  $("cameraPlaceholder").classList.remove("hidden");
  $("startCameraBtn").disabled = false;
  $("stopCameraBtn").disabled = true;
  $("torchBtn").classList.add("hidden");
  $("cameraStatus").textContent = "Siap";
}

function setupTorchAvailability() {
  const track = state.stream?.getVideoTracks?.()[0];
  const caps = track?.getCapabilities?.() || {};
  $("torchBtn").classList.toggle("hidden", !caps.torch);
}

async function toggleTorch() {
  const track = state.stream?.getVideoTracks?.()[0];
  if (!track) return;
  try {
    state.torchOn = !state.torchOn;
    await track.applyConstraints({ advanced: [{ torch: state.torchOn }] });
    $("torchBtn").textContent = state.torchOn ? "Lampu Mati" : "Lampu";
  } catch { toast("Lampu tidak didukung", "Perangkat/browser tidak mendukung kontrol flash.", "warning"); }
}

function scanLoop() {
  if (!state.scannerActive) return;
  const video = $("scannerVideo");
  const canvas = $("scannerCanvas");
  const nowFrame = performance.now();
  if (nowFrame - state.lastScanFrameAt < 130) {
    state.scanLoopId = requestAnimationFrame(scanLoop);
    return;
  }
  state.lastScanFrameAt = nowFrame;
  if (video.readyState >= 2 && video.videoWidth && video.videoHeight && window.jsQR) {
    const maxWidth = 720;
    const scale = Math.min(1, maxWidth / video.videoWidth);
    canvas.width = Math.floor(video.videoWidth * scale);
    canvas.height = Math.floor(video.videoHeight * scale);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(image.data, image.width, image.height, { inversionAttempts: "dontInvert" });
    if (code?.data) {
      state.noCodeSince = 0;
      if (code.data !== state.blockedCode && !state.processingScan) {
        state.blockedCode = code.data;
        processScannedCode(code.data);
      }
    } else {
      if (!state.noCodeSince) state.noCodeSince = Date.now();
      if (Date.now() - state.noCodeSince > 650) state.blockedCode = null;
    }
  }
  state.scanLoopId = requestAnimationFrame(scanLoop);
}

function resolveStudentFromCode(raw) {
  const value = String(raw || "").trim();
  let token = value;
  if (value.startsWith("SMPABSEN:")) token = value.slice("SMPABSEN:".length);
  return state.studentsById.get(token)
    || state.students.find(s => s.qrToken === token)
    || state.students.find(s => s.nisn === token)
    || null;
}

async function processScannedCode(raw) {
  state.processingScan = true;
  try {
    const student = resolveStudentFromCode(raw);
    if (!student) throw new Error("QR tidak terdaftar sebagai siswa di aplikasi ini.");
    if (student.active === false) throw new Error(`${student.nama} berstatus nonaktif.`);
    const date = localDateKey();
    const attendanceRef = doc(db, "attendance", `${date}_${student.id}`);
    const now = new Date();
    const mode = state.scanMode;
    const late = isLate(now);

    await runTransaction(db, async tx => {
      const snap = await tx.get(attendanceRef);
      const existing = snap.exists() ? snap.data() : {};
      if (mode === "masuk") {
        if (existing.masukAt) throw new Error(`${student.nama} sudah absen masuk hari ini.`);
        tx.set(attendanceRef, {
          studentId: student.id,
          nisn: student.nisn,
          nama: student.nama,
          kelas: student.kelas,
          date,
          status: late ? "Terlambat" : "Hadir",
          masukAt: serverTimestamp(),
          source: "qr",
          updatedAt: serverTimestamp()
        }, { merge: true });
      } else {
        if (!snap.exists() || !existing.masukAt) throw new Error(`${student.nama} belum melakukan absen masuk.`);
        if (existing.pulangAt) throw new Error(`${student.nama} sudah absen pulang hari ini.`);
        tx.set(attendanceRef, { pulangAt: serverTimestamp(), updatedAt: serverTimestamp() }, { merge: true });
      }
    });

    playBeep(true);
    showScanResult(student, mode, true, mode === "masuk" ? (late ? "Terlambat" : "Hadir") : "Pulang");
    await loadTodayAttendance();
  } catch (err) {
    console.error(err);
    playBeep(false);
    showScanResult(null, state.scanMode, false, err.message || readableFirebaseError(err));
  } finally {
    state.processingScan = false;
  }
}

function playBeep(success = true) {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = success ? 880 : 240;
    gain.gain.setValueAtTime(.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(.001, ctx.currentTime + .16);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + .17);
  } catch { /* audio optional */ }
}

function showScanResult(student, mode, success, detail) {
  const card = $("scanResultCard");
  card.classList.remove("empty-result", "success", "error");
  card.classList.add(success ? "success" : "error");
  $("scanResultTitle").textContent = success ? (mode === "masuk" ? "Absen masuk berhasil" : "Absen pulang berhasil") : "Scan ditolak";
  $("scanResultText").textContent = success ? `${student.nama} • ${student.kelas}` : detail;
  const meta = $("scanResultMeta");
  if (success) {
    meta.classList.remove("hidden");
    meta.innerHTML = `<div><span>NISN</span><strong>${escapeHtml(student.nisn)}</strong></div><div><span>Waktu</span><strong>${formatTime(new Date())}</strong></div><div><span>Mode</span><strong>${mode === "masuk" ? "Masuk" : "Pulang"}</strong></div><div><span>Status</span><strong>${escapeHtml(detail)}</strong></div>`;
  } else meta.classList.add("hidden");
}

function renderScannerHistory() {
  const rows = [...state.attendanceToday].sort((a, b) => latestAttendanceMs(b) - latestAttendanceMs(a)).slice(0, 10);
  $("scanHistory").innerHTML = rows.length ? rows.map(r => {
    const latestIsOut = timestampMs(r.pulangAt) >= timestampMs(r.masukAt) && r.pulangAt;
    return `<div class="scan-history-item"><div class="scan-history-icon">${latestIsOut ? "⇥" : "✓"}</div><div><strong>${escapeHtml(r.nama || "-")}</strong><span>${escapeHtml(r.kelas || "-")} • ${latestIsOut ? "Pulang" : r.status}</span></div><div class="scan-history-time">${formatTime(latestIsOut ? r.pulangAt : r.masukAt)}</div></div>`;
  }).join("") : `<div class="empty-state-mini">Belum ada scan.</div>`;
}

function setScanMode(mode) {
  state.scanMode = mode;
  $$("[data-scan-mode]").forEach(btn => btn.classList.toggle("active", btn.dataset.scanMode === mode));
  if (state.scannerActive) $("cameraStatus").textContent = mode === "masuk" ? "Mode: Absen Masuk" : "Mode: Absen Pulang";
}

// ---------- REPORTS ----------
async function loadReport() {
  const button = $("loadReportBtn");
  const from = $("reportFrom").value;
  const to = $("reportTo").value;
  if (!from || !to) return toast("Tanggal belum lengkap", "Pilih tanggal awal dan akhir.", "warning");
  if (from > to) return toast("Rentang salah", "Tanggal awal tidak boleh setelah tanggal akhir.", "warning");
  setBusy(button, true, "Memuat...");
  try {
    const snap = await getDocs(query(collection(db, "attendance"), where("date", ">=", from), where("date", "<=", to)));
    let rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const kelas = $("reportClass").value;
    const status = $("reportStatus").value;
    if (kelas) rows = rows.filter(r => r.kelas === kelas);
    if (status) rows = rows.filter(r => r.status === status);
    rows.sort((a, b) => b.date.localeCompare(a.date) || String(a.nama).localeCompare(String(b.nama), "id"));
    state.reportRows = rows;
    renderReport();
  } catch (err) {
    console.error(err);
    toast("Gagal memuat rekap", readableFirebaseError(err), "error", 6000);
  } finally { setBusy(button, false); }
}

function renderReport() {
  const rows = state.reportRows;
  $("reportStatTotal").textContent = rows.length;
  $("reportStatPresent").textContent = rows.filter(r => r.status === "Hadir").length;
  $("reportStatLate").textContent = rows.filter(r => r.status === "Terlambat").length;
  $("reportStatExcused").textContent = rows.filter(r => ["Izin", "Sakit"].includes(r.status)).length;
  $("reportStatAlpha").textContent = rows.filter(r => r.status === "Alpha").length;
  $("reportBody").innerHTML = rows.length ? rows.map(r => `
    <tr>
      <td>${dateToIndo(r.date)}</td><td>${escapeHtml(r.nisn || "-")}</td><td><strong>${escapeHtml(r.nama || "-")}</strong></td><td>${escapeHtml(r.kelas || "-")}</td>
      <td>${statusBadge(r.status)}</td><td>${formatTime(r.masukAt)}</td><td>${formatTime(r.pulangAt)}</td><td>${escapeHtml(r.note || "-")}</td>
      <td class="text-right"><div class="table-actions"><button class="action-btn" data-edit-attendance="${r.id}">Edit</button><button class="action-btn red" data-delete-attendance="${r.id}">Hapus</button></div></td>
    </tr>`).join("") : `<tr><td colspan="9" class="empty-cell">Tidak ada data pada filter tersebut.</td></tr>`;
}

function populateManualStudentSelect() {
  const select = $("manualStudent");
  if (!select) return;
  select.innerHTML = '<option value="">Pilih siswa...</option>' + state.students.filter(s => s.active !== false).map(s => `<option value="${s.id}">${escapeHtml(s.nama)} • ${escapeHtml(s.kelas)} • ${escapeHtml(s.nisn)}</option>`).join("");
}

function openManualAttendanceEditor(rowId = "") {
  const row = rowId ? state.reportRows.find(r => r.id === rowId) : null;
  $("manualAttendanceTitle").textContent = row ? "Edit Absensi" : "Input Absensi Manual";
  $("manualAttendanceDocId").value = row?.id || "";
  $("manualStudent").value = row?.studentId || "";
  $("manualDate").value = row?.date || localDateKey();
  $("manualStatus").value = row?.status || "Hadir";
  $("manualInTime").value = timeForInput(row?.masukAt);
  $("manualOutTime").value = timeForInput(row?.pulangAt);
  $("manualNote").value = row?.note || "";
  $("manualStudent").disabled = !!row;
  $("manualDate").disabled = !!row;
  openModal("manualAttendanceModal");
}

async function saveManualAttendance(e) {
  e.preventDefault();
  const existingId = $("manualAttendanceDocId").value;
  const studentId = $("manualStudent").value;
  const student = studentById(studentId);
  const date = $("manualDate").value;
  const status = $("manualStatus").value;
  if (!student || !date) return toast("Data belum lengkap", "Pilih siswa dan tanggal.", "warning");
  const inDate = buildDateTime(date, $("manualInTime").value);
  const outDate = buildDateTime(date, $("manualOutTime").value);
  const absentStatus = ["Izin", "Sakit", "Alpha"].includes(status);
  const refId = existingId || `${date}_${studentId}`;
  try {
    await setDoc(doc(db, "attendance", refId), {
      studentId,
      nisn: student.nisn,
      nama: student.nama,
      kelas: student.kelas,
      date,
      status,
      masukAt: absentStatus ? null : (inDate ? Timestamp.fromDate(inDate) : null),
      pulangAt: absentStatus ? null : (outDate ? Timestamp.fromDate(outDate) : null),
      note: $("manualNote").value.trim(),
      source: "manual",
      updatedAt: serverTimestamp()
    }, { merge: true });
    closeModal("manualAttendanceModal");
    $("manualStudent").disabled = false;
    $("manualDate").disabled = false;
    await loadReport();
    if (date === localDateKey()) await loadTodayAttendance();
    toast("Absensi tersimpan", `${student.nama} • ${status}`, "success");
  } catch (err) { toast("Gagal menyimpan absensi", readableFirebaseError(err), "error"); }
}

async function deleteAttendance(id) {
  const row = state.reportRows.find(r => r.id === id);
  if (!row || !confirm(`Hapus absensi ${row.nama} tanggal ${row.date}?`)) return;
  try {
    await deleteDoc(doc(db, "attendance", id));
    await loadReport();
    if (row.date === localDateKey()) await loadTodayAttendance();
    toast("Absensi dihapus", row.nama, "success");
  } catch (err) { toast("Gagal menghapus", readableFirebaseError(err), "error"); }
}

function exportReportExcel() {
  if (!state.reportRows.length) return toast("Belum ada data", "Tampilkan rekap terlebih dahulu.", "warning");
  if (!window.XLSX) return toast("XLSX belum tersedia", "Periksa koneksi internet.", "error");
  const data = state.reportRows.map((r, i) => ({
    NO: i + 1,
    TANGGAL: r.date,
    NISN: r.nisn || "",
    NAMA: r.nama || "",
    KELAS: r.kelas || "",
    STATUS: r.status || "",
    JAM_MASUK: formatTime(r.masukAt),
    JAM_PULANG: formatTime(r.pulangAt),
    KETERANGAN: r.note || "",
    SUMBER: r.source || ""
  }));
  const summary = [
    ["REKAP ABSENSI", state.settings.schoolName],
    ["Periode", `${$("reportFrom").value} s.d. ${$("reportTo").value}`],
    ["Jumlah data", state.reportRows.length],
    ["Hadir", state.reportRows.filter(r => r.status === "Hadir").length],
    ["Terlambat", state.reportRows.filter(r => r.status === "Terlambat").length],
    ["Izin", state.reportRows.filter(r => r.status === "Izin").length],
    ["Sakit", state.reportRows.filter(r => r.status === "Sakit").length],
    ["Alpha", state.reportRows.filter(r => r.status === "Alpha").length]
  ];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data);
  ws["!cols"] = [{ wch: 6 }, { wch: 14 }, { wch: 16 }, { wch: 28 }, { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 28 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(wb, ws, "REKAP_ABSEN");
  const ws2 = XLSX.utils.aoa_to_sheet(summary);
  ws2["!cols"] = [{ wch: 20 }, { wch: 35 }];
  XLSX.utils.book_append_sheet(wb, ws2, "RINGKASAN");
  XLSX.writeFile(wb, `rekap-absen-${$("reportFrom").value}-${$("reportTo").value}.xlsx`);
  toast("Excel dibuat", "File rekap sudah diunduh.", "success");
}

// ---------- CARDS / PDF ----------
function filteredCardStudents() {
  const term = $("cardSearch")?.value.trim().toLowerCase() || "";
  const kelas = $("cardClassFilter")?.value || "";
  return state.students.filter(s => s.active !== false && (!term || String(s.nama || "").toLowerCase().includes(term) || String(s.nisn || "").includes(term)) && (!kelas || s.kelas === kelas));
}

function renderCardSelection() {
  const mount = $("cardStudentList");
  if (!mount) return;
  const previousSelected = new Set($$(".card-student-check:checked").map(c => c.value));
  const students = filteredCardStudents();
  mount.innerHTML = students.length ? students.map(s => `
    <label class="student-check"><input class="card-student-check" type="checkbox" value="${s.id}" ${previousSelected.has(s.id) ? "checked" : ""}><div><strong>${escapeHtml(s.nama)}</strong><span>${escapeHtml(s.kelas)} • ${escapeHtml(s.nisn)}</span></div></label>`).join("") : `<div class="empty-state-mini">Tidak ada siswa.</div>`;
  syncSelectAllCards();
  renderCardPreview();
}

function syncSelectAllCards() {
  const boxes = $$(".card-student-check");
  const checked = boxes.filter(b => b.checked).length;
  $("selectAllCards").checked = boxes.length > 0 && checked === boxes.length;
  $("selectAllCards").indeterminate = checked > 0 && checked < boxes.length;
}

function selectedCardStudents() {
  const ids = new Set($$(".card-student-check:checked").map(c => c.value));
  return state.students.filter(s => ids.has(s.id));
}

function renderCardPreview() {
  const mount = $("cardPreviewMount");
  if (!mount) return;
  const student = selectedCardStudents()[0] || filteredCardStudents()[0] || state.students.find(s => s.active !== false);
  if (!student) {
    mount.innerHTML = `<div class="empty-state-mini">Tambahkan siswa untuk melihat pratinjau kartu.</div>`;
    return;
  }
  const s = state.settings;
  mount.innerHTML = `
    <div class="attendance-card-preview" style="--preview-primary:${escapeHtml(s.primaryColor)};--preview-accent:${escapeHtml(s.accentColor)}">
      <div class="side-band"><span>${escapeHtml(s.cardSideText || s.schoolShort || s.schoolName)}</span></div>
      <div class="preview-content">
        <div class="preview-title-small">KARTU</div><div class="preview-title-big">ABSEN</div>
        <div class="preview-qr" id="previewQr"></div>
        <div class="preview-fields">
          <div class="preview-field"><b>NAMA :</b><strong>${escapeHtml(student.nama)}</strong></div>
          <div class="preview-field"><b>NISN :</b><strong>${escapeHtml(student.nisn)}</strong></div>
          <div class="preview-field"><b>KELAS :</b><strong>${escapeHtml(student.kelas)}</strong></div>
        </div>
        <div class="preview-footer">
          ${s.logoDataUrl ? `<img class="preview-logo" src="${s.logoDataUrl}" alt="Logo">` : `<div class="preview-logo fallback">LOGO</div>`}
          <div class="preview-school-name">${escapeHtml(s.schoolName)}<br>${escapeHtml(s.academicYear || "")}</div>
        </div>
      </div>
    </div>`;
  createQr($("previewQr"), `SMPABSEN:${student.qrToken || student.id}`, 138);
}

function createQr(container, text, size = 256) {
  if (!container || !window.QRCode) return;
  container.innerHTML = "";
  new QRCode(container, {
    text,
    width: size,
    height: size,
    colorDark: "#000000",
    colorLight: "#ffffff",
    correctLevel: QRCode.CorrectLevel.M
  });
}

function qrDataUrl(text, size = 320) {
  return new Promise((resolve, reject) => {
    if (!window.QRCode) return reject(new Error("Library QRCode belum dimuat."));
    const holder = document.createElement("div");
    holder.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;overflow:hidden";
    document.body.appendChild(holder);
    new QRCode(holder, { text, width: size, height: size, colorDark: "#000000", colorLight: "#ffffff", correctLevel: QRCode.CorrectLevel.M });
    requestAnimationFrame(() => {
      const canvas = holder.querySelector("canvas");
      const img = holder.querySelector("img");
      const data = canvas?.toDataURL("image/png") || img?.src;
      holder.remove();
      data ? resolve(data) : reject(new Error("QR gagal dibuat."));
    });
  });
}

function hexToRgb(hex) {
  let h = String(hex || "#34528e").replace("#", "");
  if (h.length === 3) h = h.split("").map(c => c + c).join("");
  const n = parseInt(h, 16);
  return [n >> 16 & 255, n >> 8 & 255, n & 255];
}

function addFittedText(pdf, text, x, y, maxWidth, size, style = "bold") {
  pdf.setFont("helvetica", style);
  pdf.setFontSize(size);
  let t = String(text || "-");
  while (pdf.getTextWidth(t) > maxWidth && t.length > 3) t = t.slice(0, -4) + "...";
  pdf.text(t, x, y);
}

async function drawCardPdf(pdf, student, x, y, w, h) {
  const s = state.settings;
  const primary = hexToRgb(s.primaryColor);
  const accent = hexToRgb(s.accentColor);
  const contentRight = x + w - 11;

  pdf.setFillColor(255, 255, 255);
  pdf.rect(x, y, w, h, "F");
  pdf.setDrawColor(215, 222, 234);
  pdf.setLineWidth(.25);
  pdf.rect(x, y, w, h);

  pdf.setFillColor(...primary);
  pdf.roundedRect(x + w - 10, y, 10, h, 0, 7, "F");
  pdf.setTextColor(255, 255, 255);
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(7.8);
  const side = (s.cardSideText || s.schoolShort || s.schoolName || "SEKOLAH").slice(0, 36);
  pdf.text(side, x + w - 3.1, y + h - 5, { angle: 90, align: "left" });

  pdf.setTextColor(...accent);
  pdf.setFontSize(12);
  pdf.setFont("helvetica", "bold");
  pdf.text("KARTU", x + 5, y + 10);
  pdf.setTextColor(...primary);
  pdf.setFontSize(26);
  pdf.text("ABSEN", x + 4.7, y + 24);

  const qr = await qrDataUrl(`SMPABSEN:${student.qrToken || student.id}`, 360);
  const qrSize = 36;
  const qrX = x + (contentRight - x - qrSize) / 2;
  pdf.addImage(qr, "PNG", qrX, y + 31, qrSize, qrSize, undefined, "FAST");

  const labelX = x + 5;
  const valueX = x + 19;
  let fy = y + 73;
  pdf.setLineWidth(.18);
  const fields = [["NAMA :", student.nama], ["NISN :", student.nisn], ["KELAS :", student.kelas]];
  for (const [label, value] of fields) {
    pdf.setTextColor(...accent);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(6.4);
    pdf.text(label, labelX, fy);
    pdf.setTextColor(...primary);
    addFittedText(pdf, value, valueX, fy, contentRight - valueX - 1, 7.2, "bold");
    pdf.setDrawColor(...primary);
    pdf.setLineDashPattern([.5, .5], 0);
    pdf.line(labelX, fy + 2.2, contentRight - 1, fy + 2.2);
    pdf.setLineDashPattern([], 0);
    fy += 8;
  }

  const footerY = y + 96;
  if (s.logoDataUrl) {
    try { pdf.addImage(s.logoDataUrl, "JPEG", x + 5, footerY - 5.5, 8, 8, undefined, "FAST"); }
    catch { /* fallback below omitted */ }
  } else {
    pdf.setDrawColor(...primary); pdf.circle(x + 9, footerY - 1.5, 4); pdf.setTextColor(...primary); pdf.setFontSize(4.5); pdf.text("LOGO", x + 9, footerY - .4, { align: "center" });
  }
  pdf.setTextColor(...primary);
  addFittedText(pdf, s.schoolName, x + 15, footerY - 2.6, contentRight - (x + 15), 6.2, "bold");
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(4.8);
  pdf.text(String(s.academicYear || ""), x + 15, footerY + .5);
}

async function generateCardsPdf() {
  const students = selectedCardStudents();
  if (!students.length) return toast("Belum ada kartu dipilih", "Centang siswa yang ingin dicetak.", "warning");
  if (!window.jspdf?.jsPDF || !window.QRCode) return toast("Library PDF/QR belum tersedia", "Periksa koneksi internet.", "error");
  const button = $("generateCardsPdfBtn");
  setBusy(button, true, "Membuat PDF...");
  try {
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4", compress: true });
    const cardW = 65, cardH = 105, gapX = 2, gapY = 6;
    const pageW = 210, pageH = 297;
    const totalW = cardW * 3 + gapX * 2;
    const totalH = cardH * 2 + gapY;
    const marginX = (pageW - totalW) / 2;
    const marginY = (pageH - totalH) / 2;

    for (let i = 0; i < students.length; i++) {
      if (i > 0 && i % 6 === 0) pdf.addPage("a4", "portrait");
      const pos = i % 6;
      const col = pos % 3;
      const row = Math.floor(pos / 3);
      const x = marginX + col * (cardW + gapX);
      const y = marginY + row * (cardH + gapY);
      await drawCardPdf(pdf, students[i], x, y, cardW, cardH);
    }
    pdf.save(`kartu-absen-b2-${localDateKey()}.pdf`);
    toast("PDF selesai", `${students.length} kartu, 6 kartu per halaman A4.`, "success", 5000);
  } catch (err) {
    console.error(err);
    toast("Gagal membuat PDF", err.message || "Terjadi kesalahan saat membuat kartu.", "error", 6500);
  } finally { setBusy(button, false); }
}

// ---------- NAVIGATION ----------
function showPage(page) {
  if (!PAGE_META[page]) return;
  if (state.currentPage === "scanner" && page !== "scanner" && state.scannerActive) stopCamera();
  state.currentPage = page;
  $$(".page").forEach(p => p.classList.toggle("active", p.id === `page-${page}`));
  $$(".nav-item").forEach(btn => btn.classList.toggle("active", btn.dataset.page === page));
  $("pageTitle").textContent = PAGE_META[page][0];
  $("pageSubtitle").textContent = PAGE_META[page][1];
  $("sidebar").classList.remove("open");
  if (page === "reports" && !state.reportRows.length) loadReport();
  if (page === "cards") { renderCardSelection(); renderCardPreview(); }
}

// ---------- EVENTS ----------
function bindEvents() {
  $("loginForm").addEventListener("submit", handleLogin);
  $("resetPasswordBtn").addEventListener("click", handlePasswordReset);
  $("togglePasswordBtn").addEventListener("click", () => {
    const input = $("loginPassword"); input.type = input.type === "password" ? "text" : "password";
  });
  $("logoutBtn").addEventListener("click", async () => { stopCamera(); await signOut(auth); });
  $("menuBtn").addEventListener("click", () => $("sidebar").classList.toggle("open"));
  $$(".nav-item").forEach(btn => btn.addEventListener("click", () => showPage(btn.dataset.page)));
  $$('[data-go-page]').forEach(btn => btn.addEventListener("click", () => showPage(btn.dataset.goPage)));
  $$('[data-close-modal]').forEach(el => el.addEventListener("click", () => closeModal(el.dataset.closeModal)));

  $("schoolSettingsForm").addEventListener("submit", saveSchoolSettings);
  $("attendanceSettingsForm").addEventListener("submit", saveAttendanceSettings);
  $("logoFileInput").addEventListener("change", e => handleLogoUpload(e.target.files?.[0]));
  $("removeLogoBtn").addEventListener("click", removeLogo);

  $("addStudentBtn").addEventListener("click", () => openStudentEditor());
  $("studentForm").addEventListener("submit", saveStudent);
  $("studentSearch").addEventListener("input", renderStudents);
  $("studentClassFilter").addEventListener("change", renderStudents);
  $("studentActiveFilter").addEventListener("change", renderStudents);
  $("studentsBody").addEventListener("click", e => {
    const edit = e.target.closest("[data-edit-student]");
    const del = e.target.closest("[data-delete-student]");
    if (edit) openStudentEditor(edit.dataset.editStudent);
    if (del) deleteStudent(del.dataset.deleteStudent);
  });
  $("downloadTemplateBtn").addEventListener("click", downloadStudentTemplate);
  $("excelFileInput").addEventListener("change", e => e.target.files?.[0] && parseExcelImport(e.target.files[0]));
  $("confirmImportBtn").addEventListener("click", confirmImport);
  $("exportStudentsBtn").addEventListener("click", exportStudents);

  $$("[data-scan-mode]").forEach(btn => btn.addEventListener("click", () => setScanMode(btn.dataset.scanMode)));
  $("startCameraBtn").addEventListener("click", startCamera);
  $("stopCameraBtn").addEventListener("click", stopCamera);
  $("refreshCameraBtn").addEventListener("click", async () => { try { await refreshCameraList(); toast("Daftar kamera diperbarui", "Pilih kamera jika perangkat memiliki lebih dari satu.", "success"); } catch { toast("Tidak dapat membaca kamera", "Izinkan akses kamera terlebih dahulu.", "warning"); } });
  $("torchBtn").addEventListener("click", toggleTorch);
  $("cameraSelect").addEventListener("change", async () => { if (state.scannerActive) { stopCamera(); await startCamera(); } });

  $("loadReportBtn").addEventListener("click", loadReport);
  $("exportReportBtn").addEventListener("click", exportReportExcel);
  $("manualAttendanceBtn").addEventListener("click", () => openManualAttendanceEditor());
  $("manualAttendanceForm").addEventListener("submit", saveManualAttendance);
  $("manualAttendanceModal").addEventListener("click", e => {
    if (e.target.dataset.closeModal === "manualAttendanceModal") { $("manualStudent").disabled = false; $("manualDate").disabled = false; }
  });
  $("reportBody").addEventListener("click", e => {
    const edit = e.target.closest("[data-edit-attendance]");
    const del = e.target.closest("[data-delete-attendance]");
    if (edit) openManualAttendanceEditor(edit.dataset.editAttendance);
    if (del) deleteAttendance(del.dataset.deleteAttendance);
  });

  $("cardSearch").addEventListener("input", renderCardSelection);
  $("cardClassFilter").addEventListener("change", renderCardSelection);
  $("cardStudentList").addEventListener("change", e => { if (e.target.classList.contains("card-student-check")) { syncSelectAllCards(); renderCardPreview(); } });
  $("selectAllCards").addEventListener("change", e => { $$(".card-student-check").forEach(c => c.checked = e.target.checked); syncSelectAllCards(); renderCardPreview(); });
  $("generateCardsPdfBtn").addEventListener("click", generateCardsPdf);

  document.addEventListener("keydown", e => { if (e.key === "Escape") $$(".modal-root:not(.hidden)").forEach(m => m.classList.add("hidden")); });
  window.addEventListener("beforeunload", stopCamera);
}

function initDateControls() {
  $("todayChip").textContent = new Intl.DateTimeFormat("id-ID", { weekday: "long", day: "2-digit", month: "long", year: "numeric" }).format(new Date());
  $("reportFrom").value = monthStartKey();
  $("reportTo").value = localDateKey();
  $("manualDate").value = localDateKey();
}

function init() {
  bindEvents();
  initDateControls();
  validateLibraries();
  if (!firebaseConfigured) {
    $("configScreen").classList.remove("hidden");
    $("loginScreen").classList.add("hidden");
    return;
  }
  onAuthStateChanged(auth, async user => {
    if (user) await bootstrapSignedIn(user);
    else {
      state.user = null;
      stopCamera();
      $("appShell").classList.add("hidden");
      $("loginScreen").classList.remove("hidden");
      $("configScreen").classList.add("hidden");
    }
  });
}

init();
