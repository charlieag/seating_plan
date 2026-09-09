import { parseMhtml, parseIamsHtml } from './isams-parser.js';

const $ = id => document.getElementById(id);
const fileInput = $('mhtmlFile');
const status = $('status');
const report = $('report');
const checks = $('checks');

function setStatus(message, type = '') {
  status.textContent = message;
  status.className = `status ${type}`.trim();
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}

function renderChecks(result, mime) {
  const checksData = [
    ['MHTML envelope parsed', true],
    ['HTML document found', Boolean(mime.html)],
    ['At least one class found', result.classes.length > 0],
    ['Every class has students', result.classes.every(c => c.students.length > 0)],
    ['No empty student names', result.classes.every(c => c.students.every(s => s.surname || s.preferredName))],
    ['Numbering column excluded', result.classes.every(c => !c.headers.some(h => /^\d+\.?$/.test(h)))],
    ['Dynamic fields retained', result.classes.every(c => c.headers.length >= 2)],
  ];
  checks.innerHTML = checksData.map(([label, pass]) => `<div class="check ${pass ? 'pass' : 'fail'}">${pass ? '✓' : '✕'} ${escapeHtml(label)}</div>`).join('');
}

function renderClass(c) {
  const metadata = Object.entries(c.metadata).filter(([, value]) => value);
  const rows = c.students.slice(0, 20).map(student => `<tr>${c.headers.map(h => `<td>${escapeHtml(student.fields[h])}</td>`).join('')}</tr>`).join('');
  const more = c.students.length > 20 ? `<p class="class-meta">Showing first 20 of ${c.students.length} students.</p>` : '';
  const photo = c.photoReport;
  return `<article class="class">
    <div class="class-head">
      <div><div class="class-title">${escapeHtml(c.metadata['Set Name'] || `Class ${c.ordinal}`)}</div><div class="class-meta">Identity: ${escapeHtml(c.identity)}</div></div>
      <div class="right class-meta">${c.students.length} students</div>
    </div>
    <div class="class-body">
      <div class="tags">${metadata.map(([k,v]) => `<span class="tag"><b>${escapeHtml(k)}:</b> ${escapeHtml(v)}</span>`).join('') || '<span class="tag warn">No class metadata confidently identified</span>'}</div>
      <div class="tags">
        <span class="tag good">${photo.matched} photos matched</span>
        <span class="tag">${photo.galleryImages} JPEG gallery images</span>
        ${photo.studentsWithoutPhoto ? `<span class="tag warn">${photo.studentsWithoutPhoto} students without photo</span>` : ''}
        ${photo.unmatchedImages.length ? `<span class="tag warn">${photo.unmatchedImages.length} unmatched gallery images</span>` : ''}
      </div>
      <div class="table-wrap"><table class="student-table"><thead><tr>${c.headers.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>
      ${more}
    </div>
  </article>`;
}

function renderReport(result) {
  report.innerHTML = `<div class="summary">
    <div class="metric"><strong>${result.totals.classes}</strong><span>classes</span></div>
    <div class="metric"><strong>${result.totals.students}</strong><span>students</span></div>
    <div class="metric"><strong>${result.totals.galleryImages}</strong><span>JPEG gallery images</span></div>
    <div class="metric"><strong>${result.totals.matchedPhotos}</strong><span>photos matched</span></div>
  </div>${result.classes.map(renderClass).join('')}`;
}

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  report.textContent = 'Parsing…';
  checks.replaceChildren();
  setStatus(`Selected: ${file.name}\nReading file…`);

  try {
    const raw = await file.text();
    const mime = parseMhtml(raw);
    setStatus(`MHTML envelope parsed.\n${mime.parts.length} MIME parts found.\n${mime.binaryParts.length} JPEG parts found.\nParsing classes…`);
    const result = parseIamsHtml(mime.html, mime.binaryParts);
    renderReport(result);
    renderChecks(result, mime);
    setStatus(`Import inspection complete.\n${result.totals.classes} classes and ${result.totals.students} students detected.\nNothing has been saved.`, 'ok');
    window.__lastParserResult = result;
  } catch (error) {
    console.error(error);
    report.innerHTML = `<div class="empty">${escapeHtml(error.message || String(error))}</div>`;
    setStatus(`Parser failed:\n${error.stack || error.message || error}`, 'bad');
  }
});
