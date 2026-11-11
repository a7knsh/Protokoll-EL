'use strict';
// End-to-End-Test: startet die echte App und spielt einen kompletten Protokoll-Ablauf durch.
// Benötigt Playwright (npm i -D playwright) und unter Linux ohne Bildschirm xvfb-run.

const { _electron: electron } = require('playwright');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const out = process.env.TEST_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'protokoll-el-test-'));
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function launch(userData, extraArgs = []) {
  // PROTOKOLL_EXE: optional ein fertig gebautes Programm testen statt der Entwicklungsversion.
  const exe = process.env.PROTOKOLL_EXE;
  const app = await electron.launch({ executablePath: exe || require(path.join(root, 'node_modules', 'electron')), args: [...(exe ? [] : [root]), '--no-sandbox', `--user-data-dir=${userData}`, ...extraArgs] });
  const page = await app.firstWindow();
  page.on('pageerror', (e) => { throw e; });
  page.on('console', (m) => { if (m.type() === 'error') console.error('[renderer]', m.text()); });
  return { app, page };
}

const stubSave = (app, file) => app.evaluate(({ dialog }, f) => {
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: f });
}, file);

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const userData = path.join(out, 'userdata');
  fs.rmSync(userData, { recursive: true, force: true });
  const docFile = path.join(out, 'test.protokoll');
  const pdfFile = path.join(out, 'test.pdf');
  const htmlFile = path.join(out, 'test.html');
  const imgFile = path.join(out, 'bild.png');
  fs.writeFileSync(imgFile, Buffer.from(PNG, 'base64'));

  let { app, page } = await launch(userData);

  // Erster Start: Profil-Dialog, dann Vorlagenauswahl.
  await page.fill('[data-profile="name"]', 'Max Muster');
  await page.fill('[data-profile="klasse"]', '3AHEL');
  await page.fill('[data-profile="schule"]', 'HTL Musterstadt');
  await page.click('#dlg button.primary');
  await page.waitForSelector('[data-template="labor"]');
  assert.strictEqual(await page.locator('.tpl-grid .tpl').count(), 10, 'zehn eingebaute Vorlagen');
  await page.click('[data-template="labor"]');

  // Kopfdaten aus dem Profil übernommen, Vorschau zeigt Deckblatt.
  assert.strictEqual(await page.inputValue('[data-meta="name"]'), 'Max Muster');
  await page.fill('[data-meta="titel"]', 'Diodenkennlinie <b>Test</b>');
  await page.fill('[data-meta="lehrer"]', 'Prof. Beispiel');
  await page.waitForFunction(() => document.querySelector('#paper .tp-title')?.textContent.includes('Diodenkennlinie'));
  assert.ok(!(await page.locator('#paper .tp-title b').count()), 'HTML im Titel wird nicht interpretiert');

  // Text mit Markdown, Formel im Text und eingeschleustem Skript.
  const sec = (n) => page.locator('.section').nth(n);
  await sec(0).locator('textarea').first().fill('Messung der **Kennlinie** mit $R_V = 1\\,k\\Omega$.\n\n<script>window.hacked=1</script><img src=x onerror="window.hacked=1">');

  // Messwerte per Einfügen aus der Zwischenablage (Tabulator-getrennt, deutsches Komma).
  const table = sec(5).locator('.block[data-type="table"]').first();
  await table.locator('input[data-r="1"][data-c="0"]').focus();
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', '0,1\t0,0\n0,5\t0,2\n0,6\t1,5\n0,7\t9,8\n0,75\t25');
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  assert.strictEqual(await table.locator('input[data-r="4"][data-c="1"]').inputValue(), '9,8');

  // Bild über den Dateidialog.
  await app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] }); }, imgFile);
  await sec(2).locator('[data-add="image"]').click();
  await sec(2).locator('.block[data-type="image"] input[type="text"]').fill('Messschaltung');

  // Code- und Formelblock.
  await sec(4).locator('[data-add="code"]').click();
  await sec(4).locator('.block[data-type="code"] textarea').fill('int main(void) {\n    return 0; // <ok>\n}');
  await page.waitForFunction(() => document.querySelectorAll('#paper .chart path').length === 1);

  const preview = await page.locator('#paper').innerHTML();
  assert.ok(preview.includes('<strong>Kennlinie</strong>'), 'Markdown wird gerendert');
  assert.ok(preview.includes('class="katex"'), 'Formeln werden gerendert');
  assert.ok(preview.includes('Abbildung 1:') && preview.includes('Messschaltung'), 'Bild mit Nummer');
  assert.ok(preview.includes('Abbildung 2:'), 'Diagramm zählt als Abbildung');
  assert.ok(preview.includes('Listing 1:'), 'Listing nummeriert');
  assert.strictEqual(await page.evaluate(() => window.hacked), undefined, 'kein Skript aus dem Inhalt ausgeführt');
  assert.strictEqual(await page.locator('#paper script, #paper img[onerror]').count(), 0);

  // Check meldet leere Abschnitte.
  await page.click('[data-action="check"]');
  const issues = await page.locator('ul.issues li').allTextContents();
  assert.ok(issues.some((t) => t.includes('ist noch leer')), 'Check findet leere Abschnitte');
  assert.ok(!issues.some((t) => t.includes('„Name“')), 'Name ist ausgefüllt');
  await page.click('#dlg button.primary');

  await page.screenshot({ path: path.join(out, 'app.png') });

  // Dunkles Design: umschalten, bleibt nach Neustart erhalten; das Papier bleibt weiß.
  await page.click('[data-theme-toggle]');
  assert.strictEqual(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  assert.strictEqual(await page.evaluate(() => getComputedStyle(document.querySelector('#paper')).backgroundColor), 'rgb(255, 255, 255)');
  assert.notStrictEqual(await page.evaluate(() => getComputedStyle(document.querySelector('.card')).backgroundColor), 'rgb(255, 255, 255)');
  await page.screenshot({ path: path.join(out, 'app-dark.png') });

  // Speichern, PDF, HTML.
  await stubSave(app, docFile);
  await page.click('[data-action="save"]');
  await page.waitForFunction(() => document.querySelector('#file-status').textContent === 'test.protokoll');
  await stubSave(app, pdfFile);
  await page.click('[data-action="pdf"]');
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('PDF gespeichert'), null, { timeout: 30000 });
  const pdf = fs.readFileSync(pdfFile);
  assert.strictEqual(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.length > 20000, 'PDF hat Inhalt');
  await stubSave(app, htmlFile);
  await page.click('[data-action="html"]');
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('HTML gespeichert'));
  const html = fs.readFileSync(htmlFile, 'utf8');
  assert.ok(html.includes('Diodenkennlinie &lt;b&gt;Test') && !html.includes('<script'), 'HTML-Export ist sauber');
  assert.ok(html.includes('data:font/woff2'), 'Formelschriften eingebettet');

  // Als Vorlage speichern.
  await page.click('[data-action="saveTemplate"]');
  await page.fill('#tpl-name', 'Meine Laborvorlage');
  await page.click('#dlg button.primary');
  await page.waitForFunction(() => !document.querySelector('#dlg').open);
  await app.close();

  // Neustart mit Datei als Argument: Inhalt ist wieder da, eigene Vorlage wird angeboten.
  ({ app, page } = await launch(userData, [docFile]));
  await page.waitForSelector('[data-meta="titel"]');
  assert.strictEqual(await page.inputValue('[data-meta="titel"]'), 'Diodenkennlinie <b>Test</b>');
  assert.strictEqual(await page.evaluate(() => document.documentElement.dataset.theme), 'dark', 'Design bleibt gespeichert');
  assert.strictEqual(await page.locator('.block[data-type="image"]').count(), 1);
  assert.strictEqual(await page.locator('#paper .chart').count(), 1);
  await page.click('[data-action="new"]');
  await page.waitForSelector('.tpl-own');
  assert.ok((await page.locator('.tpl-own').textContent()).includes('Meine Laborvorlage'));

  // Jede eingebaute Vorlage lässt sich ohne Fehler öffnen und rendern.
  const ids = await page.locator('.tpl-grid .tpl[data-template]').evaluateAll((els) => els.map((e) => e.dataset.template).filter((id) => !id.endsWith('.json')));
  await page.keyboard.press('Escape');
  for (const id of ids) {
    await page.click('[data-action="new"]');
    await page.click(`[data-template="${id}"]`);
    await page.waitForFunction(() => document.querySelectorAll('#paper .sec').length >= 3);
    if (id === 'kicad') await page.screenshot({ path: path.join(out, 'kicad.png') });
  }

  // KiCad-Import mit einem echten Projekt (nur wenn KICAD_TEST_PROJECT auf eine .kicad_pro-Datei zeigt).
  const kicadProject = process.env.KICAD_TEST_PROJECT;
  if (kicadProject) {
    await page.click('[data-action="new"]');
    await page.click('[data-template="kicad"]');
    await app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] }); }, kicadProject);
    const importOnce = async () => {
      await page.click('[data-action="kicad"]');
      await page.waitForFunction(() => document.querySelector('#dlg').open && document.querySelector('#dlg .dlg-body').textContent.includes('übernommen'), null, { timeout: 180000 });
      await page.waitForFunction(() => document.querySelector('#toast').hidden);
      const text = await page.locator('#dlg .dlg-body').textContent();
      await page.click('#dlg button.primary');
      return text;
    };
    console.log('KiCad-Import:', await importOnce());
    const count = async () => ({
      images: await page.locator('.block[data-type="image"]').count(),
      tables: await page.locator('#paper .b-table').count(),
    });
    const first = await count();
    assert.ok(first.images >= 3, 'Schaltplan und beide Layout-Seiten importiert');
    assert.ok((await page.locator('#paper').textContent()).includes('Stückliste „'), 'Stückliste importiert');
    assert.ok((await page.locator('#paper').textContent()).includes('Kupferlagen'), 'Platinendaten importiert');
    const second = await importOnce();
    assert.ok(second.includes('ersetzt'), 'zweiter Import ersetzt den ersten');
    assert.deepStrictEqual(await count(), first, 'kein doppelter Inhalt nach erneutem Import');
    const kicadPdf = path.join(out, 'kicad.pdf');
    await stubSave(app, kicadPdf);
    await page.click('[data-action="pdf"]');
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('PDF gespeichert'), null, { timeout: 60000 });
    assert.ok(fs.statSync(kicadPdf).size > 50000);
    const text = await page.locator('#paper').textContent();
    if (process.env.KICAD_EXPECT) for (const part of process.env.KICAD_EXPECT.split('|')) assert.ok(text.includes(part), `Vorschau enthält „${part}“`);
    await page.screenshot({ path: path.join(out, 'kicad-import.png') });
  }
  await page.evaluate(() => window.api.setDirty(false)); // sonst fragt die App beim Beenden nach
  await app.close();

  console.log('OK – alle Prüfungen bestanden. Ausgaben in', out);
})().catch((e) => { console.error(e); process.exit(1); });
