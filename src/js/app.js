'use strict';
// Oberfläche: Editor, Live-Vorschau, Dialoge und Werkzeugleisten-Aktionen.

(function () {
  const { TEMPLATES, FORMULAS } = window.Templates;
  const R = window.Render;
  const api = window.api;

  const state = { doc: null, path: null, dirty: false, profile: {}, activeSection: null, activeBlock: null };

  const $ = (sel) => document.querySelector(sel);
  const uid = () => Math.random().toString(36).slice(2, 10);
  const clone = (o) => JSON.parse(JSON.stringify(o));

  // Kleiner DOM-Baukasten: h('div', {class: 'x', onclick: fn}, kind1, 'Text', ...)
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  // ------------------------------------------------------------ Dokument anlegen / laden

  function withIds(sections) {
    return (sections || []).map((s) => ({
      ...s,
      id: uid(),
      blocks: (s.blocks || []).map((b) => ({ ...b, id: uid() })),
    }));
  }

  function today() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function profileMeta() {
    const meta = {};
    for (const f of R.META_FIELDS) if (f.profile && state.profile[f.key]) meta[f.key] = state.profile[f.key];
    return meta;
  }

  function docFromTemplate(tpl) {
    return {
      templateId: tpl.id,
      docType: tpl.docType,
      meta: { fach: tpl.fach || '', datum: today(), ...profileMeta() },
      options: { deckblatt: true, toc: true, benotung: false },
      sections: withIds(clone(tpl.sections)),
    };
  }

  // Bringt beliebige (auch ältere oder fremde) Dateien in eine sichere, vollständige Form.
  function normalizeDoc(raw) {
    const doc = clone(raw || {});
    doc.docType = typeof doc.docType === 'string' ? doc.docType : 'Protokoll';
    doc.meta = doc.meta && typeof doc.meta === 'object' ? doc.meta : {};
    doc.options = { deckblatt: true, toc: true, benotung: false, ...(doc.options || {}) };
    doc.sections = (Array.isArray(doc.sections) ? doc.sections : []).map((s) => ({
      id: s.id || uid(),
      key: s.key,
      title: String(s.title || ''),
      hint: String(s.hint || ''),
      blocks: (Array.isArray(s.blocks) ? s.blocks : [])
        .filter((b) => b && ['text', 'image', 'table', 'code', 'formula'].includes(b.type))
        .map((b) => {
          const block = { ...b, id: b.id || uid() };
          if (block.type === 'table') {
            const rows = (Array.isArray(block.rows) ? block.rows : []).map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? '')) : []));
            const width = Math.max(1, ...rows.map((r) => r.length));
            block.rows = (rows.length ? rows : [['']]).map((r) => [...r, ...Array(width - r.length).fill('')]);
          }
          if (block.type === 'image' && !/^data:image\//.test(block.src || '')) block.src = '';
          return block;
        }),
    }));
    return doc;
  }

  function setDoc(doc, path) {
    state.doc = doc;
    state.path = path || null;
    state.activeSection = doc.sections[0]?.id || null;
    state.activeBlock = null;
    setDirty(false);
    renderEditor();
    renderPreview();
    $('#editor-pane').scrollTop = 0;
    $('#preview-pane').scrollTop = 0;
  }

  function setDirty(value) {
    state.dirty = value;
    api.setDirty(value);
    const name = state.path ? state.path.split(/[\\/]/).pop() : 'Noch nicht gespeichert';
    $('#file-status').textContent = (value ? '● ' : '') + name;
    $('#file-status').title = state.path || '';
    document.title = `${state.doc?.meta?.titel || 'Protokoll'} – Protokoll-EL`;
  }

  let previewTimer = null;
  function touch() {
    if (!state.dirty) setDirty(true);
    clearTimeout(previewTimer);
    previewTimer = setTimeout(renderPreview, 180);
  }

  function structureChanged(focusBlockId) {
    touch();
    renderEditor(focusBlockId);
  }

  // ------------------------------------------------------------ Vorschau

  const blobCache = new Map();
  function blobUrl(dataUrl) {
    if (!dataUrl || !dataUrl.startsWith('data:')) return dataUrl;
    let url = blobCache.get(dataUrl);
    if (!url) {
      const [head, payload] = dataUrl.split(',', 2);
      const mime = /data:([^;]+)/.exec(head)?.[1] || 'application/octet-stream';
      let bytes;
      if (/;base64/.test(head)) {
        const bin = atob(payload);
        bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      } else {
        bytes = new TextEncoder().encode(decodeURIComponent(payload));
      }
      url = URL.createObjectURL(new Blob([bytes], { type: mime }));
      blobCache.set(dataUrl, url);
    }
    return url;
  }

  function renderPreview() {
    if (!state.doc) return;
    $('#paper').innerHTML = R.renderDocument(state.doc, { imgSrc: blobUrl });
    document.title = `${state.doc.meta.titel || 'Protokoll'} – Protokoll-EL`;
  }

  function fitPaper() {
    const pane = $('#preview-pane');
    const paper = $('#paper');
    paper.style.zoom = 1;
    const zoom = Math.min(1, (pane.clientWidth - 36) / paper.offsetWidth);
    paper.style.zoom = zoom > 0 ? zoom : 1;
  }

  function scrollPreviewTo(sectionId) {
    const target = document.getElementById('sec-' + sectionId);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ------------------------------------------------------------ Editor

  function autoGrow(ta) {
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 2 + 'px';
  }

  function renderEditor(focusBlockId) {
    const pane = $('#editor-pane');
    const scroll = pane.scrollTop;
    const root = $('#editor');
    root.replaceChildren(metaPanel(), ...state.doc.sections.map(sectionCard),
      h('button', { class: 'add-section', onclick: addSection }, '+ Abschnitt hinzufügen'));
    root.querySelectorAll('textarea').forEach(autoGrow);
    pane.scrollTop = scroll;
    if (focusBlockId) {
      const el = root.querySelector(`[data-block="${focusBlockId}"]`);
      if (el) {
        el.scrollIntoView({ block: 'nearest' });
        el.querySelector('textarea, input[type="text"], input:not([type])')?.focus();
      }
    }
  }

  function field(label, input, wide) {
    return h('label', { class: 'field' + (wide ? ' wide' : '') }, h('span', null, label), input);
  }

  function metaPanel() {
    const doc = state.doc;
    const inputs = R.META_FIELDS.map((f) => field(f.label, h('input', {
      type: f.type || 'text',
      value: doc.meta[f.key] || '',
      'data-meta': f.key,
      oninput: (e) => { doc.meta[f.key] = e.target.value; touch(); },
    }), f.wide));
    inputs.splice(1, 0, field('Art des Protokolls', h('input', {
      type: 'text',
      value: doc.docType || '',
      oninput: (e) => { doc.docType = e.target.value; touch(); },
    })));
    const option = (key, label) => h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: doc.options[key], onchange: (e) => { doc.options[key] = e.target.checked; touch(); } }), label);
    return h('details', { class: 'card', open: true, id: 'meta-panel' },
      h('summary', null, 'Kopfdaten und Deckblatt'),
      h('div', { class: 'card-body' },
        h('div', { class: 'meta-grid' }, inputs),
        h('div', { class: 'options' },
          option('deckblatt', 'Deckblatt'),
          option('toc', 'Inhaltsverzeichnis'),
          option('benotung', 'Feld für Note und Unterschrift'))));
  }

  function move(arr, index, delta) {
    const to = index + delta;
    if (to < 0 || to >= arr.length) return false;
    [arr[index], arr[to]] = [arr[to], arr[index]];
    return true;
  }

  function addSection() {
    const s = { id: uid(), title: 'Neuer Abschnitt', hint: '', blocks: [{ id: uid(), type: 'text', md: '' }] };
    state.doc.sections.push(s);
    state.activeSection = s.id;
    structureChanged();
    const el = document.querySelector(`[data-section="${s.id}"] .sec-title`);
    if (el) { el.scrollIntoView({ block: 'center' }); el.select(); }
  }

  function sectionCard(section, index) {
    const sections = state.doc.sections;
    const el = h('div', { class: 'card section' + (state.activeSection === section.id ? ' active' : ''), 'data-section': section.id },
      h('div', { class: 'card-head' },
        h('span', { class: 'sec-n' }, index + 1),
        h('input', {
          type: 'text', class: 'sec-title', value: section.title, placeholder: 'Titel des Abschnitts',
          oninput: (e) => { section.title = e.target.value; touch(); },
        }),
        h('button', { class: 'icon', title: 'Abschnitt nach oben', onclick: () => move(sections, index, -1) && structureChanged() }, '↑'),
        h('button', { class: 'icon', title: 'Abschnitt nach unten', onclick: () => move(sections, index, 1) && structureChanged() }, '↓'),
        h('button', {
          class: 'icon danger', title: 'Abschnitt löschen',
          onclick: async () => {
            const hasContent = section.blocks.some((b) => !R.isBlockEmpty(b));
            if (hasContent && !(await confirmBox(`Abschnitt „${section.title}“ mit seinem Inhalt löschen?`, 'Löschen'))) return;
            sections.splice(index, 1);
            structureChanged();
          },
        }, '✕')),
      h('div', { class: 'card-body' },
        section.hint ? h('div', { class: 'hint' }, h('b', null, '💡 Tipp:'), section.hint) : null,
        section.blocks.map((b, i) => blockCard(section, b, i)),
        addBar(section)));

    el.addEventListener('focusin', () => activateSection(section.id, el));
    el.addEventListener('dragover', (e) => {
      if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); el.classList.add('drop'); }
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop'));
    el.addEventListener('drop', async (e) => {
      e.preventDefault();
      el.classList.remove('drop');
      await addImageFiles(section, [...e.dataTransfer.files]);
    });
    return el;
  }

  function activateSection(id, el) {
    if (state.activeSection === id) return;
    state.activeSection = id;
    document.querySelectorAll('.section.active').forEach((n) => n.classList.remove('active'));
    el.classList.add('active');
    scrollPreviewTo(id);
  }

  function addBar(section) {
    const add = (block) => {
      block.id = uid();
      section.blocks.push(block);
      structureChanged(block.id);
    };
    return h('div', { class: 'add-bar' },
      h('span', null, 'Einfügen:'),
      h('button', { 'data-add': 'text', onclick: () => add({ type: 'text', md: '' }) }, '+ Text'),
      h('button', { 'data-add': 'image', title: 'Bilddatei wählen – oder Screenshot mit Strg+V einfügen', onclick: () => pickImages(section) }, '+ Bild'),
      h('button', { 'data-add': 'table', onclick: () => add({ type: 'table', caption: '', rows: [['', ''], ['', ''], ['', '']], chart: false }) }, '+ Tabelle'),
      h('button', { 'data-add': 'code', onclick: () => add({ type: 'code', lang: '', caption: '', code: '' }) }, '+ Code'),
      h('button', { 'data-add': 'formula', onclick: () => add({ type: 'formula', tex: '', caption: '' }) }, '+ Formel'));
  }

  const BLOCK_NAMES = { text: 'Text', image: 'Bild', table: 'Tabelle', code: 'Code', formula: 'Formel' };

  function blockCard(section, block, index) {
    const body = { text: textBody, image: imageBody, table: tableBody, code: codeBody, formula: formulaBody }[block.type](block, section);
    const el = h('div', { class: 'block', 'data-block': block.id, 'data-type': block.type },
      h('div', { class: 'block-head' },
        h('span', { class: 'type' }, BLOCK_NAMES[block.type]),
        h('button', { class: 'icon', title: 'Nach oben', onclick: () => move(section.blocks, index, -1) && structureChanged(block.id) }, '↑'),
        h('button', { class: 'icon', title: 'Nach unten', onclick: () => move(section.blocks, index, 1) && structureChanged(block.id) }, '↓'),
        h('button', {
          class: 'icon danger', title: 'Block löschen',
          onclick: async () => {
            if (!R.isBlockEmpty(block) && !(await confirmBox(`${BLOCK_NAMES[block.type]}-Block mit Inhalt löschen?`, 'Löschen'))) return;
            section.blocks.splice(index, 1);
            structureChanged();
          },
        }, '✕')),
      h('div', { class: 'block-body' }, body));
    el.addEventListener('focusin', () => { state.activeBlock = block.id; });
    return el;
  }

  function textBody(block) {
    return [
      h('textarea', {
        placeholder: block.placeholder || 'Text schreiben …', value: block.md || '', spellcheck: 'true',
        oninput: (e) => { block.md = e.target.value; autoGrow(e.target); touch(); },
      }),
      h('div', { class: 'help' }, 'Formatierung: ', h('code', null, '**fett**'), ' ', h('code', null, '*kursiv*'), ' ',
        h('code', null, '- Aufzählung'), ' ', h('code', null, '1. Liste'), ' ', h('code', null, '$R_1 = 4{,}7\\,k\\Omega$'), ' für Formeln im Text'),
    ];
  }

  function imageBody(block) {
    return h('div', { class: 'img-row' },
      h('img', { src: blobUrl(block.src), alt: '' }),
      h('div', { class: 'img-fields' },
        h('input', {
          type: 'text', placeholder: 'Bildbeschriftung, z. B. „Messschaltung Spannungsteiler“', value: block.caption || '',
          oninput: (e) => { block.caption = e.target.value; touch(); },
        }),
        h('div', { class: 'row' },
          h('span', { class: 'help' }, 'Breite:'),
          h('select', { class: 'narrow', onchange: (e) => { block.width = Number(e.target.value); touch(); } },
            [40, 50, 60, 70, 80, 90, 100].map((w) => h('option', { value: w, selected: (block.width || 80) === w }, `${w} %`))),
          h('button', {
            class: 'small',
            onclick: async () => {
              const [img] = await api.pickImages();
              if (!img) return;
              block.src = await shrinkImage(img.dataUrl);
              structureChanged(block.id);
            },
          }, 'Bild ersetzen'))));
  }

  function codeBody(block) {
    return [
      h('div', { class: 'row' },
        h('input', { type: 'text', placeholder: 'Beschriftung, z. B. „Interrupt-Routine Timer 1“', value: block.caption || '', oninput: (e) => { block.caption = e.target.value; touch(); } }),
        h('input', { type: 'text', class: 'narrow', placeholder: 'Sprache (c, python …)', value: block.lang || '', spellcheck: 'false', oninput: (e) => { block.lang = e.target.value; touch(); } })),
      h('textarea', {
        class: 'mono', placeholder: 'Code hier einfügen …', value: block.code || '', spellcheck: 'false', wrap: 'off',
        oninput: (e) => { block.code = e.target.value; autoGrow(e.target); touch(); },
        onkeydown: (e) => {
          if (e.key !== 'Tab' || e.shiftKey || e.ctrlKey || e.altKey) return;
          e.preventDefault();
          e.target.setRangeText('    ', e.target.selectionStart, e.target.selectionEnd, 'end');
          e.target.dispatchEvent(new Event('input'));
        },
      }),
    ];
  }

  function formulaBody(block) {
    const tex = h('textarea', {
      class: 'mono', placeholder: 'LaTeX-Formel, z. B. U = R \\cdot I', value: block.tex || '', spellcheck: 'false', style: 'min-height:44px',
      oninput: (e) => { block.tex = e.target.value; autoGrow(e.target); touch(); },
    });
    const caption = h('input', { type: 'text', placeholder: 'Beschreibung (optional), z. B. „Ohmsches Gesetz“', value: block.caption || '', oninput: (e) => { block.caption = e.target.value; touch(); } });
    const picker = h('select', {
      class: 'narrow', title: 'Formel aus der Formelsammlung übernehmen',
      onchange: (e) => {
        const f = FORMULAS[Number(e.target.value)];
        e.target.value = '';
        if (!f) return;
        block.tex = tex.value = f[1];
        if (!block.caption) block.caption = caption.value = f[0];
        autoGrow(tex);
        touch();
      },
    }, h('option', { value: '' }, 'Formelsammlung …'), FORMULAS.map((f, i) => h('option', { value: i }, f[0])));
    return [
      tex,
      h('div', { class: 'row' }, caption, picker),
      h('div', { class: 'help' }, 'Schreibweise: ', h('code', null, '\\frac{a}{b}'), ' ', h('code', null, 'x^2'), ' ', h('code', null, 'R_1'), ' ',
        h('code', null, '\\sqrt{x}'), ' ', h('code', null, '\\cdot'), ' ', h('code', null, '\\Omega'), ' ', h('code', null, '\\mu'), ' ', h('code', null, '\\pi')),
    ];
  }

  // ------------------------------------------------------------ Tabellen

  function parseDelimited(text) {
    const src = String(text).replace(/\r\n?/g, '\n');
    const first = src.split('\n')[0] || '';
    const count = (ch) => first.split(ch).length - 1;
    const delim = count('\t') ? '\t' : (count(';') >= count(',') && count(';') ? ';' : ',');
    const rows = [];
    let row = [], cell = '', quoted = false;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (quoted) {
        if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cell += ch;
      } else if (ch === '"' && cell === '') quoted = true;
      else if (ch === delim) { row.push(cell); cell = ''; }
      else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    const filled = rows.filter((r) => r.some((c) => c.trim() !== ''));
    const width = Math.max(1, ...filled.map((r) => r.length));
    return filled.map((r) => [...r.map((c) => c.trim()), ...Array(width - r.length).fill('')]);
  }

  function tableBody(block) {
    const rows = block.rows;
    const cols = rows[0].length;
    const rebuild = () => structureChanged(block.id);

    const cellInput = (r, c) => h('input', {
      type: 'text', value: rows[r][c], 'data-r': r, 'data-c': c,
      placeholder: r === 0 ? 'Spalte' : '',
      oninput: (e) => { rows[r][c] = e.target.value; touch(); },
      onkeydown: (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        if (r === rows.length - 1) {
          rows.push(Array(cols).fill(''));
          touch();
          renderEditor();
        }
        document.querySelector(`[data-block="${block.id}"] input[data-r="${r + 1}"][data-c="${c}"]`)?.focus();
      },
      onpaste: (e) => {
        const text = e.clipboardData.getData('text/plain');
        if (!/[\t\n]/.test(text.trim())) return;
        e.preventDefault();
        const data = parseDelimited(text);
        for (let i = 0; i < data.length; i++) {
          while (rows.length <= r + i) rows.push(Array(rows[0].length).fill(''));
          for (let j = 0; j < data[i].length; j++) {
            if (rows[0].length <= c + j) rows.forEach((row) => row.push(''));
            rows[r + i][c + j] = data[i][j];
          }
        }
        rebuild();
      },
    });

    const grid = h('table', { class: 'tbl-edit' },
      h('tr', null, Array.from({ length: cols }, (_x, c) => h('td', { class: 'ctl' },
        cols > 1 ? h('button', { title: 'Spalte löschen', tabindex: '-1', onclick: () => { rows.forEach((row) => row.splice(c, 1)); rebuild(); } }, '✕') : null)), h('td')),
      rows.map((row, r) => h('tr', { class: r === 0 ? 'head' : '' },
        row.map((_v, c) => h('td', null, cellInput(r, c))),
        h('td', { class: 'ctl' }, r > 0 && rows.length > 2
          ? h('button', { title: 'Zeile löschen', tabindex: '-1', onclick: () => { rows.splice(r, 1); rebuild(); } }, '✕') : null))));

    const chartOptions = block.chart ? [
      h('label', { class: 'check', title: 'Logarithmische x-Achse, z. B. für Frequenzgänge' },
        h('input', { type: 'checkbox', checked: block.xLog, onchange: (e) => { block.xLog = e.target.checked; touch(); } }), 'x logarithmisch'),
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: block.yLog, onchange: (e) => { block.yLog = e.target.checked; touch(); } }), 'y logarithmisch'),
    ] : [];

    return [
      h('input', { type: 'text', placeholder: 'Tabellenbeschriftung, z. B. „Messwerte Diodenkennlinie“', value: block.caption || '', oninput: (e) => { block.caption = e.target.value; touch(); } }),
      h('div', { class: 'tbl-wrap' }, grid),
      h('div', { class: 'row' },
        h('button', { class: 'small', onclick: () => { rows.push(Array(cols).fill('')); rebuild(); } }, '+ Zeile'),
        h('button', { class: 'small', onclick: () => { rows.forEach((row) => row.push('')); rebuild(); } }, '+ Spalte'),
        h('button', {
          class: 'small', title: 'CSV-Datei laden (z. B. Oszilloskop-Export, Excel oder KiCad-Stückliste)',
          onclick: async () => {
            const file = await api.pickText('CSV-Datei', ['csv', 'txt', 'tsv']);
            if (!file) return;
            if (file.error) return messageBox('CSV-Import', file.error);
            const data = parseDelimited(file.text);
            if (!data.length) return messageBox('CSV-Import', 'In der Datei wurden keine Daten gefunden.');
            if (!R.isBlockEmpty(block) && !(await confirmBox('Die vorhandenen Tabellendaten werden ersetzt. Fortfahren?', 'Ersetzen'))) return;
            block.rows = data.length > 1 ? data : [...data, data[0].map(() => '')];
            rebuild();
          },
        }, 'CSV importieren'),
        h('label', { class: 'check', title: 'Erste Spalte = x-Achse, jede weitere Zahlenspalte = eine Kurve' },
          h('input', { type: 'checkbox', checked: block.chart, onchange: (e) => { block.chart = e.target.checked; rebuild(); } }), 'Diagramm'),
        chartOptions),
      h('div', { class: 'help' }, 'Tipp: Werte aus Excel/LibreOffice kopieren und in eine Zelle einfügen – die Tabelle wächst automatisch. Enter springt in die nächste Zeile.'),
    ];
  }

  // ------------------------------------------------------------ Bilder

  // Verkleinert große Fotos, damit Protokolldateien und PDFs handlich bleiben.
  async function shrinkImage(dataUrl) {
    if (!dataUrl || dataUrl.startsWith('data:image/svg')) return dataUrl;
    const MAX_SIDE = 2000, MAX_LEN = 1.4e6;
    const img = new Image();
    try {
      await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = blobUrl(dataUrl); });
    } catch { return dataUrl; }
    const side = Math.max(img.naturalWidth, img.naturalHeight);
    if (side <= MAX_SIDE && dataUrl.length <= MAX_LEN) return dataUrl;
    const k = Math.min(1, MAX_SIDE / side);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * k);
    canvas.height = Math.round(img.naturalHeight * k);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const png = dataUrl.startsWith('data:image/png') ? canvas.toDataURL('image/png') : null;
    return png && png.length <= MAX_LEN ? png : canvas.toDataURL('image/jpeg', 0.88);
  }

  const readAsDataUrl = (file) => new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });

  async function insertImages(section, images) {
    let last = null;
    const at = section.blocks.findIndex((b) => b.id === state.activeBlock);
    let pos = at >= 0 ? at + 1 : section.blocks.length;
    for (const img of images) {
      const block = { id: uid(), type: 'image', src: await shrinkImage(img.dataUrl), caption: img.caption || '', width: 80 };
      section.blocks.splice(pos++, 0, block);
      last = block;
    }
    if (last) structureChanged(last.id);
  }

  async function pickImages(section) {
    const images = await api.pickImages();
    state.activeBlock = null;
    await insertImages(section, images.map((i) => ({ dataUrl: i.dataUrl })));
  }

  async function addImageFiles(section, files) {
    const images = [];
    for (const f of files.filter((f) => f.type.startsWith('image/'))) images.push({ dataUrl: await readAsDataUrl(f) });
    await insertImages(section, images);
  }

  document.addEventListener('paste', async (e) => {
    if (!state.doc || $('#dlg').open) return;
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    const section = state.doc.sections.find((s) => s.id === state.activeSection) || state.doc.sections[0];
    if (!section) return;
    await addImageFiles(section, files);
    toast('Bild eingefügt – Beschriftung nicht vergessen.');
  });
  // Dateien, die neben einen Abschnitt fallen, sollen nicht das Fenster ersetzen.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  // ------------------------------------------------------------ Dialoge & Meldungen

  function dialogBox({ title, body, buttons, onOpen, closable = true }) {
    return new Promise((resolve) => {
      const dlg = $('#dlg');
      let result = null;
      const close = (value) => { result = value; dlg.close(); };
      dlg.replaceChildren(
        h('div', { class: 'dlg-head' }, title),
        h('div', { class: 'dlg-body' }, body),
        buttons && buttons.length ? h('div', { class: 'dlg-foot' }, buttons.map((b) => h('button', {
          class: b.primary ? 'primary' : '', 'data-value': String(b.value),
          onclick: () => close(typeof b.value === 'function' ? b.value() : b.value),
        }, b.label))) : null);
      dlg.oncancel = (e) => { if (!closable) e.preventDefault(); };
      dlg.onclose = () => resolve(result);
      dlg.showModal();
      if (onOpen) onOpen(close);
    });
  }

  const messageBox = (title, text) => dialogBox({
    title,
    body: (Array.isArray(text) ? text : [text]).map((t) => (t && t.nodeType ? t : h('p', null, t))),
    buttons: [{ label: 'OK', value: true, primary: true }],
  });

  const confirmBox = (text, okLabel = 'OK') => dialogBox({
    title: 'Bitte bestätigen',
    body: h('p', null, text),
    buttons: [{ label: 'Abbrechen', value: false }, { label: okLabel, value: true, primary: true }],
  });

  async function confirmDiscard() {
    if (!state.dirty) return true;
    return confirmBox('Das aktuelle Protokoll enthält ungespeicherte Änderungen. Trotzdem fortfahren?', 'Änderungen verwerfen');
  }

  let toastTimer = null;
  function toast(text, action, sticky) {
    const el = $('#toast');
    el.replaceChildren(h('span', null, text), action ? h('button', { onclick: action.run }, action.label) : null);
    el.hidden = false;
    clearTimeout(toastTimer);
    if (!sticky) toastTimer = setTimeout(() => { el.hidden = true; }, action ? 7000 : 3500);
  }

  // ------------------------------------------------------------ Vorlagen- und Profil-Dialog

  async function chooseTemplate() {
    const own = await api.listTemplates();
    const card = (t, onPick) => h('button', { class: 'tpl', 'data-template': t.id || t.file, onclick: onPick },
      h('div', { class: 'ico' }, t.icon || '⭐'),
      h('div', { class: 'cat' }, t.kategorie || 'Eigene Vorlage'),
      h('div', { class: 'name' }, t.name),
      h('div', { class: 'desc' }, t.beschreibung || `${t.doc.sections.length} Abschnitte`));

    const picked = await dialogBox({
      title: 'Neues Protokoll – Vorlage wählen',
      closable: !!state.doc,
      body: [],
      buttons: state.doc ? [{ label: 'Abbrechen', value: null }] : [{ label: 'Vorhandenes Protokoll öffnen …', value: 'open' }],
      onOpen: (close) => {
        const body = $('#dlg .dlg-body');
        body.append(h('div', { class: 'tpl-grid' }, TEMPLATES.map((t) => card(t, () => close(docFromTemplate(t))))));
        if (own.length) {
          body.append(h('h3', { class: 'dlg-sub' }, 'Eigene Vorlagen'),
            h('div', { class: 'tpl-grid' }, own.map((t) => h('div', { class: 'tpl-own' },
              card(t, () => {
                const doc = normalizeDoc(t.doc);
                doc.sections = withIds(doc.sections);
                doc.meta = { ...doc.meta, ...profileMeta(), datum: today(), abgabe: '' };
                close(doc);
              }),
              h('button', {
                class: 'icon danger', title: 'Vorlage löschen',
                onclick: async (e) => { await api.deleteTemplate(t.file); e.target.closest('.tpl-own').remove(); },
              }, '✕')))));
        }
      },
    });
    if (picked === 'open') {
      if (!(await openDoc()) && !state.doc) return chooseTemplate();
      return;
    }
    if (picked) setDoc(picked, null);
  }

  async function editProfile(firstRun) {
    const fields = R.META_FIELDS.filter((f) => f.profile);
    const values = { ...state.profile };
    const saved = await dialogBox({
      title: firstRun ? 'Willkommen bei Protokoll-EL' : 'Profil',
      body: [
        h('p', null, firstRun
          ? 'Trag einmal deine Daten ein – sie werden bei jedem neuen Protokoll automatisch ins Deckblatt übernommen. Du kannst sie später über „Profil“ ändern.'
          : 'Diese Daten werden bei jedem neuen Protokoll automatisch ins Deckblatt übernommen.'),
        h('div', { class: 'meta-grid', style: 'min-width:min(560px,80vw)' }, fields.map((f) => field(f.label, h('input', {
          type: 'text', value: values[f.key] || '', 'data-profile': f.key,
          oninput: (e) => { values[f.key] = e.target.value; },
        }), f.wide))),
      ],
      buttons: [{ label: firstRun ? 'Überspringen' : 'Abbrechen', value: false }, { label: 'Speichern', value: true, primary: true }],
    });
    if (!saved) return;
    state.profile = values;
    await api.setProfile(values);
    if (!firstRun) toast('Profil gespeichert. Es gilt für neue Protokolle.');
  }

  // ------------------------------------------------------------ Aktionen der Werkzeugleiste

  function suggestedName() {
    const m = state.doc.meta;
    return [m.klasse, m.name, m.titel || state.doc.docType].filter(Boolean).join('_').replace(/\s+/g, '-');
  }

  async function openDoc() {
    const res = await api.openDoc();
    if (!res) return false;
    if (res.error) { await messageBox('Öffnen fehlgeschlagen', res.error); return false; }
    setDoc(normalizeDoc(res.doc), res.path);
    return true;
  }

  async function saveDoc() {
    try {
      const path = await api.saveDoc(state.doc, state.path, suggestedName());
      if (!path) return false;
      state.path = path;
      setDirty(false);
      toast('Gespeichert.');
      return true;
    } catch (e) {
      await messageBox('Speichern fehlgeschlagen', String(e.message || e));
      return false;
    }
  }

  function showCheck() {
    const issues = R.checkDocument(state.doc);
    const body = issues.length
      ? [h('p', null, `${issues.length} Punkt(e) solltest du vor der Abgabe noch ansehen. Klick auf einen Eintrag springt zum Abschnitt.`),
        h('ul', { class: 'issues' }, issues.map((i) => h('li', {
          class: i.level + (i.sectionId ? ' link' : ''),
          onclick: () => {
            if (!i.sectionId) return;
            $('#dlg').close();
            document.querySelector(`[data-section="${i.sectionId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            scrollPreviewTo(i.sectionId);
          },
        }, i.text)))]
      : h('div', { class: 'ok-box' }, '✔ Alles vollständig – Kopfdaten ausgefüllt, kein Abschnitt leer, alle Bilder und Tabellen beschriftet.');
    return dialogBox({ title: 'Vollständigkeits-Check', body, buttons: [{ label: 'Schließen', value: null, primary: true }] });
  }

  async function exportDoc(kind) {
    const m = state.doc.meta;
    const title = m.titel || state.doc.docType || 'Protokoll';
    const html = R.renderDocument(state.doc);
    try {
      const file = kind === 'pdf'
        ? await api.exportPdf(html, suggestedName() || title, title, [m.name, m.klasse].filter(Boolean).join(' · '))
        : await api.exportHtml(html, suggestedName() || title, title);
      if (!file) return;
      const open = R.checkDocument(state.doc).length;
      toast(`${kind.toUpperCase()} gespeichert` + (open ? ` – der Check zeigt noch ${open} Hinweis(e).` : '.'),
        { label: 'Im Ordner anzeigen', run: () => api.showFile(file) });
    } catch (e) {
      await messageBox('Export fehlgeschlagen', String(e.message || e));
    }
  }

  function findSection(key, pattern, fallbackTitle) {
    const { sections } = state.doc;
    let s = sections.find((x) => x.key === key) || sections.find((x) => pattern.test(x.title));
    if (!s) {
      s = { id: uid(), key, title: fallbackTitle, hint: '', blocks: [] };
      sections.push(s);
    }
    return s;
  }

  // Entfernt alles, was ein früherer KiCad-Import eingefügt hat, damit ein erneuter Import aktualisiert statt verdoppelt.
  function removeKicadBlocks() {
    let removed = 0;
    for (const s of state.doc.sections) {
      const keep = s.blocks.filter((b) => !(b.kicad && (b.type !== 'text' || b.md === b.kicadText)));
      removed += s.blocks.length - keep.length;
      s.blocks = keep;
    }
    return removed;
  }

  function checkSummary(checks) {
    const n = (count, one, many) => `${count} ${count === 1 ? one : many}`;
    return checks.map((c) => {
      const name = c.kind === 'ERC' ? 'Der ERC (elektrische Regelprüfung des Schaltplans)' : 'Der DRC (Design-Regelprüfung des Layouts)';
      if (!c.errors && !c.warnings) return `${name} meldet keine Fehler und keine Warnungen.`;
      return `${name} meldet ${n(c.errors, 'Fehler', 'Fehler')} und ${n(c.warnings, 'Warnung', 'Warnungen')}` +
        (c.unconnected ? `, davon ${n(c.unconnected, 'nicht verbundene Leitung', 'nicht verbundene Leitungen')}` : '') + '.';
    }).join('\n\n');
  }

  async function kicadImport() {
    let res;
    toast('KiCad-Projekt wählen – danach wird automatisch geplottet, das dauert einige Sekunden …', null, true);
    try { res = await api.kicadImport(); } catch (e) { return messageBox('KiCad-Import fehlgeschlagen', String(e.message || e)); } finally { $('#toast').hidden = true; }
    if (!res) return;
    if (res.noCli) {
      return messageBox('KiCad wurde nicht gefunden', [
        'Zum automatischen Plotten nutzt Protokoll-EL das Programm „kicad-cli“, das mit KiCad (ab Version 7) mitinstalliert wird. Auf diesem Rechner wurde es nicht gefunden.',
        'Installiere KiCad von kicad.org und starte den Import noch einmal. Bis dahin geht es von Hand:',
        h('ul', null,
          h('li', null, 'Schaltplan/Layout: einen Screenshot mit Strg+V einfügen oder in KiCad „Datei → Plotten“ als SVG ausgeben und mit „+ Bild“ einfügen.'),
          h('li', null, 'Stückliste: in KiCad als CSV speichern und in der Tabelle „CSV importieren“ wählen.')),
      ]);
    }

    const replaced = removeKicadBlocks();
    const schaltplan = () => findSection('schaltplan', /schaltplan|schaltung/i, 'Schaltplan');
    const layout = () => findSection('layout', /layout|leiterplatte|platine/i, 'Leiterplattenlayout');

    let images = 0;
    for (const img of res.images) {
      if (!img.dataUrl) continue;
      (img.section === 'layout' ? layout() : schaltplan()).blocks.push(
        { id: uid(), type: 'image', src: img.dataUrl, caption: img.caption, width: img.width || 100, kicad: true });
      images++;
    }

    const putTable = (section, caption, rows, isPlaceholder) => {
      const block = { id: uid(), type: 'table', caption, rows, chart: false, kicad: true };
      const at = section.blocks.findIndex((b) => b.type === 'table' && isPlaceholder(b));
      if (at >= 0) section.blocks[at] = block; else section.blocks.push(block);
    };
    const bomRows = res.bom ? res.bom.length - 1 : 0;
    if (bomRows) {
      putTable(findSection('bom', /stückliste|bauteilliste|bom/i, 'Stückliste'), `Stückliste „${res.project}“`, res.bom, R.isBlockEmpty);
    }
    if (res.rules) {
      putTable(layout(), 'Design-Regeln und Platinendaten', res.rules,
        (b) => b.caption === 'Design-Regeln' && b.rows.slice(1).every((r) => !String(r[1] || '').trim()));
    }

    if (res.checks.length) {
      const s = findSection('checks', /erc|drc|design-check/i, 'Design-Checks (ERC / DRC)');
      const md = checkSummary(res.checks);
      const placeholder = s.blocks.findIndex((b) => b.type === 'text' && !String(b.md || '').trim());
      const text = { id: uid(), type: 'text', md, kicad: true, kicadText: md };
      if (placeholder >= 0) s.blocks[placeholder] = text; else s.blocks.unshift(text);
      const rows = res.checks.flatMap((c) => c.rows);
      if (rows.length) {
        const MAX = 40;
        const shown = rows.slice(0, MAX);
        if (rows.length > MAX) shown.push(['…', '', `${rows.length - MAX} weitere Meldungen (siehe KiCad)`, '']);
        s.blocks.push({ id: uid(), type: 'table', caption: 'Meldungen aus ERC und DRC', rows: [['Prüfung', 'Art', 'Meldung', 'Betroffen'], ...shown], chart: false, kicad: true });
      }
    }

    if (images || bomRows || res.rules || res.checks.length || replaced) structureChanged();
    const parts = [`${images} Bild(er)`, `${bomRows} Stücklisten-Position(en)`];
    if (res.rules) parts.push('Platinendaten');
    for (const c of res.checks) parts.push(`${c.kind}-Bericht`);
    return messageBox('KiCad-Import', [
      `Projekt „${res.project}“${res.version ? ` (KiCad ${res.version})` : ''}: ${parts.join(', ')} übernommen.` +
        (replaced ? ' Die Inhalte des früheren Imports wurden ersetzt.' : ''),
      ...res.messages,
    ]);
  }

  async function saveAsTemplate() {
    let name = state.doc.meta.titel || state.doc.docType || 'Meine Vorlage';
    const ok = await dialogBox({
      title: 'Als eigene Vorlage speichern',
      body: [
        h('p', null, 'Das aktuelle Protokoll (Abschnitte, Tipps und Inhalte) wird als Vorlage gespeichert und erscheint künftig unter „Neu“. Praktisch, wenn ein Lehrer einen bestimmten Aufbau verlangt.'),
        field('Name der Vorlage', h('input', { type: 'text', value: name, id: 'tpl-name', oninput: (e) => { name = e.target.value; } })),
      ],
      buttons: [{ label: 'Abbrechen', value: false }, { label: 'Speichern', value: true, primary: true }],
    });
    if (!ok || !name.trim()) return;
    await api.saveTemplate(name.trim(), state.doc);
    toast(`Vorlage „${name.trim()}“ gespeichert.`);
  }

  const actions = {
    new: async () => { if (await confirmDiscard()) await chooseTemplate(); },
    open: async () => { if (await confirmDiscard()) await openDoc(); },
    save: saveDoc,
    saveAs: async () => {
      const previous = state.path;
      state.path = null;
      if (!(await saveDoc())) state.path = previous;
    },
    pdf: () => exportDoc('pdf'),
    html: () => exportDoc('html'),
    check: showCheck,
    kicad: kicadImport,
    profile: () => editProfile(false),
    saveTemplate: saveAsTemplate,
  };

  let busy = false;
  async function runAction(name) {
    if (busy || !actions[name] || $('#dlg').open) return;
    if (!state.doc && !['new', 'open', 'profile'].includes(name)) return;
    busy = true;
    try { await actions[name](); } finally { busy = false; }
  }

  document.querySelector('.toolbar').addEventListener('click', (e) => {
    const name = e.target.closest('[data-action]')?.dataset.action;
    if (name) runAction(name);
  });

  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const key = e.key.toLowerCase();
    const name = key === 's' && e.shiftKey ? 'saveAs' : { s: 'save', o: 'open', n: 'new', p: 'pdf' }[key];
    if (!name) return;
    e.preventDefault();
    runAction(name);
  });

  window.addEventListener('resize', fitPaper);

  // ------------------------------------------------------------ Start

  (async function init() {
    fitPaper();
    state.profile = (await api.getProfile()) || {};
    const start = await api.startFile();
    if (start && start.doc) return setDoc(normalizeDoc(start.doc), start.path);
    if (start && start.error) await messageBox('Öffnen fehlgeschlagen', start.error);
    if (!Object.keys(state.profile).length) await editProfile(true);
    await chooseTemplate();
  })();
})();
