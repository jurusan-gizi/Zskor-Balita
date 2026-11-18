/* Mesin z-score WHO Child Growth Standards 2006 (0–60 bulan)
 * Mengikuti algoritma resmi WHO (igrowup / paket R "anthro"):
 *  - umur dalam hari (bulan × 30,4375, dibulatkan)
 *  - koreksi PB/TB ±0,7 cm bila cara ukur tidak sesuai umur
 *  - BB/PB (< 731 hari) vs BB/TB (≥ 731 hari), interpolasi per 0,1 cm
 *  - rumus terkoreksi untuk z > +3 / < −3 (BB/U, BB/PB-TB, IMT/U)
 *  - flag WHO: BB/U <−6 / >+5, PB-TB/U <−6 / >+6, BB/PB-TB <−5 / >+5, IMT/U <−5 / >+5
 */
(function (root) {
  const LMS = (typeof WHO_LMS !== 'undefined') ? WHO_LMS
    : (typeof require !== 'undefined' ? require('./who-lms.js') : null);

  const DAYS_PER_MONTH = 30.4375;
  const MAX_DAYS = 1856;

  function num(v) {
    if (v === null || v === undefined) return NaN;
    if (typeof v === 'number') return v;
    const s = String(v).trim().replace(',', '.');
    if (s === '') return NaN;
    return Number(s);
  }

  function lmsAge(tab, sex, days) {
    const t = LMS[tab];
    const i = Math.round(days);
    if (i < 0 || i > MAX_DAYS) return null;
    return t.d[sex][i];
  }

  function lmsLen(tab, sex, len) {
    const t = LMS[tab];
    const arr = t.d[sex];
    const lo = t.start, hi = t.start + (arr.length - 1) * 0.1;
    if (len < lo - 1e-9 || len > hi + 1e-9) return null;
    // interpolasi linier antar 0,1 cm (seperti igrowup)
    const x10 = Math.round(len * 1e6) / 1e5; // len*10, stabil terhadap floating point
    const low10 = Math.floor(x10 + 1e-9);
    const iLow = Math.round(low10 - lo * 10);
    const frac = x10 - low10;
    if (frac < 1e-9 || iLow >= arr.length - 1) return arr[Math.min(iLow, arr.length - 1)];
    const a = arr[iLow], b = arr[iLow + 1];
    return [a[0] + frac * (b[0] - a[0]), a[1] + frac * (b[1] - a[1]), a[2] + frac * (b[2] - a[2])];
  }

  function zRaw(y, l, m, s) {
    if (Math.abs(l) < 1e-12) return Math.log(y / m) / s;
    return (Math.pow(y / m, l) - 1) / (s * l);
  }

  function sdAt(l, m, s, k) { return m * Math.pow(1 + l * s * k, 1 / l); }

  // Rumus terkoreksi WHO untuk ekor distribusi (dipakai BB/U, BB/PB-TB, IMT/U)
  function zRestricted(y, lms) {
    const [l, m, s] = lms;
    let z = zRaw(y, l, m, s);
    if (z > 3) {
      const sd3 = sdAt(l, m, s, 3), sd2 = sdAt(l, m, s, 2);
      z = 3 + (y - sd3) / (sd3 - sd2);
    } else if (z < -3) {
      const sd3 = sdAt(l, m, s, -3), sd2 = sdAt(l, m, s, -2);
      z = -3 + (y - sd3) / (sd2 - sd3);
    }
    return z;
  }

  function parseSex(v) {
    if (v === null || v === undefined) return null;
    const s = String(v).trim().toLowerCase();
    if (['1', 'l', 'lk', 'laki', 'laki-laki', 'laki laki', 'm', 'male', 'pria', 'boy'].includes(s)) return '1';
    if (['2', 'p', 'pr', 'perempuan', 'f', 'female', 'wanita', 'girl'].includes(s)) return '2';
    return null;
  }

  function parseMeasure(v) {
    if (v === null || v === undefined) return null;
    const s = String(v).trim().toLowerCase();
    if (['l', 'pb', 'terlentang', 'telentang', 'berbaring', 'recumbent', 'length', '1'].includes(s)) return 'l';
    if (['h', 'tb', 'berdiri', 'standing', 'height', '2'].includes(s)) return 'h';
    return null;
  }

  function parseOedema(v) {
    if (v === null || v === undefined) return false;
    const s = String(v).trim().toLowerCase();
    return ['y', 'ya', 'yes', '1', 'true', 'ada', '+'].includes(s);
  }

  // Tanggal: objek Date, serial Excel, "YYYY-MM-DD", "DD/MM/YYYY", "DD-MM-YYYY"
  function parseDate(v) {
    if (v === null || v === undefined || v === '') return null;
    if (v instanceof Date) {
      if (isNaN(v)) return null;
      // bulatkan ke hari terdekat (antisipasi selisih detik zona waktu dari pembaca Excel)
      const local = v.getTime() - v.getTimezoneOffset() * 60000;
      return Math.round(local / 86400000) * 86400000;
    }
    if (typeof v === 'number') return Math.round((v - 25569) * 86400000); // serial Excel
    const s = String(v).trim();
    let m;
    if ((m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/))) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
    if ((m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})/))) return Date.UTC(+m[3], +m[2] - 1, +m[1]);
    if (/^\d+(\.\d+)?$/.test(s)) return Math.round((Number(s) - 25569) * 86400000);
    return null;
  }

  function r2(x) { return (x === null || !isFinite(x)) ? null : Math.round(x * 100) / 100; }

  /**
   * input: { sex, ageDays?, ageMonths?, dob?, dov?, weight, lenhei, measure?, oedema? }
   * output: { ageDays, ageMonths, clenhei, bmi, waz, haz, whz, baz, fwaz, fhaz, fwhz, fbaz, note }
   */
  function compute(input) {
    const notes = [];
    const sex = parseSex(input.sex);
    if (!sex) notes.push('JK tidak valid');

    let days = NaN;
    if (input.ageDays !== undefined && input.ageDays !== '' && input.ageDays !== null) {
      days = num(input.ageDays);
    } else if (input.dob !== undefined && input.dov !== undefined && input.dob !== '' && input.dov !== '') {
      const a = parseDate(input.dob), b = parseDate(input.dov);
      if (a !== null && b !== null) days = Math.round((b - a) / 86400000);
    }
    if (!isFinite(days) && input.ageMonths !== undefined && input.ageMonths !== '' && input.ageMonths !== null) {
      const mo = num(input.ageMonths);
      if (isFinite(mo)) days = mo * DAYS_PER_MONTH;
    }
    if (isFinite(days)) days = Math.round(days);
    let ageOK = isFinite(days) && days >= 0 && days <= MAX_DAYS;
    if (isFinite(days) && !ageOK) notes.push('umur di luar 0–60 bln');
    if (!isFinite(days)) notes.push('umur kosong/tidak valid');

    const w = num(input.weight);
    let h = num(input.lenhei);
    const meas = parseMeasure(input.measure);
    const oed = parseOedema(input.oedema);

    // koreksi PB/TB
    let clenhei = isFinite(h) ? h : NaN;
    if (isFinite(h) && ageOK && meas) {
      if (days < 731 && meas === 'h') clenhei = h + 0.7;
      else if (days >= 731 && meas === 'l') clenhei = h - 0.7;
    }

    const res = { ageDays: isFinite(days) ? days : null, ageMonths: isFinite(days) ? r2(days / DAYS_PER_MONTH) : null,
      clenhei: isFinite(clenhei) ? Math.round(clenhei * 10) / 10 : null,
      bmi: null, waz: null, haz: null, whz: null, baz: null,
      fwaz: null, fhaz: null, fwhz: null, fbaz: null, note: '' };

    if (sex) {
      // BB/U
      if (ageOK && isFinite(w) && w > 0 && !oed) {
        const p = lmsAge('wfa', sex, days);
        if (p) res.waz = zRestricted(w, p);
      }
      // PB/U atau TB/U
      if (ageOK && isFinite(clenhei) && clenhei > 0) {
        const p = lmsAge('lfa', sex, days);
        if (p) res.haz = zRaw(clenhei, p[0], p[1], p[2]);
      }
      // BB/PB atau BB/TB
      if (isFinite(w) && w > 0 && isFinite(clenhei) && !oed) {
        let tab = null;
        if (ageOK) tab = days < 731 ? 'wfl' : 'wfh';
        else if (!isFinite(days)) tab = meas === 'l' ? 'wfl' : (meas === 'h' ? 'wfh' : null);
        if (tab) {
          const p = lmsLen(tab, sex, clenhei);
          if (p) res.whz = zRestricted(w, p);
          else notes.push(tab === 'wfl' ? 'PB di luar 45–110 cm' : 'TB di luar 65–120 cm');
        }
      }
      // IMT/U
      if (ageOK && isFinite(w) && w > 0 && isFinite(clenhei) && clenhei > 0) {
        const bmi = w / Math.pow(clenhei / 100, 2);
        res.bmi = Math.round(bmi * 100) / 100;
        if (!oed) {
          const p = lmsAge('bfa', sex, days);
          if (p) res.baz = zRestricted(bmi, p);
        }
      }
    }

    res.waz = r2(res.waz); res.haz = r2(res.haz); res.whz = r2(res.whz); res.baz = r2(res.baz);
    if (res.waz !== null) res.fwaz = (res.waz < -6 || res.waz > 5) ? 1 : 0;
    if (res.haz !== null) res.fhaz = (res.haz < -6 || res.haz > 6) ? 1 : 0;
    if (res.whz !== null) res.fwhz = (res.whz < -5 || res.whz > 5) ? 1 : 0;
    if (res.baz !== null) res.fbaz = (res.baz < -5 || res.baz > 5) ? 1 : 0;
    if (oed) notes.push('oedema: BB/U, BB/TB, IMT/U tidak dihitung');
    res.note = notes.join('; ');
    return res;
  }

  // Kategori status gizi (PMK No. 2 Tahun 2020)
  function catWAZ(z) { if (z === null) return ''; if (z < -3) return 'Berat badan sangat kurang'; if (z < -2) return 'Berat badan kurang'; if (z <= 1) return 'Berat badan normal'; return 'Risiko berat badan lebih'; }
  function catHAZ(z) { if (z === null) return ''; if (z < -3) return 'Sangat pendek'; if (z < -2) return 'Pendek'; if (z <= 3) return 'Normal'; return 'Tinggi'; }
  function catWHZ(z) { if (z === null) return ''; if (z < -3) return 'Gizi buruk'; if (z < -2) return 'Gizi kurang'; if (z <= 1) return 'Gizi baik (normal)'; if (z <= 2) return 'Berisiko gizi lebih'; if (z <= 3) return 'Gizi lebih'; return 'Obesitas'; }
  function catBAZ(z) { return catWHZ(z); }

  const api = { compute, catWAZ, catHAZ, catWHZ, catBAZ, parseSex, parseMeasure, parseDate };
  if (typeof module !== 'undefined') module.exports = api; else root.ZScore = api;
})(this);
