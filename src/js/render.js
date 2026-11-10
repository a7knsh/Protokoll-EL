'use strict';
// Wandelt ein Protokoll-Dokument in HTML um (für Vorschau, PDF- und HTML-Export).
// Enthält keinen Zugriff auf DOM oder Dateisystem, nur Zeichenketten.

(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const META_FIELDS = [
    { key: 'titel', label: 'Titel der Übung', wide: true },
    { key: 'uebungNr', label: 'Übungsnummer' },
    { key: 'fach', label: 'Fach / Gegenstand' },
    { key: 'name', label: 'Name', profile: true },
    { key: 'klasse', label: 'Klasse', profile: true },
    { key: 'katalogNr', label: 'Katalognummer', profile: true },
    { key: 'gruppe', label: 'Gruppe' },
    { key: 'mitarbeiter', label: 'Mitarbeiter', wide: true },
    { key: 'lehrer', label: 'Lehrer/in' },
    { key: 'datum', label: 'Datum der Übung', type: 'date' },
    { key: 'abgabe', label: 'Abgabedatum', type: 'date' },
    { key: 'schuljahr', label: 'Schuljahr', profile: true },
    { key: 'schule', label: 'Schule', profile: true, wide: true },
    { key: 'abteilung', label: 'Abteilung', profile: true, wide: true },
  ];

  function formatDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    return m ? `${m[3]}.${m[2]}.${m[1]}` : (iso || '');
  }

  // ------------------------------------------------------------ Formeln & Markdown

  function renderMath(tex, displayMode) {
    try {
      return window.katex.renderToString(tex, { displayMode, throwOnError: false, output: 'html', strict: false });
    } catch (e) {
      return `<code class="math-error">${esc(tex)}</code>`;
    }
  }

  let markedReady = false;
  function setupMarked() {
    if (markedReady) return;
    markedReady = true;
    window.marked.use({
      gfm: true,
      breaks: true,
      renderer: {
        // Rohes HTML aus fremden Protokolldateien wird nie ausgeführt, sondern als Text angezeigt.
        html(token) { return esc(token.text); },
        link(token) {
          const inner = this.parser.parseInline(token.tokens);
          if (!/^(https?:|mailto:)/i.test(token.href || '')) return inner;
          return `<a href="${esc(token.href)}">${inner}</a>`;
        },
        image(token) { return esc(token.text || ''); },
        heading(token) {
          const level = Math.min(token.depth + 1, 4);
          return `<h${level}>${this.parser.parseInline(token.tokens)}</h${level}>\n`;
        },
      },
    });
  }

  function renderMarkdown(md) {
    setupMarked();
    const math = [];
    const stash = (tex, display) => {
      math.push(renderMath(tex, display));
      return `\uE000M${math.length - 1}\uE001`;
    };
    let src = String(md || '')
      .replace(/\$\$([^$]+?)\$\$/g, (_m, tex) => stash(tex.trim(), true))
      .replace(/\$(\S(?:[^$\n]*?\S)?)\$/g, (_m, tex) => stash(tex, false));
    let html = window.marked.parse(src);
    html = html.replace(/\uE000M(\d+)\uE001/g, (_m, i) => math[Number(i)]);
    return html;
  }

  // ------------------------------------------------------------ Diagramm

  function parseNumber(value) {
    const s = String(value ?? '').trim().replace(/\s/g, '').replace(',', '.');
    if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return NaN;
    return parseFloat(s);
  }

  const fmtNum = (n) => {
    if (n === 0) return '0';
    const abs = Math.abs(n);
    const s = (abs >= 1e5 || abs < 1e-3) ? n.toExponential(1).replace('e+', 'e') : String(parseFloat(n.toPrecision(6)));
    return s.replace('.', ',');
  };

  function niceTicks(min, max, count = 6) {
    if (min === max) { min -= 1; max += 1; }
    const span = max - min;
    const raw = span / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((s) => s >= raw);
    const lo = Math.floor(min / step) * step;
    const hi = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.abs(v) < step / 1e6 ? 0 : v);
    return { lo, hi, ticks };
  }

  function logTicks(min, max) {
    const lo = Math.pow(10, Math.floor(Math.log10(min)));
    const hi = Math.pow(10, Math.ceil(Math.log10(max)));
    const ticks = [];
    for (let v = lo; v <= hi * 1.0001; v *= 10) ticks.push(v);
    if (ticks.length < 2) ticks.push(hi * 10);
    return { lo: ticks[0], hi: ticks[ticks.length - 1], ticks };
  }

  const SERIES_STYLE = [
    { color: '#1d4ed8', dash: '' },
    { color: '#b91c1c', dash: '7 4' },
    { color: '#15803d', dash: '2 3' },
    { color: '#7e22ce', dash: '9 3 2 3' },
    { color: '#b45309', dash: '4 2' },
  ];

  // Erste Spalte = x-Werte, jede weitere Spalte mit Zahlen = eine Kurve.
  function renderChart(block) {
    const rows = block.rows || [];
    if (rows.length < 3) return '';
    const header = rows[0];
    const xs = rows.slice(1).map((r) => parseNumber(r[0]));
    const series = [];
    for (let c = 1; c < header.length; c++) {
      const pts = [];
      rows.slice(1).forEach((r, i) => {
        const y = parseNumber(r[c]);
        if (Number.isFinite(xs[i]) && Number.isFinite(y)) pts.push([xs[i], y]);
      });
      if (pts.length >= 2) series.push({ name: header[c] || `Spalte ${c + 1}`, pts });
    }
    if (!series.length) return '';

    const xLog = !!block.xLog;
    const yLog = !!block.yLog;
    for (const s of series) s.pts = s.pts.filter(([x, y]) => (!xLog || x > 0) && (!yLog || y > 0));
    const all = series.flatMap((s) => s.pts);
    if (all.length < 2) return '';

    const xsAll = all.map((p) => p[0]);
    const ysAll = all.map((p) => p[1]);
    const xAxis = xLog ? logTicks(Math.min(...xsAll), Math.max(...xsAll)) : niceTicks(Math.min(...xsAll), Math.max(...xsAll), 7);
    const yAxis = yLog ? logTicks(Math.min(...ysAll), Math.max(...ysAll)) : niceTicks(Math.min(...ysAll), Math.max(...ysAll), 6);

    const W = 680, H = 380;
    const m = { l: 72, r: 20, t: series.length > 1 ? 34 : 16, b: 52 };
    const pw = W - m.l - m.r, ph = H - m.t - m.b;
    const scale = (axis, log, size) => (v) => (log
      ? (Math.log10(v) - Math.log10(axis.lo)) / (Math.log10(axis.hi) - Math.log10(axis.lo))
      : (v - axis.lo) / (axis.hi - axis.lo)) * size;
    const sx = (v) => m.l + scale(xAxis, xLog, pw)(v);
    const sy = (v) => m.t + ph - scale(yAxis, yLog, ph)(v);
    const f = (n) => n.toFixed(1);

    let g = '';
    for (const t of xAxis.ticks) {
      g += `<line x1="${f(sx(t))}" y1="${m.t}" x2="${f(sx(t))}" y2="${m.t + ph}" stroke="#d4d4d8" stroke-width="1"/>`;
      g += `<text x="${f(sx(t))}" y="${m.t + ph + 16}" text-anchor="middle">${esc(fmtNum(t))}</text>`;
    }
    for (const t of yAxis.ticks) {
      g += `<line x1="${m.l}" y1="${f(sy(t))}" x2="${m.l + pw}" y2="${f(sy(t))}" stroke="#d4d4d8" stroke-width="1"/>`;
      g += `<text x="${m.l - 7}" y="${f(sy(t) + 4)}" text-anchor="end">${esc(fmtNum(t))}</text>`;
    }
    g += `<rect x="${m.l}" y="${m.t}" width="${pw}" height="${ph}" fill="none" stroke="#3f3f46" stroke-width="1.2"/>`;
    g += `<text x="${m.l + pw / 2}" y="${H - 10}" text-anchor="middle" class="axis-label">${esc(header[0] || 'x')}</text>`;
    if (series.length === 1) {
      g += `<text transform="translate(16 ${m.t + ph / 2}) rotate(-90)" text-anchor="middle" class="axis-label">${esc(series[0].name)}</text>`;
    }

    series.forEach((s, i) => {
      const st = SERIES_STYLE[i % SERIES_STYLE.length];
      const pts = [...s.pts].sort((a, b) => a[0] - b[0]);
      const d = pts.map(([x, y], k) => `${k ? 'L' : 'M'}${f(sx(x))} ${f(sy(y))}`).join(' ');
      g += `<path d="${d}" fill="none" stroke="${st.color}" stroke-width="2" stroke-linejoin="round"${st.dash ? ` stroke-dasharray="${st.dash}"` : ''}/>`;
      for (const [x, y] of pts) g += `<circle cx="${f(sx(x))}" cy="${f(sy(y))}" r="3.2" fill="#fff" stroke="${st.color}" stroke-width="1.8"/>`;
    });

    if (series.length > 1) {
      let x = m.l;
      series.forEach((s, i) => {
        const st = SERIES_STYLE[i % SERIES_STYLE.length];
        g += `<line x1="${x}" y1="14" x2="${x + 26}" y2="14" stroke="${st.color}" stroke-width="2"${st.dash ? ` stroke-dasharray="${st.dash}"` : ''}/>`;
        g += `<text x="${x + 32}" y="18">${esc(s.name)}</text>`;
        x += 32 + Math.max(40, s.name.length * 7.2) + 18;
      });
    }

    return `<svg class="chart" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" font-family="Arial, Helvetica, sans-serif" font-size="12" fill="#27272a">${g}</svg>`;
  }

  // ------------------------------------------------------------ Blöcke

  function isBlockEmpty(b) {
    switch (b.type) {
      case 'text': return !String(b.md || '').trim();
      case 'image': return !b.src;
      case 'code': return !String(b.code || '').trim();
      case 'formula': return !String(b.tex || '').trim();
      case 'table': return !(b.rows || []).slice(1).some((r) => r.some((c) => String(c).trim()));
      default: return true;
    }
  }

  function renderBlock(b, counters) {
    if (isBlockEmpty(b)) return '';
    switch (b.type) {
      case 'text':
        return `<div class="b-text">${renderMarkdown(b.md)}</div>`;
      case 'image': {
        const n = ++counters.fig;
        const width = Math.min(100, Math.max(10, Number(b.width) || 80));
        const src = counters.imgSrc ? counters.imgSrc(b.src) : b.src;
        return `<figure class="b-image"><img src="${esc(src)}" style="width:${width}%" alt="">` +
          `<figcaption><b>Abbildung ${n}:</b> ${esc(b.caption || '')}</figcaption></figure>`;
      }
      case 'table': {
        const n = ++counters.tab;
        const [head, ...body] = b.rows;
        const filled = body.filter((r) => r.some((c) => String(c).trim()));
        let html = `<figure class="b-table"><figcaption><b>Tabelle ${n}:</b> ${esc(b.caption || '')}</figcaption><table><thead><tr>`;
        html += head.map((c) => `<th>${esc(c)}</th>`).join('') + '</tr></thead><tbody>';
        html += filled.map((r) => '<tr>' + head.map((_h, i) => `<td>${esc(r[i] ?? '')}</td>`).join('') + '</tr>').join('');
        html += '</tbody></table></figure>';
        if (b.chart) {
          const svg = renderChart(b);
          if (svg) {
            const fn = ++counters.fig;
            html += `<figure class="b-image b-chart">${svg}<figcaption><b>Abbildung ${fn}:</b> ${esc(b.chartCaption || `Diagramm zu Tabelle ${n}` + (b.caption ? ` (${b.caption})` : ''))}</figcaption></figure>`;
          }
        }
        return html;
      }
      case 'code': {
        const n = ++counters.lst;
        const lines = String(b.code).replace(/\s+$/, '').split('\n');
        const rowsHtml = lines.map((l, i) => `<span class="ln">${i + 1}</span>${esc(l)}`).join('\n');
        const label = [b.caption, b.lang ? `(${b.lang})` : ''].filter(Boolean).join(' ');
        return `<figure class="b-code"><figcaption><b>Listing ${n}:</b> ${esc(label)}</figcaption><pre><code>${rowsHtml}</code></pre></figure>`;
      }
      case 'formula': {
        const n = ++counters.eq;
        return `<div class="b-formula"><div class="eq">${renderMath(b.tex, true)}</div><div class="eq-no">(${n})</div>` +
          (b.caption ? `<div class="eq-cap">${esc(b.caption)}</div>` : '') + '</div>';
      }
      default:
        return '';
    }
  }

  // ------------------------------------------------------------ Dokument

  function renderTitlePage(doc) {
    const m = doc.meta || {};
    const row = (label, value) => (value ? `<tr><th>${esc(label)}</th><td>${esc(value)}</td></tr>` : '');
    const rows = [
      row('Name', m.name),
      row('Klasse', m.klasse),
      row('Katalognummer', m.katalogNr),
      row('Gruppe', m.gruppe),
      row('Mitarbeiter', m.mitarbeiter),
      row('Fach', m.fach),
      row('Lehrer/in', m.lehrer),
      row('Datum der Übung', formatDate(m.datum)),
      row('Abgabedatum', formatDate(m.abgabe)),
      row('Schuljahr', m.schuljahr),
    ].join('');
    const grade = doc.options?.benotung
      ? '<table class="tp-grade"><tr><th>Note</th><th>Datum</th><th>Unterschrift Lehrer/in</th></tr><tr><td></td><td></td><td></td></tr></table>'
      : '';
    return `<section class="titlepage">
  <div class="tp-school">${esc(m.schule || '')}${m.abteilung ? `<br><span>${esc(m.abteilung)}</span>` : ''}</div>
  <div class="tp-main">
    <div class="tp-type">${esc(doc.docType || 'Protokoll')}${m.uebungNr ? ` Nr. ${esc(m.uebungNr)}` : ''}</div>
    <h1 class="tp-title">${esc(m.titel || 'Titel der Übung')}</h1>
  </div>
  <table class="tp-meta">${rows}</table>
  ${grade}
</section>`;
  }

  // opts.imgSrc: optionale Funktion, die Bildquellen umschreibt (Vorschau nutzt Blob-URLs statt langer Data-URLs).
  function renderDocument(doc, opts = {}) {
    const counters = { fig: 0, tab: 0, lst: 0, eq: 0, imgSrc: opts.imgSrc };
    const opt = doc.options || {};
    const sections = (doc.sections || []).map((s, i) => ({
      n: i + 1,
      id: s.id,
      title: s.title || 'Ohne Titel',
      body: (s.blocks || []).map((b) => renderBlock(b, counters)).join('\n'),
    }));

    let html = '<div class="doc">';
    if (opt.deckblatt !== false) {
      html += renderTitlePage(doc);
    } else {
      const m = doc.meta || {};
      const line = [m.name, m.klasse, m.fach, formatDate(m.datum)].filter(Boolean).map(esc).join(' · ');
      html += `<header class="compact-head"><div class="tp-type">${esc(doc.docType || 'Protokoll')}${m.uebungNr ? ` Nr. ${esc(m.uebungNr)}` : ''}</div>` +
        `<h1 class="tp-title">${esc(m.titel || 'Titel der Übung')}</h1><div class="compact-meta">${line}</div></header>`;
    }
    if (opt.toc !== false && sections.length) {
      html += '<nav class="toc"><h2>Inhaltsverzeichnis</h2><ol>' +
        sections.map((s) => `<li><span class="toc-n">${s.n}</span><a href="#sec-${esc(s.id)}">${esc(s.title)}</a></li>`).join('') +
        '</ol></nav>';
    }
    for (const s of sections) {
      html += `<section class="sec" id="sec-${esc(s.id)}"><h2><span class="sec-n">${s.n}</span>${esc(s.title)}</h2>\n${s.body}</section>`;
    }
    html += '</div>';
    return html;
  }

  // ------------------------------------------------------------ Vollständigkeits-Check

  function checkDocument(doc) {
    const issues = [];
    const m = doc.meta || {};
    const need = { titel: 'Titel der Übung', name: 'Name', klasse: 'Klasse', fach: 'Fach', lehrer: 'Lehrer/in', datum: 'Datum der Übung' };
    for (const [k, label] of Object.entries(need)) {
      if (!String(m[k] || '').trim()) issues.push({ level: 'error', text: `Kopfdaten: „${label}“ fehlt.` });
    }
    (doc.sections || []).forEach((s, i) => {
      const where = `Abschnitt ${i + 1} „${s.title}“`;
      const filled = (s.blocks || []).filter((b) => !isBlockEmpty(b));
      if (!filled.length) issues.push({ level: 'error', text: `${where} ist noch leer.`, sectionId: s.id });
      for (const b of filled) {
        if (b.type === 'image' && !String(b.caption || '').trim()) issues.push({ level: 'warn', text: `${where}: Ein Bild hat keine Beschriftung.`, sectionId: s.id });
        if (b.type === 'table' && !String(b.caption || '').trim()) issues.push({ level: 'warn', text: `${where}: Eine Tabelle hat keine Beschriftung.`, sectionId: s.id });
        if (b.type === 'text' && /…|\.\.\.|TODO/.test(b.md)) issues.push({ level: 'warn', text: `${where}: Text enthält noch Platzhalter („…“ oder TODO).`, sectionId: s.id });
        if (b.type === 'table' && b.chart && !renderChart(b)) issues.push({ level: 'warn', text: `${where}: Für das Diagramm sind mindestens zwei Zeilen mit Zahlen nötig.`, sectionId: s.id });
      }
    });
    return issues;
  }

  window.Render = { esc, META_FIELDS, formatDate, renderDocument, renderChart, renderMarkdown, isBlockEmpty, checkDocument, parseNumber };
})();
