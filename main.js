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
    execFile(cmd, args, { timeout: 120000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || stdout || err.message).toString().trim().split('\n').slice(-3).join(' ')));
      else resolve(stdout);
    });
  });
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
  const result = { project, images: [], bom: null, messages: [] };

  const cli = findKicadCli();
  if (!cli) {
    result.noCli = true;
    return result;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'protokoll-el-kicad-'));
  try {
    if (fs.existsSync(sch)) {
      try {
        const out = path.join(tmp, 'sch');
        fs.mkdirSync(out);
        await run(cli, ['sch', 'export', 'svg', '--output', out, sch]);
        for (const f of fs.readdirSync(out).filter((f) => f.endsWith('.svg')).sort()) {
          const name = path.basename(f, '.svg');
          result.images.push({
            dataUrl: fileToDataUrl(path.join(out, f)),
            caption: name === project ? `Schaltplan „${project}“` : `Schaltplan „${name}“`,
            section: 'schaltplan',
          });
        }
      } catch (e) { result.messages.push('Schaltplan konnte nicht exportiert werden: ' + e.message); }

      try {
        const out = path.join(tmp, 'bom.csv');
        await run(cli, ['sch', 'export', 'bom', '--output', out,
          '--fields', 'Reference,Value,Footprint,${QUANTITY}',
          '--labels', 'Referenz,Wert,Footprint,Anzahl',
          '--group-by', 'Value,Footprint', sch]);
        result.bom = fs.readFileSync(out, 'utf8');
      } catch (e) { result.messages.push('Stückliste konnte nicht exportiert werden (benötigt KiCad 8 oder neuer): ' + e.message); }
    } else {
      result.messages.push('Keine Schaltplandatei (.kicad_sch) neben der gewählten Datei gefunden.');
    }

    if (fs.existsSync(pcb)) {
      const views = [
        { layers: 'F.Cu,F.SilkS,Edge.Cuts', caption: `Layout „${project}“ – Oberseite (F.Cu)` },
        { layers: 'B.Cu,B.SilkS,Edge.Cuts', caption: `Layout „${project}“ – Unterseite (B.Cu)` },
      ];
      for (const [i, v] of views.entries()) {
        const out = path.join(tmp, `pcb${i}.svg`);
        try {
          try {
            await run(cli, ['pcb', 'export', 'svg', '--output', out, '--layers', v.layers,
              '--page-size-mode', '2', '--exclude-drawing-sheet', pcb]);
          } catch {
            await run(cli, ['pcb', 'export', 'svg', '--output', out, '--layers', v.layers, pcb]);
          }
          result.images.push({ dataUrl: fileToDataUrl(out), caption: v.caption, section: 'layout' });
        } catch (e) { result.messages.push('Layout konnte nicht exportiert werden: ' + e.message); }
      }
    } else {
      result.messages.push('Keine Leiterplattendatei (.kicad_pcb) neben der gewählten Datei gefunden.');
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return result;
});
