/* Penulis XLSX & CSV "streaming" untuk data besar (ratusan ribu baris).
 * Tidak membuat satu objek per sel, jadi aman dari batas memori/properti browser.
 * Kompresi memakai CompressionStream('deflate-raw') bila tersedia; bila tidak, file disimpan tanpa kompresi (tetap valid).
 */
(function (root) {
  const enc = new TextEncoder();

  // ---------- CRC32 ----------
  const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crcUpdate(crc, u8) { let c = crc ^ 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

  const canDeflate = (() => { try { new CompressionStream('deflate-raw'); return true; } catch (e) { return false; } })();

  // Kompres serangkaian potongan byte; kembalikan {parts, csize, usize, crc}
  async function packEntry(produce) {
    let crc = 0, usize = 0;
    const parts = []; let csize = 0;
    if (canDeflate) {
      const cs = new CompressionStream('deflate-raw');
      const writer = cs.writable.getWriter();
      const reader = cs.readable.getReader();
      const pump = (async () => { for (;;) { const { value, done } = await reader.read(); if (done) break; parts.push(value); csize += value.length; } })();
      await produce(async u8 => { crc = crcUpdate(crc, u8); usize += u8.length; await writer.write(u8); });
      await writer.close(); await pump;
    } else {
      await produce(async u8 => { crc = crcUpdate(crc, u8); usize += u8.length; parts.push(u8); csize += u8.length; });
    }
    return { parts, csize, usize, crc };
  }

  function zipBlob(entries) {
    // entries: [{name, parts, csize, usize, crc}]
    const out = []; const central = []; let offset = 0;
    const method = canDeflate ? 8 : 0;
    const d = new Date();
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    for (const e of entries) {
      const nameB = enc.encode(e.name);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, method, true);
      lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, e.crc, true);
      lh.setUint32(18, e.csize, true); lh.setUint32(22, e.usize, true); lh.setUint16(26, nameB.length, true); lh.setUint16(28, 0, true);
      out.push(lh.buffer, nameB, ...e.parts);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, method, true);
      ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, e.crc, true); ch.setUint32(20, e.csize, true); ch.setUint32(24, e.usize, true);
      ch.setUint16(28, nameB.length, true); ch.setUint32(42, offset, true);
      central.push(ch.buffer, nameB);
      offset += 30 + nameB.length + e.csize;
    }
    const cdSize = central.reduce((a, b) => a + (b.byteLength || b.length), 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob([...out, ...central, end.buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  function colName(i) { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
  const xesc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

  function cellXml(v, ref, style) {
    if (v === null || v === undefined || v === '') return '';
    const s = style ? ' s="' + style + '"' : '';
    if (typeof v === 'number') return isFinite(v) ? '<c r="' + ref + '"' + s + '><v>' + v + '</v></c>' : '';
    let t = String(v); if (t.length > 32767) t = t.slice(0, 32767);
    return '<c r="' + ref + '"' + s + ' t="inlineStr"><is><t xml:space="preserve">' + xesc(t) + '</t></is></c>';
  }

  /**
   * sheets: [{ name, header: [..], rowCount, getRow(i) => [..] }]
   * onProgress(fraction)
   */
  async function writeXlsx(sheets, onProgress) {
    const entries = [];
    const add = async (name, str) => entries.push(Object.assign({ name }, await packEntry(async w => { await w(enc.encode(str)); })));
    const totalRows = sheets.reduce((a, s) => a + s.rowCount, 0) || 1; let doneRows = 0;

    await add('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' + sheets.map((s, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('') + '</Types>');
    await add('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
    await add('xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + sheets.map((s, i) => '<sheet name="' + xesc(s.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join('') + '</sheets></workbook>');
    await add('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + sheets.map((s, i) => '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join('') + '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
    await add('xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>');

    for (let si = 0; si < sheets.length; si++) {
      const sh = sheets[si];
      const cols = sh.header.map((_, i) => colName(i));
      const e = await packEntry(async write => {
        await write(enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>'));
        await write(enc.encode('<row r="1">' + sh.header.map((h, c) => cellXml(h, cols[c] + '1', 1)).join('') + '</row>'));
        const CH = 2000;
        for (let i = 0; i < sh.rowCount; i += CH) {
          let buf = '';
          const end = Math.min(sh.rowCount, i + CH);
          for (let r = i; r < end; r++) {
            const row = sh.getRow(r), rn = r + 2;
            buf += '<row r="' + rn + '">';
            for (let c = 0; c < row.length; c++) buf += cellXml(row[c], cols[c] + rn, 0);
            buf += '</row>';
          }
          await write(enc.encode(buf));
          doneRows += end - i;
          if (onProgress) { onProgress(doneRows / totalRows); await new Promise(r => setTimeout(r, 0)); }
        }
        await write(enc.encode('</sheetData></worksheet>'));
      });
      entries.push(Object.assign({ name: 'xl/worksheets/sheet' + (si + 1) + '.xml' }, e));
    }
    return zipBlob(entries);
  }

  async function writeCsv(header, rowCount, getRow, onProgress, sep) {
    sep = sep || ',';
    const q = v => { if (v === null || v === undefined) return ''; const s = String(v); return /[",\n\r;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const parts = ['﻿' + header.map(q).join(sep) + '\r\n'];
    const CH = 5000;
    for (let i = 0; i < rowCount; i += CH) {
      let buf = ''; const end = Math.min(rowCount, i + CH);
      for (let r = i; r < end; r++) buf += getRow(r).map(q).join(sep) + '\r\n';
      parts.push(buf);
      if (onProgress) { onProgress(end / rowCount); await new Promise(r => setTimeout(r, 0)); }
    }
    return new Blob(parts, { type: 'text/csv;charset=utf-8' });
  }

  const api = { writeXlsx, writeCsv, canDeflate };
  if (typeof module !== 'undefined') module.exports = api; else root.XlsxW = api;
})(this);
