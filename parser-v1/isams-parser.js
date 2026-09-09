/*
 * iSAMS MHTML parser — Build 1.0.0
 *
 * Deliberately has no storage or UI dependencies. It turns one MHTML export
 * into a structured, inspectable import result. Student data stays in memory.
 */

const CLASS_META_LABELS = [
  'Set Name', 'Set Code', 'Teacher', 'Linked Teachers', 'Subject',
  'Grade Group', 'Year Group', 'Form', 'Academic Year'
];

function clean(value) {
  return String(value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

export function normalise(value) {
  return clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function parseMimeHeaders(text) {
  const headers = {};
  let current = '';
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (/^[ \t]/.test(line) && current) { headers[current] += ' ' + line.trim(); continue; }
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (match) { current = match[1].toLowerCase(); headers[current] = match[2].trim(); }
  }
  return headers;
}

function decodeQuotedPrintable(text) {
  return text.replace(/=\r?\n/g, '').replace(/=([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function decodeBase64ToBytes(text) {
  const binary = atob(text.replace(/[\r\n\t ]/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function boundaryFromContentType(contentType) {
  const match = String(contentType || '').match(/boundary\s*=\s*(?:"([^"]+)"|([^;]+))/i);
  return clean(match?.[1] || match?.[2] || '');
}

function splitMimeParts(raw, boundary) {
  const pieces = raw.split('--' + boundary);
  const parts = [];
  for (let piece of pieces) {
    piece = piece.replace(/^\r?\n/, '');
    if (!piece || piece.startsWith('--')) continue;
    const separator = piece.search(/\r?\n\r?\n/);
    if (separator < 0) continue;
    const headers = parseMimeHeaders(piece.slice(0, separator));
    const body = piece.slice(separator).replace(/^\r?\n\r?\n/, '');
    parts.push({ headers, body });
  }
  return parts;
}

export function parseMhtml(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('The selected file is empty.');
  const headerEnd = raw.search(/\r?\n\r?\n/);
  if (headerEnd < 0) throw new Error('The file does not contain a valid MIME header.');
  const topHeaders = parseMimeHeaders(raw.slice(0, headerEnd));
  const boundary = boundaryFromContentType(topHeaders['content-type']);
  if (!boundary) throw new Error('No MHTML MIME boundary was found.');

  const parts = splitMimeParts(raw, boundary).map((part, index) => ({
    index,
    headers: part.headers,
    contentType: clean(part.headers['content-type']).toLowerCase(),
    location: clean(part.headers['content-location']),
    transferEncoding: clean(part.headers['content-transfer-encoding']).toLowerCase(),
    body: part.body
  }));

  const htmlPart = parts.find(p => p.contentType.startsWith('text/html'));
  if (!htmlPart) throw new Error('No text/html part was found in the MHTML file.');

  let html;
  if (htmlPart.transferEncoding === 'base64') html = new TextDecoder('utf-8').decode(decodeBase64ToBytes(htmlPart.body));
  else if (htmlPart.transferEncoding === 'quoted-printable') html = decodeQuotedPrintable(htmlPart.body);
  else html = htmlPart.body;

  const binaryParts = parts.filter(p => /^image\/(jpeg|jpg)$/i.test(p.contentType)).map(p => ({
    index: p.index,
    location: p.location,
    contentType: p.contentType,
    bytes: p.transferEncoding === 'base64' ? decodeBase64ToBytes(p.body) : null
  }));
  return { html, parts, htmlPartIndex: htmlPart.index, binaryParts };
}

function directRows(table) {
  const rows = [];
  for (const child of table.children) {
    if (child.tagName === 'TR') rows.push(child);
    else if (/^(THEAD|TBODY|TFOOT)$/i.test(child.tagName)) rows.push(...Array.from(child.children).filter(el => el.tagName === 'TR'));
  }
  return rows;
}

function rowValues(row) {
  let values = Array.from(row.children).filter(el => el.tagName === 'TD' || el.tagName === 'TH').map(el => clean(el.textContent));
  if (/^\d+\.$/.test(values[0] || '')) values = values.slice(1);
  return values;
}

function isStudentHeader(values) {
  const fields = values.map(normalise);
  return fields.includes('surname') && fields.includes('preferred name');
}

function parseStudentTable(table) {
  const rows = directRows(table);
  const headerIndex = rows.findIndex(row => isStudentHeader(rowValues(row)));
  if (headerIndex < 0) return null;
  const headers = rowValues(rows[headerIndex]);
  const surnameIndex = headers.findIndex(h => normalise(h) === 'surname');
  const preferredIndex = headers.findIndex(h => normalise(h) === 'preferred name');
  const students = [];

  for (const row of rows.slice(headerIndex + 1)) {
    const values = rowValues(row);
    if (!values.length) continue;
    const fields = {};
    headers.forEach((field, i) => { fields[field] = values[i] ?? ''; });
    const surname = values[surnameIndex] || '';
    const preferredName = values[preferredIndex] || '';
    if (!surname && !preferredName) continue;
    students.push({ sourceRow: students.length + 1, surname, preferredName, fields, photo: null });
  }
  return { headers, students };
}

function escaped(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function metadataFromText(text) {
  const compact = clean(text);
  const result = {};
  const labels = CLASS_META_LABELS.map(escaped).join('|');
  for (const label of CLASS_META_LABELS) {
    const match = compact.match(new RegExp(escaped(label) + '\\s*:?\\s*(.+?)(?=\\s+(?:' + labels + ')\\s*:|$)', 'i'));
    if (match) result[label] = clean(match[1]);
  }
  return result;
}

function hasMetadata(text) {
  return CLASS_META_LABELS.some(label => new RegExp('\\b' + escaped(label) + '\\b', 'i').test(text));
}

function findClassMetadata(studentTable) {
  let current = studentTable.previousElementSibling;
  for (let steps = 0; current && steps < 20; steps++, current = current.previousElementSibling) {
    const text = clean(current.textContent);
    if (hasMetadata(text)) return metadataFromText(text);
  }
  let ancestor = studentTable.parentElement;
  for (let depth = 0; ancestor && depth < 6; depth++, ancestor = ancestor.parentElement) {
    const text = clean(ancestor.textContent);
    if (hasMetadata(text)) return metadataFromText(text);
  }
  return {};
}

function basename(url) {
  try { return decodeURIComponent(new URL(url, 'https://isams.invalid/').pathname.split('/').pop() || ''); }
  catch { return String(url || '').split(/[\\/]/).pop() || ''; }
}

function imageLabel(img) {
  const parentText = clean(img.parentElement?.textContent || '');
  return clean(img.getAttribute('alt') || img.getAttribute('title') || parentText);
}

function studentNameVariants(student) {
  const surname = normalise(student.surname);
  const preferred = normalise(student.preferredName);
  const legalFirst = normalise(student.fields['First Name'] || student.fields['Forename'] || student.fields['First name']);
  return new Set([
    `${preferred} ${surname}`.trim(), `${surname} ${preferred}`.trim(),
    `${legalFirst} ${surname}`.trim(), `${surname} ${legalFirst}`.trim()
  ].filter(Boolean));
}

function galleryLabelCandidates(label) {
  const cleanLabel = clean(label);
  const withoutPreferred = cleanLabel.replace(/\s*\([^)]*\)\s*$/, '');
  const preferred = cleanLabel.match(/\(([^)]+)\)/)?.[1] || '';
  const candidates = new Set([normalise(cleanLabel), normalise(withoutPreferred)]);
  if (preferred) candidates.add(`${normalise(preferred)} ${normalise(withoutPreferred)}`.trim());
  return candidates;
}

function matchPhotos(students, galleryImages, mimePartsByFile) {
  const used = new Set();
  const matches = [];
  const unmatched = [];
  for (const image of galleryImages) {
    const candidates = galleryLabelCandidates(image.label);
    let found = -1;
    for (let i = 0; i < students.length; i++) {
      if (used.has(i)) continue;
      const variants = studentNameVariants(students[i]);
      if ([...candidates].some(candidate => variants.has(candidate))) {
        if (found !== -1) { found = -2; break; }
        found = i;
      }
    }
    if (found >= 0) {
      used.add(found);
      matches.push({ studentIndex: found, image, part: mimePartsByFile.get(image.file) || null });
    } else unmatched.push({ image, reason: found === -2 ? 'ambiguous' : 'no-name-match' });
  }
  return { matches, unmatched, unphotographed: students.map((_, i) => i).filter(i => !used.has(i)) };
}

function classIdentity(metadata, ordinal) {
  const primary = metadata['Set Code'] || metadata['Set Name'] || '';
  const secondary = metadata['Subject'] || metadata['Grade Group'] || metadata['Year Group'] || '';
  return normalise(`${primary} ${secondary}`) || `class-${ordinal}`;
}

export function parseIsamsHtml(html, mimeParts = []) {
  const document = new DOMParser().parseFromString(html, 'text/html');
  const allTables = Array.from(document.querySelectorAll('table'));
  const candidates = allTables.map((table, index) => ({ table, index, parsed: parseStudentTable(table) })).filter(x => x.parsed);
  if (!candidates.length) throw new Error('No iSAMS student tables were found.');

  const mimePartsByFile = new Map(mimeParts.map(part => [basename(part.location), part]));
  const allElements = Array.from(document.querySelectorAll('table, img'));

  const classes = candidates.map((candidate, classIndex) => {
    const nextTable = candidates[classIndex + 1]?.table;
    const start = allElements.indexOf(candidate.table);
    const end = nextTable ? allElements.indexOf(nextTable) : allElements.length;
    const classImages = allElements.slice(start + 1, end)
      .filter(el => el.tagName === 'IMG')
      .map(img => ({
        src: clean(img.getAttribute('src') || img.getAttribute('data-src')),
        alt: clean(img.getAttribute('alt')),
        title: clean(img.getAttribute('title')),
        label: imageLabel(img),
        file: basename(img.getAttribute('src') || img.getAttribute('data-src'))
      }))
      .filter(image => mimePartsByFile.has(image.file));

    const metadata = findClassMetadata(candidate.table);
    const photoResult = matchPhotos(candidate.parsed.students, classImages, mimePartsByFile);
    photoResult.matches.forEach(match => {
      candidate.parsed.students[match.studentIndex].photo = {
        location: match.image.src,
        file: match.image.file,
        mimePartIndex: match.part?.index ?? null,
        embedded: Boolean(match.part?.bytes)
      };
    });

    return {
      ordinal: classIndex + 1,
      identity: classIdentity(metadata, classIndex + 1),
      metadata,
      headers: candidate.parsed.headers,
      students: candidate.parsed.students,
      photoReport: {
        galleryImages: classImages.length,
        matched: photoResult.matches.length,
        unmatchedImages: photoResult.unmatched,
        studentsWithoutPhoto: photoResult.unphotographed.length
      }
    };
  });

  return {
    classes,
    totals: {
      classes: classes.length,
      students: classes.reduce((n, c) => n + c.students.length, 0),
      galleryImages: classes.reduce((n, c) => n + c.photoReport.galleryImages, 0),
      matchedPhotos: classes.reduce((n, c) => n + c.photoReport.matched, 0)
    }
  };
}
