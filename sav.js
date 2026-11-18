/* Pembaca file SPSS (.sav / .zsav) di browser — tanpa server.
 * Mendukung: tanpa kompresi, kompresi bytecode, kompresi zlib (.zsav),
 * label variabel, label nilai, nama variabel panjang, string sangat panjang,
 * nilai missing (user-missing → kosong), format tanggal SPSS → "YYYY-MM-DD".
 * Hasil: { headers:[nama], labels:[label variabel], rows:[[...]], valueLabels:[{kode:label}|null], encoding, ncases }
 */
(function (root) {
  const SYSMIS_HI = 0xFFEFFFFF, SYSMIS_LO = 0xFFFFFFFF;
  const SPSS_EPOCH_SEC = 12219379200; // 1582-10-14 → 1970-01-01
  const DATE_FMT = new Set([20, 22, 23, 24, 38, 39, 41]); // DATE, DATETIME, ADATE, JDATE, EDATE, SDATE, YMDHMS
  const ENC_BY_CODEPAGE = { 65001: 'utf-8', 1252: 'windows-1252', 1250: 'windows-1250', 1251: 'windows-1251', 28591: 'iso-8859-1', 20127: 'utf-8', 2: 'windows-1252', 3: 'windows-1252' };

  async function inflate(bytes) {
    if (typeof DecompressionStream === 'undefined') throw new Error('Browser tidak mendukung file .zsav (SPSS terkompresi zlib). Simpan ulang di SPSS tanpa kompresi zlib.');
    const ds = new DecompressionStream('deflate');
    const buf = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer();
    return new Uint8Array(buf);
  }

  async function read(arrayBuffer) {
    const u8 = new Uint8Array(arrayBuffer);
    const dv = new DataView(arrayBuffer);
    const magic = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
    if (magic !== '$FL2' && magic !== '$FL3') throw new Error('Bukan file SPSS .sav yang valid');
    let le = true;
    const lay = dv.getInt32(64, true);
    if (lay !== 2 && lay !== 3) le = false;
    const i32 = o => dv.getInt32(o, le);
    const f64 = o => dv.getFloat64(o, le);
    const isSysmis = o => le ? (dv.getUint32(o + 4, true) === SYSMIS_HI && dv.getUint32(o, true) === SYSMIS_LO)
                             : (dv.getUint32(o, false) === SYSMIS_HI && dv.getUint32(o + 4, false) === SYSMIS_LO);

    const compression = i32(72);
    let ncases = i32(80);
    const bias = f64(84);
    let pos = 176;

    const slots = [];      // tiap slot 8 byte: {var, type, ...}
    const vars = [];       // variabel nyata (bukan lanjutan)
    let pendingVL = null, enc = null, codepage = null;
    const longNames = {}, veryLong = {}, vlRecords = [];

    const rawStr = (o, n) => u8.subarray(o, o + n);
    const ascii = b => { let s = ''; for (const c of b) s += String.fromCharCode(c); return s; };

    for (;;) {
      const rt = i32(pos); pos += 4;
      if (rt === 2) {
        const type = i32(pos), hasLabel = i32(pos + 4), nMiss = i32(pos + 8), print = i32(pos + 12);
        const name = ascii(rawStr(pos + 20, 8)).trim();
        pos += 28;
        let labelBytes = null;
        if (hasLabel) { const n = i32(pos); pos += 4; labelBytes = rawStr(pos, n); pos += Math.ceil(n / 4) * 4; }
        const miss = [];
        for (let k = 0; k < Math.abs(nMiss); k++) { miss.push(pos); pos += 8; }
        if (type === -1) { slots.push({ cont: true, v: vars[vars.length - 1] }); continue; }
        const v = { short: name, name, type, labelBytes, nMiss, missOfs: miss, fmt: (print >> 16) & 0xff, slot: slots.length, nslots: 1, valueLabels: null };
        if (type === 0 && nMiss) {
          const vals = miss.map(o => f64(o));
          v.missing = nMiss > 0 ? { list: vals } : { lo: vals[0], hi: vals[1], list: nMiss === -3 ? [vals[2]] : [] };
        }
        vars.push(v); slots.push({ v });
      } else if (rt === 3) {
        const n = i32(pos); pos += 4;
        const items = [];
        for (let k = 0; k < n; k++) {
          const vOfs = pos; pos += 8;
          const len = u8[pos]; const lb = rawStr(pos + 1, len);
          pos += Math.ceil((len + 1) / 8) * 8;
          items.push({ vOfs, lb });
        }
        pendingVL = items;
      } else if (rt === 4) {
        const n = i32(pos); pos += 4;
        const idx = []; for (let k = 0; k < n; k++) { idx.push(i32(pos)); pos += 4; }
        if (pendingVL) vlRecords.push({ items: pendingVL, idx });
        pendingVL = null;
      } else if (rt === 6) {
        const n = i32(pos); pos += 4 + n * 80;
      } else if (rt === 7) {
        const sub = i32(pos), size = i32(pos + 4), count = i32(pos + 8);
        pos += 12; const data = rawStr(pos, size * count); pos += size * count;
        if (sub === 3 && size === 4 && count >= 8) codepage = new DataView(data.buffer, data.byteOffset, data.byteLength).getInt32(28, le);
        else if (sub === 20) enc = ascii(data).trim();
        else if (sub === 13) longNames.raw = data;
        else if (sub === 14) veryLong.raw = data;
      } else if (rt === 999) { pos += 4; break; }
      else throw new Error('Struktur file SPSS tidak dikenali (record ' + rt + ')');
    }

    // encoding
    let label = (enc || ENC_BY_CODEPAGE[codepage] || 'windows-1252').toLowerCase();
    let dec; try { dec = new TextDecoder(label); } catch (e) { dec = new TextDecoder('windows-1252'); label = 'windows-1252'; }
    const txt = b => dec.decode(b);

    // hitung slot tiap variabel
    vars.forEach(v => { v.nslots = v.type > 0 ? Math.ceil(v.type / 8) : 1; v.label = v.labelBytes ? txt(v.labelBytes) : ''; });

    // nama panjang
    if (longNames.raw) {
      txt(longNames.raw).split('\t').forEach(p => { const i = p.indexOf('='); if (i > 0) { const s = p.slice(0, i), l = p.slice(i + 1); const v = vars.find(x => x.short === s); if (v) v.name = l; } });
    }
    // string sangat panjang (> 255): gabungkan segmen
    if (veryLong.raw) {
      txt(veryLong.raw).split(/[\t\0]+/).forEach(p => {
        const i = p.indexOf('='); if (i <= 0) return;
        const s = p.slice(0, i), width = parseInt(p.slice(i + 1), 10);
        const vi = vars.findIndex(x => x.short === s); if (vi < 0 || !width) return;
        const nseg = Math.ceil(width / 252);
        vars[vi].segments = vars.slice(vi + 1, vi + nseg).map(x => { x.isSegment = true; return x; });
        vars[vi].width = width;
      });
    }
    // label nilai
    for (const rec of vlRecords) {
      const tgt = rec.idx.map(i => slots[i - 1] && slots[i - 1].v).filter(Boolean);
      if (!tgt.length) continue;
      const isNum = tgt[0].type === 0;
      const map = {};
      rec.items.forEach(it => {
        const key = isNum ? String(+f64(it.vOfs).toPrecision(15)) : txt(rawStr(it.vOfs, 8)).replace(/\s+$/, '');
        map[key] = txt(it.lb).trim();
      });
      tgt.forEach(v => v.valueLabels = Object.assign(v.valueLabels || {}, map));
    }

    // ---- data ----
    const nslotsCase = slots.length;
    let dataU8, dataDV, dpos = 0;
    if (compression === 2) {
      // .zsav: zheader → ztrailer → blok zlib
      const zt = Number(dv.getBigInt64(pos + 8, le));
      const nBlocks = i32(zt + 20);
      const parts = []; let total = 0;
      for (let b = 0; b < nBlocks; b++) {
        const e = zt + 24 + b * 24;
        const cOfs = Number(dv.getBigInt64(e + 8, le)), cSize = i32(e + 20);
        const out = await inflate(u8.subarray(cOfs, cOfs + cSize)); parts.push(out); total += out.length;
      }
      dataU8 = new Uint8Array(total); let o = 0; parts.forEach(p => { dataU8.set(p, o); o += p.length; });
    } else {
      dataU8 = u8.subarray(pos);
    }
    dataDV = new DataView(dataU8.buffer, dataU8.byteOffset, dataU8.byteLength);

    // pembaca slot: menghasilkan {kind:'num'|'raw'|'space'|'sysmis'|'eof', ofs}
    const compressed = compression !== 0;
    let cmd = [], ci = 8;
    const SPACE = new Uint8Array(8).fill(32);
    const scratch = new Uint8Array(8), scratchDV = new DataView(scratch.buffer);
    function nextSlot() {
      if (!compressed) {
        if (dpos + 8 > dataU8.length) return null;
        const o = dpos; dpos += 8; return { raw: o };
      }
      for (;;) {
        if (ci >= 8) {
          if (dpos + 8 > dataU8.length) return null;
          cmd = dataU8.subarray(dpos, dpos + 8); dpos += 8; ci = 0;
        }
        const c = cmd[ci++];
        if (c === 0) continue;
        if (c === 252) return null;
        if (c === 253) { if (dpos + 8 > dataU8.length) return null; const o = dpos; dpos += 8; return { raw: o }; }
        if (c === 254) return { space: true };
        if (c === 255) return { sysmis: true };
        return { num: c - bias };
      }
    }
    const slotBytes = s => s.raw !== undefined ? dataU8.subarray(s.raw, s.raw + 8) : (s.space ? SPACE : null);
    const slotNum = s => {
      if (s.sysmis) return null;
      if (s.num !== undefined) return s.num;
      if (s.raw !== undefined) {
        const o = s.raw;
        const hi = le ? dataDV.getUint32(o + 4, true) : dataDV.getUint32(o, false);
        const lo = le ? dataDV.getUint32(o, true) : dataDV.getUint32(o + 4, false);
        if (hi === SYSMIS_HI && lo === SYSMIS_LO) return null;
        return dataDV.getFloat64(o, le);
      }
      return null;
    };

    const outVars = vars.filter(v => !v.isSegment);
    const rows = [];
    const maxCases = ncases > 0 ? ncases : Infinity;
    const strBuf = new Uint8Array(Math.max(8, nslotsCase * 8));
    outer:
    while (rows.length < maxCases) {
      const vals = new Array(vars.length);
      for (let vi = 0; vi < vars.length; vi++) {
        const v = vars[vi];
        if (v.type === 0) {
          const s = nextSlot(); if (!s) break outer;
          vals[vi] = slotNum(s);
        } else {
          let n = 0;
          for (let k = 0; k < v.nslots; k++) {
            const s = nextSlot(); if (!s) break outer;
            const b = slotBytes(s); if (b) strBuf.set(b, n); else strBuf.fill(32, n, n + 8);
            n += 8;
          }
          vals[vi] = strBuf.slice(0, Math.min(n, v.type));
        }
      }
      // susun baris keluaran
      const row = [];
      for (let vi = 0; vi < vars.length; vi++) {
        const v = vars[vi]; if (v.isSegment) continue;
        let x = vals[vi];
        if (v.type > 0) {
          if (v.segments) {
            // gabungkan per byte (bukan per karakter) agar huruf UTF-8 tidak terpotong
            const parts = [x];
            v.segments.forEach((sg, j) => { const sv = vals[vars.indexOf(sg)]; parts.push(sv); });
            const tot = parts.reduce((a, p) => a + p.length, 0), all = new Uint8Array(tot); let o = 0;
            parts.forEach(p => { all.set(p, o); o += p.length; }); x = all.subarray(0, Math.min(tot, v.width));
          }
          x = txt(x).replace(/[\s\0]+$/, '');
        } else if (x !== null) {
          if (v.missing && ((v.missing.list && v.missing.list.includes(x)) || (v.missing.lo !== undefined && x >= v.missing.lo && x <= v.missing.hi))) x = null;
          else if (DATE_FMT.has(v.fmt)) {
            const d = new Date((x - SPSS_EPOCH_SEC) * 1000);
            x = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
          }
        }
        row.push(x === null ? '' : x);
      }
      rows.push(row);
    }

    return {
      headers: outVars.map(v => v.name),
      labels: outVars.map(v => v.label),
      valueLabels: outVars.map(v => v.valueLabels),
      isDate: outVars.map(v => v.type === 0 && DATE_FMT.has(v.fmt)),
      rows, encoding: label, ncases: rows.length, compression
    };
  }

  // Ganti kode dengan label nilainya (untuk kolom yang punya label)
  function applyValueLabels(res, cols) {
    const out = res.rows.map(r => r.slice());
    cols.forEach(c => {
      const map = res.valueLabels[c]; if (!map) return;
      out.forEach(r => { const v = r[c]; if (v === '') return; const k = typeof v === 'number' ? String(+v.toPrecision(15)) : String(v); if (map[k] !== undefined) r[c] = map[k]; });
    });
    return out;
  }

  const api = { read, applyValueLabels };
  if (typeof module !== 'undefined') module.exports = api; else root.SavReader = api;
})(this);
