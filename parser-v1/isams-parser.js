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
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalise(value) {
  return clean(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function parseMimeHeaders(text) {
  const headers = {};
  let current = '';
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (/^[ \t]/.test(line) && current) {
      headers[current] += ' ' + line.trim();
      continue;
    }
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (match) {
      current = match[1].toLowerCase();
      headers[current] = match[2].trim();
    }
  }
  return headers;
}

function decodeQuotedPrintable(text) {
  return text
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function decodeBase64ToBytes(text) {
  const binary = atob(text.replace(/[\r\n\t ]/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeMimeBody(body, encoding) {
  const mode = clean(encoding).toLowerCase();
  if (mode === 'base64') return decodeBase64ToBytes(body);
  if (mode === 'quoted-printable') return decodeQuotedPrintable(body);
  return body;
}

function boundaryFromContentType(contentType) {
  const match = String(contentType || '').match(/boundary\s*=\s*(?:"([^"]+)"|([^;]+))/i);
  return clean(match?.[1] || match?.[2] || '');
}

function splitMimeParts(raw, boundary) {
  const delimiter = '--' + boundary;
  const pieces = raw.split(delimiter);
  const parts = [];
  for (let piece of pieces) {
    piece = piece.replace(/^\r?\n/, '');
    if (!piece || piece.startsWith('--')) continue;
    const separator = piece.search(/\r?\n\r?\n/);
    if (separator < 0) continue;
    const headerText = piece.slice(0, separator);
    const body = piece.slice(separator).replace(/^\r?\n\r?\n/, '');
    const headers = parseMimeHeaders(headerText);
    parts.push({ headers, body });
  }
  return parts;
}

/** Parse the MIME envelope and retain both HTML and embedded binary parts. */
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
  if (htmlPart.transferEncoding === 'base64') {
    html = new TextDecoder('utf-8').decode(decodeBase64ToBytes(htmlPart.body));
  } else if (htmlPart.transferEncoding === 'quoted-printable') {
    html = decodeQuotedPrintable(htmlPart.body);
  } else {
    html = htmlPart.body;
  }

  const binaryParts = parts
    .filter(p => /^image\/(jpeg|jpg)$/i.test(p.contentType))
    .map(p => ({
      index: p.index,
      location: p.location,
      contentType: p.contentType,
      bytes: p.transferEncoding === 'base64' ? decodeMimeBody(p.body, p.transferEncoding) : null
    }));

  return { html, parts, htmlPartIndex: htmlPart.index, binaryParts };
}

function directRows(table) {
  const rows = [];
  for (const child of table.children) {
    if (child.tagName === 'TR') rows.push(child);
    else if (/^(THEAD|TBODY|TFOOT)$/i.test(child.tagName)) {
      rows.push(...Array.from(child.children).filter(el => el.tagName === 'TR'));
    }
  }
  return rows;
}

function rowValues(row) {
  let values = Array.from(row.children)
    .filter(el => el.tagName === 'TD' || el.tagName === 'TH')
    .map(el => clean(el.textContent));

  // iSAMS exports a display-only row number before the actual fields.
  if (/^\d+\.$/.test(values[0] || '')) values = values.slice(1);
  return values;
}

function isStudentHeader(values) {
  const fields = values.map(normalise);
  return fields.includes('surname') && fields.includes('preferred name');
}

function findStudentHeader(table) {
  const rows = directRows(table);
  for (let i = 0; i < rows.length; i++) {
    const values = rowValues(rows[i]);
    if (isStudentHeader(values)) return { rows, index: i, headers: values };
  }
  return null;
}

function findField(headers, wanted) {
  const target = normalise(wanted);
  return headers.findIndex(header => normalise(header) === target);
}

function parseStudentTable(table) {
  const header = findStudentHeader(table);
  if (!header) return null;
  const { rows, index, headers } = header;
  const surnameIndex = findField(headers, 'Surname');
  const preferredIndex = findField(headers, 'Preferred Name');
  const students = [];

  for (const row of rows.slice(index + 1)) {
    const values = rowValues(row);
    if (!values.length) continue;
    const fields = {};
    headers.forEach((field, i) => { fields[field] = values[i] ?? ''; });
    const surname = values[surnameIndex] || '';
    const preferredName = values[preferredIndex] || '';
    if (!surname && !preferredName) continue;
    students.push({
      sourceRow: students.length + 1,
      surname,
      preferredName,
      fields,
      photo: null
    });
  }
  return { headers, students };
}

function metadataFromText(text) {
  const result = {};
  const wanted = new Set(CLASS_META_LABELS.map(normalise));
  const compact = clean(text);
  for (const label of CLASS_META_LABELS) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(escaped + '\\s*:?\\s*(.+?)(?=\\s+(?:' + CLASS_META_LABELS.map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\s*:|$)', 'i');
    const match = compact.match(pattern);
    if (match) result[label] = clean(match[1]);
  }
  return result;
}

function findClassMetadata(studentTable) {
  let current = studentTable.previousElementSibling;
  let steps = 0;
  while (current && steps < 20) {
    const text = clean(current.textContent);
    if (wantedMetadataText(text)) return metadataFromText(text);
    current = current.previousElementSibling;
    steps++;
  }

  let ancestor = studentTable.parentElement;
  for (let depth = 0; ancestor && depth < 6; depth++, ancestor = ancestor.parentElement) {
    const text = clean(ancestor.textContent);
    if (wantedMetadataText(text)) return metadataFromText(text);
  }
  return {};
}

function wantedMetadataText(text) {
  return CLASS_META_LABELS.some(label => new RegExp('\\b' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(text));
}

function basename(url) {
  try { return decodeURIComponent(new URL(url, 'https://isams.invalid/').pathname.split('/').pop() || ''); }
  catch { return String(url || '').split(/[\\/]/).pop() || ''; }
}

function imageReferencesInOrder(root) {
  return Array.from(root.querySelectorAll('img')).map((img, index) => ({
    index,
    src: clean(img.getAttribute('src') || img.getAttribute('data-src')),
    alt: clean(img.getAttribute('alt')),
    title: clean(img.getAttribute('title')),
    label: clean(img.parentElement?.textContent || img.alt || img.title || ''),
    file: basename(img.getAttribute('src') || img.getAttribute('data-src'))
  })).filter(x => x.src);
}

function studentNameVariants(student) {
  const surname = normalise(student.surname);
  const preferred = normalise(student.preferredName);
  const legalFirst = normalise(student.fields['First Name'] || student.fields['Forename'] || student.fields['First name']);
  return new Set([
    `${preferred} ${surname}`.trim(),
    `${surname} ${preferred}`.trim(),
    `${legalFirst} ${surname}`.trim(),
    `${surname} ${legalFirst}`.trim()
  ].filter(Boolean));
}

function galleryLabelCandidates(label) {
  const cleanLabel = clean(label).replace(/\s+/g, ' ');
  const withoutPreferred = cleanLabel.replace(/\s*\([^)]*\)\s*$/, '');
  const preferred = cleanLabel.match(/\(([^)]+)\)/)?.[1] || '';
  const candidates = new Set([normalise(cleanLabel), normalise(withoutPreferred)]);
  if (preferred) {
    const base = normalise(withoutPreferred);
    candidates.add(`${normalise(preferred)} ${base}`.trim());
  }
  return candidates;
}

function matchPhotos(students, galleryImages, mimePartsByFile) {
  const used = new Set();
  const matches = [];
  const unmatched = [];

  for (const image of galleryImages) {
    const imageCandidates = galleryLabelCandidates(image.label);
    let found = -1;
    for (let i = 0; i < students.length; i++) {
      if (used.has(i)) continue;
      const variants = studentNameVariants(students[i]);
      if ([...imageCandidates].some(candidate => variants.has(candidate))) {
        if (found !== -1) { found = -2; break; }
        found = i;
      }
    }
    if (found >= 0) {
      used.add(found);
      matches.push({ studentIndex: found, image, part: mimePartsByFile.get(image.file) || null });
    } else {
      unmatched.push({ image, reason: found === -2 ? 'ambiguous' : 'no-name-match' });
    }
  }

  const unphotographed = students.map((student, i) => used.has(i) ? null : i).filter(i => i !== null);
  return { matches, unmatched, unphotographed };
}

function classIdentity(metadata, students, ordinal) {
  const primary = metadata['Set Code'] || metadata['Set Name'] || '';
  const secondary = metadata['Subject'] || metadata['Grade Group'] || metadata['Year Group'] || '';
  return normalise(`${primary} ${secondary}`) || `class-${ordinal}`;
}

/**
 * Parse all student tables and associate the nearest class metadata plus the
 * images that occur before the next student table. No persistence is performed.
 */
export function parseIamsHtml(html, mimeParts = []) {
  const document = new DOMParser().parseFromString(html, 'text/html');
  const tables = Array.from(document.querySelectorAll('table'));
  const candidates = tables.map((table, index) => ({ table, index, parsed: parseStudentTable(table) })).filter(x => x.parsed);
  if (!candidates.length) throw new Error('No iSAMS student tables were found.');

  const imageRefs = imageReferencesInOrder(document);
  const mimePartsByFile = new Map(mimeParts.map(part => [basename(part.location), part]));
  const classes = candidates.map((candidate, classIndex) => {
    const metadata = findClassMetadata(candidate.table);
    const nextTable = candidates[classIndex + 1]?.table;
    const images = imageRefs.filter(ref => {
      const position = ref.index;
      const firstImg = imageRefs.findIndex(x => x.index >= 0 && x.index >= position);
      void firstImg;
      return true;
    });

    // Restrict gallery images by DOM position. This avoids attaching the next
    // class's photos to the current class when several classes share one file.
    const allElements = Array.from(document.querySelectorAll('table, img'));
    const start = allElements.indexOf(candidate.table);
    const end = nextTable ? allElements.indexOf(nextTable) : allElements.length;
    const classImages = allElements.slice(start + 1, end)
      .filter(el => el.tagName === 'IMG')
      .map(img => imageRefs.find(ref => ref.src === clean(img.getAttribute('src') || img.getAttribute('data-src'))))
      .filter(Boolean)
      .filter(img => mimePartsByFile.has(img.file) || /^image:\/\//i.test(img.src));

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
      identity: classIdentity(metadata, candidate.parsed.students, classIndex + 1),
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
