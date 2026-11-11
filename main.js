'use strict';
// Protokoll-EL – Electron-Hauptprozess: Fenster, Dateizugriff, PDF-/HTML-Export, KiCad-Import.

const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

const FILE_EXT = 'protokoll';
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg'];
const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml',
};

let win = null;
let dirty = false;

const userFile = (...p) => path.join(app.getPath('userData'), ...p);
const templateDir = () => userFile('vorlagen');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function safeName(name) {
  return String(name || 'Protokoll').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().slice(0, 80) || 'Protokoll';
}

function fileToDataUrl(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  const mime = MIME[ext];
  if (!mime) return null;
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
}

// ---------------------------------------------------------------- Fenster

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 980,
    minHeight: 600,
    title: 'Protokoll-EL',
    backgroundColor: '#f3f4f6',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  try { win.webContents.session.setSpellCheckerLanguages(['de-DE', 'en-US']); } catch { /* optional */ }
  win.loadFile(path.join(__dirname, 'src', 'index.html'));

  // Externe Links nie im App-Fenster öffnen.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault();
  });

  win.on('close', (e) => {
    if (!dirty) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Abbrechen', 'Ohne Speichern beenden'],
      defaultId: 0,
      cancelId: 0,
      title: 'Ungespeicherte Änderungen',
      message: 'Das Protokoll enthält ungespeicherte Änderungen.',
      detail: 'Wenn du jetzt beendest, gehen diese Änderungen verloren.',
    });
    if (choice === 0) e.preventDefault();
  });
  win.on('closed', () => { win = null; });
}

function fileFromArgv(argv) {
  return argv.slice(1).find((a) => a.toLowerCase().endsWith('.' + FILE_EXT) && fs.existsSync(a)) || null;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}

// ---------------------------------------------------------------- Profil & eigene Vorlagen

ipcMain.handle('profile:get', () => readJson(userFile('profil.json'), {}));
ipcMain.handle('profile:set', (_e, profile) => {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(userFile('profil.json'), JSON.stringify(profile, null, 2));
  return true;
});

ipcMain.handle('templates:list', () => {
  let files = [];
  try { files = fs.readdirSync(templateDir()).filter((f) => f.endsWith('.json')); } catch { /* none yet */ }
  return files
    .map((f) => {
      const t = readJson(path.join(templateDir(), f), null);
      return t && t.doc ? { file: f, name: t.name || f, doc: t.doc } : null;
    })
    .filter(Boolean);
});
ipcMain.handle('templates:save', (_e, name, doc) => {
  fs.mkdirSync(templateDir(), { recursive: true });
  const file = safeName(name) + '.json';
  fs.writeFileSync(path.join(templateDir(), file), JSON.stringify({ name, doc }));
  return file;
});
ipcMain.handle('templates:delete', (_e, file) => {
  fs.rmSync(path.join(templateDir(), path.basename(file)), { force: true });
  return true;
});

// ---------------------------------------------------------------- Öffnen / Speichern

ipcMain.handle('dirty:set', (_e, value) => { dirty = !!value; });
ipcMain.handle('app:startFile', () => {
  const file = fileFromArgv(process.argv);
  return file ? loadDocFile(file) : null;
});

function loadDocFile(file) {
  const data = readJson(file, null);
  if (!data || data.format !== 'protokoll-el' || !data.doc) {
    return { error: 'Die Datei ist kein gültiges Protokoll-EL-Dokument.' };
  }
  return { path: file, doc: data.doc };
}

ipcMain.handle('doc:open', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Protokoll öffnen',
    properties: ['openFile'],
    filters: [{ name: 'Protokoll-EL', extensions: [FILE_EXT] }],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  return loadDocFile(r.filePaths[0]);
});

ipcMain.handle('doc:save', async (_e, doc, currentPath, suggestedName) => {
  let file = currentPath;
  if (!file) {
    const r = await dialog.showSaveDialog(win, {
      title: 'Protokoll speichern',
      defaultPath: safeName(suggestedName) + '.' + FILE_EXT,
      filters: [{ name: 'Protokoll-EL', extensions: [FILE_EXT] }],
    });
    if (r.canceled || !r.filePath) return null;
    file = r.filePath;
  }
  // Erst in eine temporäre Datei schreiben, damit ein Absturz die alte Datei nicht zerstört.
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ format: 'protokoll-el', version: 1, doc }));
  fs.renameSync(tmp, file);
  return file;
});

// ---------------------------------------------------------------- Bilder / CSV wählen

ipcMain.handle('file:pickImages', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Bilder einfügen',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Bilder', extensions: IMAGE_EXT }],
  });
  if (r.canceled) return [];
  return r.filePaths
    .map((f) => ({ name: path.basename(f, path.extname(f)), dataUrl: fileToDataUrl(f) }))
    .filter((i) => i.dataUrl);
});

ipcMain.handle('file:pickText', async (_e, title, extensions) => {
  const r = await dialog.showOpenDialog(win, {
    title,
    properties: ['openFile'],
    filters: [{ name: title, extensions }, { name: 'Alle Dateien', extensions: ['*'] }],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const buf = fs.readFileSync(r.filePaths[0]);
  if (buf.length > 5 * 1024 * 1024) return { error: 'Die Datei ist zu groß (max. 5 MB).' };
  return { name: path.basename(r.filePaths[0]), text: buf.toString('utf8').replace(/^﻿/, '') };
});

// ---------------------------------------------------------------- Export

function katexCss() {
  // KaTeX-CSS mit eingebetteten Schriften, damit exportierte Dateien eigenständig sind.
  const dist = path.join(__dirname, 'node_modules', 'katex', 'dist');
  let css = fs.readFileSync(path.join(dist, 'katex.min.css'), 'utf8');
  css = css.replace(/src:url\((fonts\/[^)]+\.woff2)\)[^;}]*/g, (_m, rel) => {
    const data = fs.readFileSync(path.join(dist, rel)).toString('base64');
    return `src:url(data:font/woff2;base64,${data}) format("woff2")`;
  });
  return css;
}

function buildHtml(bodyHtml, title) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const docCss = fs.readFileSync(path.join(__dirname, 'src', 'styles', 'document.css'), 'utf8');
  const mathCss = bodyHtml.includes('class="katex') ? katexCss() : '';
  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${mathCss}</style>
<style>${docCss}</style>
<style>
  body { margin: 0; background: #fff; }
  @media screen { body { background: #e5e7eb; } .doc { max-width: 170mm; margin: 10mm auto; padding: 20mm; background: #fff; box-shadow: 0 1px 8px rgba(0,0,0,.25); } }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>
`;
}

ipcMain.handle('export:html', async (_e, bodyHtml, fileName, title) => {
  const r = await dialog.showSaveDialog(win, {
    title: 'Als HTML exportieren',
    defaultPath: safeName(fileName) + '.html',
    filters: [{ name: 'HTML', extensions: ['html'] }],
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, buildHtml(bodyHtml, title));
  return r.filePath;
});

ipcMain.handle('export:pdf', async (_e, bodyHtml, fileName, title, headerText) => {
  const r = await dialog.showSaveDialog(win, {
    title: 'Als PDF exportieren',
    defaultPath: safeName(fileName) + '.pdf',
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (r.canceled || !r.filePath) return null;

  const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'protokoll-el-'));
  const tmpHtml = path.join(tmpDir, 'export.html');
  fs.writeFileSync(tmpHtml, buildHtml(bodyHtml, title));

  const printWin = new BrowserWindow({
    show: false,
    webPreferences: { javascript: false, contextIsolation: true, nodeIntegration: false },
  });
  try {
    await printWin.loadFile(tmpHtml);
    const bar = 'width:100%;font-family:Arial,Helvetica,sans-serif;font-size:8pt;color:#555;padding:0 20mm;display:flex;justify-content:space-between;';
    const pdf = await printWin.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      margins: { top: 0.87, bottom: 0.87, left: 0.79, right: 0.79 }, // Zoll (ca. 22 mm / 20 mm)
      headerTemplate: `<div style="${bar}"><span>${esc(headerText)}</span><span>${esc(title)}</span></div>`,
      footerTemplate: `<div style="${bar}"><span></span><span>Seite <span class="pageNumber"></span> von <span class="totalPages"></span></span></div>`,
    });
    fs.writeFileSync(r.filePath, pdf);
  } finally {
    printWin.destroy();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  return r.filePath;
});

ipcMain.handle('shell:showFile', (_e, file) => { shell.showItemInFolder(file); });

// ---------------------------------------------------------------- KiCad-Import

function findKicadCli() {
  const exe = process.platform === 'win32' ? 'kicad-cli.exe' : 'kicad-cli';
  const candidates = [];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, exe));
  }
  if (process.platform === 'win32') {
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')]) {
      if (!base) continue;
      const root = path.join(base, 'KiCad');
      let versions = [];
      try { versions = fs.readdirSync(root).sort().reverse(); } catch { /* not installed here */ }
      for (const v of versions) candidates.push(path.join(root, v, 'bin', exe));
    }
  } else {
    candidates.push('/usr/bin/kicad-cli', '/usr/local/bin/kicad-cli', '/snap/bin/kicad.kicad-cli');
  }
  return candidates.find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } }) || null;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 180000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || stdout || err.message).toString().trim().split('\n').slice(-3).join(' ')));
      else resolve(String(stdout));
    });
  });
}

const fmtMm = (v) => (typeof v === 'number' && v > 0 ? String(Math.round(v * 1000) / 1000).replace('.', ',') + ' mm' : '');
const xmlText = (s) => String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// Stückliste aus dem XML-Netzlisten-Export (funktioniert ab KiCad 7): gleiche Bauteile werden zusammengefasst.
function bomFromXml(xml) {
  const groups = new Map();
  for (const m of xml.matchAll(/<comp ref="([^"]+)">([\s\S]*?)<\/comp>/g)) {
    const ref = xmlText(m[1]);
    if (ref.startsWith('#')) continue;
    const value = xmlText(/<value>([\s\S]*?)<\/value>/.exec(m[2])?.[1] || '');
    const footprint = xmlText(/<footprint>([\s\S]*?)<\/footprint>/.exec(m[2])?.[1] || '').replace(/^[^:]*:/, '');
    const key = value + '\u0000' + footprint;
    if (!groups.has(key)) groups.set(key, { refs: [], value, footprint });
    groups.get(key).refs.push(ref);
  }
  const natural = new Intl.Collator('de', { numeric: true }).compare;
  const list = [...groups.values()];
  list.forEach((g) => g.refs.sort(natural));
  list.sort((a, b) => natural(a.refs[0], b.refs[0]));
  if (!list.length) return null;
  return [['Pos.', 'Referenz', 'Wert', 'Footprint', 'Anzahl'],
    ...list.map((g, i) => [String(i + 1), g.refs.join(', '), g.value, g.footprint, String(g.refs.length)])];
}

// Kenndaten der Platine direkt aus den Projektdateien lesen (ohne kicad-cli).
function boardFacts(proFile, pcbFile) {
  const rows = [];
  let pcb = '';
  try { pcb = fs.readFileSync(pcbFile, 'utf8'); } catch { /* no board */ }
  if (pcb) {
    const copper = new Set([...pcb.slice(0, 20000).matchAll(/\(\d+\s+"?([\w.]+\.Cu)"?\s+(?:signal|power|mixed|jumper)/g)].map((m) => m[1]));
    if (copper.size) rows.push(['Kupferlagen', String(copper.size)]);

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    // Nur Elemente der obersten Ebene (2 Leerzeichen bzw. 1 Tab eingerückt) – nicht die Grafik innerhalb von Pads/Footprints.
    for (const m of pcb.matchAll(/\n(?: {2}|\t)\((gr_line|gr_rect|gr_arc|gr_poly|gr_circle)\s([\s\S]*?)\(layer\s+"?([\w.]+)"?\)/g)) {
      if (m[3] !== 'Edge.Cuts' || /\((gr_|fp_|footprint|pad)\b/.test(m[2])) continue;
      const pts = [...m[2].matchAll(/\((start|end|mid|center|xy)\s+(-?[\d.]+)\s+(-?[\d.]+)/g)].map((q) => [q[1], Number(q[2]), Number(q[3])]);
      if (m[1] === 'gr_circle' && pts.length >= 2) {
        const [, cx, cy] = pts[0];
        const r = Math.hypot(pts[1][1] - cx, pts[1][2] - cy);
        pts.length = 0;
        pts.push(['', cx - r, cy - r], ['', cx + r, cy + r]);
      }
      for (const [, x, y] of pts) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
    if (maxX > minX && maxY > minY) rows.push(['Platinengröße (ca.)', `${fmtMm(maxX - minX).replace(' mm', '')} × ${fmtMm(maxY - minY)}`]);
  }
  const pro = readJson(proFile, null);
  const cls = pro?.net_settings?.classes?.[0] || {};
  const rules = pro?.board?.design_settings?.rules || {};
  const add = (label, value) => { if (fmtMm(value)) rows.push([label, fmtMm(value)]); };
  add('Leiterbahnbreite (Standard)', cls.track_width);
  add('Abstand (Standard)', cls.clearance);
  if (fmtMm(cls.via_diameter)) rows.push(['Via (Durchmesser / Bohrung)', `${fmtMm(cls.via_diameter)} / ${fmtMm(cls.via_drill) || '–'}`]);
  add('Min. Leiterbahnbreite', rules.min_track_width);
  add('Min. Abstand', rules.min_clearance);
  add('Min. Bohrdurchmesser', rules.min_through_hole_diameter);
  return rows.length ? [['Regel', 'Wert'], ...rows] : null;
}

// ERC-/DRC-Bericht (JSON, ab KiCad 8) in Zahlen und Tabellenzeilen umwandeln.
function summarizeReport(kind, report) {
  const groups = kind === 'ERC'
    ? [['', (report.sheets || []).flatMap((s) => s.violations || [])]]
    : [['', report.violations || []], ['Nicht verbunden', report.unconnected_items || []], ['Schaltplan-Abgleich', report.schematic_parity || []]];
  const out = { kind, errors: 0, warnings: 0, unconnected: (report.unconnected_items || []).length, rows: [] };
  for (const [label, list] of groups) {
    for (const v of list) {
      const error = v.severity === 'error';
      if (error) out.errors++; else out.warnings++;
      const items = (v.items || []).map((i) => i.description).filter(Boolean).slice(0, 2).join('; ');
      out.rows.push([kind, error ? 'Fehler' : 'Warnung', [label, v.description || v.type].filter(Boolean).join(': '), items]);
    }
  }
  return out;
}

ipcMain.handle('kicad:import', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'KiCad-Projekt wählen',
    properties: ['openFile'],
    filters: [{ name: 'KiCad', extensions: ['kicad_pro', 'kicad_sch', 'kicad_pcb'] }],
  });
  if (r.canceled || !r.filePaths[0]) return null;

  const chosen = r.filePaths[0];
  const base = chosen.replace(/\.kicad_(pro|sch|pcb)$/i, '');
  const project = path.basename(base);
  const sch = base + '.kicad_sch';
  const pcb = base + '.kicad_pcb';
  const result = { project, version: '', images: [], bom: null, rules: null, checks: [], messages: [] };

  try { result.rules = boardFacts(base + '.kicad_pro', pcb); } catch { /* optional */ }

  const cli = findKicadCli();
  if (!cli) {
    result.noCli = true;
    return result;
  }
  try { result.version = (await run(cli, ['version'])).trim().split(/\s+/)[0]; } catch { /* unknown version */ }
  const major = parseInt(result.version, 10) || 0;
  const note = (what, e) => result.messages.push(`${what}: ${e.message}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'protokoll-el-kicad-'));
  try {
    if (fs.existsSync(sch)) {
      try {
        const out = path.join(tmp, 'sch');
        fs.mkdirSync(out);
        await run(cli, ['sch', 'export', 'svg', '--output', out, sch]);
        const files = fs.readdirSync(out).filter((f) => f.endsWith('.svg'));
        // Hauptblatt zuerst, dann die Unterblätter.
        files.sort((a, b) => (a === project + '.svg' ? -1 : b === project + '.svg' ? 1 : a.localeCompare(b)));
        for (const f of files) {
          const name = path.basename(f, '.svg');
          const sheet = name.startsWith(project + '-') ? name.slice(project.length + 1) : '';
          result.images.push({
            dataUrl: fileToDataUrl(path.join(out, f)),
            caption: sheet ? `Schaltplan „${project}“ – Blatt „${sheet}“` : `Schaltplan „${project}“`,
            section: 'schaltplan',
          });
        }
      } catch (e) { note('Schaltplan konnte nicht geplottet werden', e); }

      try {
        const out = path.join(tmp, 'bom.xml');
        await run(cli, ['sch', 'export', 'python-bom', '--output', out, sch]);
        result.bom = bomFromXml(fs.readFileSync(out, 'utf8'));
      } catch (e) { note('Stückliste konnte nicht erzeugt werden', e); }

      if (major >= 8) {
        try {
          const out = path.join(tmp, 'erc.json');
          // kicad-cli meldet gefundene Verstöße je nach Version über den Rückgabewert – der Bericht zählt.
          try { await run(cli, ['sch', 'erc', '--output', out, '--format', 'json', '--severity-all', sch]); } catch (e) { if (!fs.existsSync(out)) throw e; }
          result.checks.push(summarizeReport('ERC', readJson(out, {})));
        } catch (e) { note('ERC konnte nicht ausgeführt werden', e); }
      }
    } else {
      result.messages.push('Keine Schaltplandatei (.kicad_sch) neben der gewählten Datei gefunden.');
    }

    if (fs.existsSync(pcb)) {
      const views = [
        { layers: 'F.Cu,F.SilkS,Edge.Cuts', extra: [], caption: `Layout „${project}“ – Oberseite` },
        { layers: 'B.Cu,B.SilkS,Edge.Cuts', extra: ['--mirror'], caption: `Layout „${project}“ – Unterseite (gespiegelt, von unten gesehen)` },
      ];
      for (const [i, v] of views.entries()) {
        const out = path.join(tmp, `pcb${i}.svg`);
        try {
          try {
            await run(cli, ['pcb', 'export', 'svg', '--output', out, '--layers', v.layers, ...v.extra,
              '--page-size-mode', '2', '--exclude-drawing-sheet', pcb]);
          } catch {
            await run(cli, ['pcb', 'export', 'svg', '--output', out, '--layers', v.layers, pcb]);
          }
          result.images.push({ dataUrl: fileToDataUrl(out), caption: v.caption, section: 'layout', width: 80 });
        } catch (e) { note('Layout konnte nicht geplottet werden', e); }
      }

      if (major >= 9) {
        for (const [side, label] of [['top', 'Oberseite'], ['bottom', 'Unterseite']]) {
          const out = path.join(tmp, `3d-${side}.png`);
          try {
            await run(cli, ['pcb', 'render', '--output', out, '--side', side, '--width', '1600', '--height', '1100', pcb]);
            result.images.push({ dataUrl: fileToDataUrl(out), caption: `3D-Ansicht „${project}“ – ${label}`, section: 'layout', width: 70 });
          } catch (e) { note('3D-Ansicht konnte nicht erzeugt werden', e); }
        }
      }

      if (major >= 8) {
        try {
          const out = path.join(tmp, 'drc.json');
          try { await run(cli, ['pcb', 'drc', '--output', out, '--format', 'json', '--severity-all', '--schematic-parity', pcb]); } catch (e) {
            if (!fs.existsSync(out)) await run(cli, ['pcb', 'drc', '--output', out, '--format', 'json', pcb]).catch((e2) => { if (!fs.existsSync(out)) throw e2; });
          }
          result.checks.push(summarizeReport('DRC', readJson(out, {})));
        } catch (e) { note('DRC konnte nicht ausgeführt werden', e); }
      }
    } else {
      result.messages.push('Keine Leiterplattendatei (.kicad_pcb) neben der gewählten Datei gefunden.');
    }

    if (major && major < 8) result.messages.push(`KiCad ${result.version} gefunden: ERC/DRC-Berichte gibt es automatisch erst ab KiCad 8, die 3D-Ansicht ab KiCad 9.`);
    else if (major === 8) result.messages.push(`KiCad ${result.version} gefunden: Die 3D-Ansicht gibt es automatisch erst ab KiCad 9.`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return result;
});
