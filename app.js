const $ = (id) => document.getElementById(id);

function cleanText(value) {
  return value.replace(/\s+/g, ' ').replace(/\u00a0/g, ' ').trim();
}

function decodeQuotedPrintable(input) {
  return input
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function parseContentType(value) {
  const match = value.match(/(?:^|;)\s*charset\s*=\s*["']?([^;"'\s]+)/i);
  return match ? match[1] : 'utf-8';
}

function decodeBytes(bytes, charset = 'utf-8') {
  try { return new TextDecoder(charset).decode(bytes); }
  catch { return new TextDecoder('utf-8').decode(bytes); }
}

function splitMhtml(raw) {
  const headerEnd = raw.search(/\r?\n\r?\n/);
  if (headerEnd < 0) throw new Error('The MHTML file has no MIME header.');
  const header = raw.slice(0, headerEnd);
  const boundaryMatch = header.match(/boundary\s*=\s*(?:"([^"]+)"|([^;\r\n]+))/i);
  if (!boundaryMatch) throw new Error('Could not find the MHTML MIME boundary.');
  const boundary = boundaryMatch[1] || boundaryMatch[2].trim();
  const marker = `--${boundary}`;
  const chunks = raw.split(marker).slice(1);
  const parts = [];
  for (let chunk of chunks) {
    chunk = chunk.replace(/^\r?\n/, '').replace(/\r?\n--$/, '').replace(/^--\r?\n?$/, '');
    if (!chunk.trim()) continue;
    const sep = chunk.search(/\r?\n\r?\n/);
    if (sep < 0) continue;
    const h = chunk.slice(0, sep);
    const body = chunk.slice(sep).replace(/^\r?\n\r?\n/, '');
    const headers = {};
    for (const line of h.split(/\r?\n/)) {
      const m = line.match(/^([^:]+):\s*(.*)$/);
      if (m) headers[m[1].toLowerCase()] = m[2];
    }
    parts.push({ headers, body });
  }
  return parts;
}

function base64ToBytes(value) {
  const compact = value.replace(/\s+/g, '');
  const binary = atob(compact);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function parseMhtml(raw) {
  const parts = splitMhtml(raw);
  const htmlPart = parts.find(p => (p.headers['content-type'] || '').toLowerCase().startsWith('text/html'));
  if (!htmlPart) throw new Error('No text/html part was found in the MHTML file.');
  let html = htmlPart.body;
  if ((htmlPart.headers['content-transfer-encoding'] || '').toLowerCase().includes('quoted-printable')) html = decodeQuotedPrintable(html);
  const images = new Map();
  for (const part of parts) {
    const type = (part.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!type.startsWith('image/')) continue;
    let bytes;
    const encoding = (part.headers['content-transfer-encoding'] || '').toLowerCase();
    if (encoding === 'base64') bytes = base64ToBytes(part.body);
    else if (encoding === 'quoted-printable') bytes = new Uint8Array(new TextEncoder().encode(decodeQuotedPrintable(part.body)));
    else bytes = new Uint8Array(new TextEncoder().encode(part.body));
    const location = part.headers['content-location'];
    if (location) images.set(location, { type, bytes });
  }
  return { html, images, parts: parts.length };
}

function parseHtmlDocument(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  if (doc.querySelector('parsererror')) throw new Error('The HTML report could not be parsed.');
  return doc;
}

function textOf(el) { return cleanText(el?.textContent || ''); }

function normaliseHeader(value) {
  return cleanText(value).toLowerCase().replace(/[:]/g, '');
}

function findSetTable(doc) {
  const tables = [...doc.querySelectorAll('table')];
  return tables.find(table => {
    const headers = [...table.querySelectorAll('tr:first-child th, tr:first-child td')].map(textOf);
    const normal = headers.map(normaliseHeader);
    return normal.includes('surname') && normal.includes('preferred name');
  }) || tables.find(table => /surname/i.test(textOf(table)) && /preferred name/i.test(textOf(table)));
}

function extractReportMeta(doc) {
  const meta = {};
  const labels = ['Teacher', 'Grade Group', 'Subject', 'Set Name', 'Set Code', 'Set Number', 'Linked Teachers'];
  const cells = [...doc.querySelectorAll('td')];
  for (const label of labels) {
    const cell = cells.find(td => new RegExp(`^\\s*${label}\\s*:\\s*$`, 'i').test(textOf(td)));
    if (cell?.nextElementSibling) meta[label] = textOf(cell.nextElementSibling);
  }
  const title = textOf(doc.querySelector('title'));
  const heading = [...doc.querySelectorAll('h1,h2,h3,h4,b,strong')].map(textOf).find(t => /^Set Profile/i.test(t));
  meta.title = heading || title || '';
  return meta;
}

function extractStudents(doc) {
  const table = findSetTable(doc);
  if (!table) throw new Error('Could not find the Set List table. It should contain Surname and Preferred Name headers.');
  const rows = [...table.querySelectorAll('tr')];
  const headerRow = rows.find(row => {
    const h = [...row.querySelectorAll('th,td')].map(textOf).map(normaliseHeader);
    return h.includes('surname') && h.includes('preferred name');
  });
  if (!headerRow) throw new Error('Could not identify the student table headers.');
  const headers = [...headerRow.querySelectorAll('th,td')].map(textOf);
  const students = [];
  for (const row of rows.slice(rows.indexOf(headerRow) + 1)) {
    const cells = [...row.querySelectorAll(':scope > td, :scope > th')];
    if (!cells.length) continue;
    const values = cells.map(textOf);
    const record = {};
    headers.forEach((header, i) => { record[header] = values[i] ?? ''; });
    const surname = record[headers.find(h => normaliseHeader(h) === 'surname')];
    const preferred = record[headers.find(h => normaliseHeader(h) === 'preferred name')];
    if (!surname && !preferred) continue;
    students.push({ fields: record, name: [preferred, surname].filter(Boolean).join(' '), photo: null });
  }
  return { headers, students };
}

function normaliseName(name) {
  return cleanText(name).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function resolveRelativeUrl(src, baseUrl) {
  try { return new URL(src, baseUrl).href; } catch { return src; }
}

function extractPhotos(doc, mhtmlImages = null) {
  const photos = [];
  for (const img of doc.querySelectorAll('img')) {
    const src = img.getAttribute('src') || img.getAttribute('data-src');
    if (!src) continue;
    const link = img.closest('a');
    const href = link?.getAttribute('href') || src;
    const block = img.parentElement?.parentElement || img.parentElement;
    const text = textOf(block);
    if (!text) continue;
    const after = text.replace(textOf(img), '').trim();
    if (!/\.(jpe?g|png|gif)(?:$|\?)/i.test(href) && !/\.(jpe?g|png|gif)(?:$|\?)/i.test(src)) continue;
    const filename = href.split('/').pop().split('?')[0];
    let embedded = null;
    if (mhtmlImages) {
      for (const [location, image] of mhtmlImages) {
        if (location.split('/').pop() === filename) { embedded = image; break; }
      }
    }
    photos.push({ filename, src, href, text: after, embedded });
  }
  return photos;
}

function dataUrlFromImage(image) {
  if (!image) return null;
  let binary = '';
  const bytes = image.bytes;
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  return `data:${image.type};base64,${btoa(binary)}`;
}

function associatePhotos(students, photos) {
  const unmatched = [...photos];
  for (const student of students) {
    const target = normaliseName(student.name);
    const matchIndex = unmatched.findIndex(p => normaliseName(p.text).includes(target) || target.includes(normaliseName(p.text)));
    if (matchIndex >= 0) {
      const [photo] = unmatched.splice(matchIndex, 1);
      student.photo = photo;
    }
  }
  return unmatched;
}

async function parseFile(file) {
  const raw = await file.text();
  const isMhtml = /\.(mht|mhtml)$/i.test(file.name) || /^From:\s/m.test(raw) && /Content-Type:\s*multipart\/related/i.test(raw);
  let html, images = new Map(), partCount = 0;
  if (isMhtml) {
    const parsed = parseMhtml(raw);
    html = parsed.html; images = parsed.images; partCount = parsed.parts;
  } else html = raw;
  const doc = parseHtmlDocument(html);
  const meta = extractReportMeta(doc);
  const { headers, students } = extractStudents(doc);
  const photos = extractPhotos(doc, isMhtml ? images : null);
  const unmatched = associatePhotos(students, photos);
  return { isMhtml, meta, headers, students, photos, unmatchedPhotos: unmatched, embeddedImages: images.size, partCount };
}

function render(result) {
  $('summary').classList.remove('hidden');
  $('fieldPanel').classList.remove('hidden');
  $('studentPanel').classList.remove('hidden');
  const metaEntries = [
    ['Report', result.meta.title], ['Teacher', result.meta.Teacher], ['Subject', result.meta.Subject], ['Set', result.meta['Set Name'] || result.meta['Set Code']],
    ['Students', result.students.length], ['Format', result.isMhtml ? `MHTML (${result.embeddedImages} embedded images)` : 'HTML']
  ];
  $('meta').innerHTML = metaEntries.map(([k,v]) => `<div class="meta"><small>${escapeHtml(k)}</small><strong>${escapeHtml(v ?? 'Not found')}</strong></div>`).join('');
  $('fields').innerHTML = result.headers.map(h => `<span class="chip">${escapeHtml(h)}</span>`).join('');
  $('studentSummary').textContent = `${result.students.length} students found · ${result.students.filter(s => s.photo?.embedded || s.photo?.src).length} photos matched`;
  const displayHeaders = result.headers;
  $('thead').innerHTML = `<tr><th>Photo</th>${displayHeaders.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr>`;
  $('tbody').innerHTML = result.students.map(s => `<tr><td>${s.photo?.embedded ? `<img class="photo" src="${dataUrlFromImage(s.photo.embedded)}" alt="">` : '<span class="muted">—</span>'}</td>${displayHeaders.map(h => `<td>${escapeHtml(s.fields[h] || '')}</td>`).join('')}</tr>`).join('');
  $('diagPanel').classList.remove('hidden');
  $('diag').textContent = JSON.stringify({
    format: result.isMhtml ? 'MHTML' : 'HTML',
    parts: result.partCount || undefined,
    embeddedImages: result.embeddedImages || 0,
    detectedFields: result.headers,
    students: result.students.map(s => ({ name: s.name, fields: s.fields, photoFile: s.photo?.filename || null })),
    unmatchedPhotoCount: result.unmatchedPhotos.length
  }), null, 2);
}

function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }

async function loadFile(file) {
  $('status').className = 'status'; $('status').textContent = `Reading ${file.name}…`;
  try {
    const result = await parseFile(file);
    render(result);
    $('status').className = `status ${result.unmatchedPhotos.length ? 'warn' : 'ok'}`;
    $('status').textContent = result.unmatchedPhotos.length
      ? `Imported ${result.students.length} students; ${result.unmatchedPhotos.length} photo(s) could not be matched.`
      : `Successfully imported ${result.students.length} students and matched all detected photos.`;
  } catch (error) {
    console.error(error);
    $('status').className = 'status bad'; $('status').textContent = error.message || 'Import failed.';
  }
}

$('file').addEventListener('change', e => { if (e.target.files[0]) loadFile(e.target.files[0]); });
$('drop').addEventListener('dragover', e => { e.preventDefault(); $('drop').classList.add('over'); });
$('drop').addEventListener('dragleave', () => $('drop').classList.remove('over'));
$('drop').addEventListener('drop', e => { e.preventDefault(); $('drop').classList.remove('over'); if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); });

$('selfTest').addEventListener('click', () => {
  const fakeHtml = `<!doctype html><html><body><h3>Set Profile - Test Class</h3><table><tr><td><b>Teacher:</b></td><td>Test Teacher</td></tr><tr><td><b>Subject:</b></td><td>Mathematics</td></tr><tr><td><b>Set Name:</b></td><td>Y8 TEST</td></tr></table><table><tr><td></td><td>Surname</td><td>Preferred Name</td><td>Form</td><td>Gender</td></tr><tr><td>1.</td><td>Student One</td><td>Alex</td><td>8A</td><td>M</td></tr><tr><td>2.</td><td>Student Two</td><td>Sam</td><td>8A</td><td>F</td></tr></table></body></html>`;
  try {
    const doc = parseHtmlDocument(fakeHtml); const {headers, students} = extractStudents(doc); const meta = extractReportMeta(doc);
    const ok = headers.includes('Surname') && headers.includes('Preferred Name') && students.length === 2 && meta.Subject === 'Mathematics';
    $('diagPanel').classList.remove('hidden'); $('diag').textContent = ok ? 'PASS — synthetic HTML parser test found the expected class, fields and 2 students.' : JSON.stringify({headers, students, meta}, null, 2);
    $('status').className = `status ${ok ? 'ok' : 'bad'}`; $('status').textContent = ok ? 'Self-test passed.' : 'Self-test failed — see diagnostics.';
  } catch (e) { $('status').className = 'status bad'; $('status').textContent = `Self-test failed: ${e.message}`; }
});
