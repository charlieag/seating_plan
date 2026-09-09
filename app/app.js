import {parseMhtml,parseIsamsHtml,normalise} from '../parser-v2/isams-parser.js';
import {listClasses,getStudents,saveClass,saveStudent,savePhoto,saveImport,deleteClassPermanently} from './data-store.js';

const $=s=>document.querySelector(s), fileInput=$('#file'), statusEl=$('#status'), preview=$('#preview'), library=$('#library');
let parsed=null, mimeMap=new Map(), selected=new Set();
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid=()=>crypto.randomUUID();
const dateKey=s=>normalise(s.fields?.['Date of Birth']||s.fields?.['DOB']||'');
const studentKey=s=>`${normalise(s.surname)}|${normalise(s.preferredName)}|${dateKey(s)}`;
const looseStudentKey=s=>`${normalise(s.surname)}|${normalise(s.preferredName)}`;
function classKey(c){return `${normalise(c.metadata['Set Code']||c.metadata['Set Name']||`class-${c.ordinal}`)}|${normalise(c.metadata['Subject']||'')}|${normalise(c.metadata['Grade Group']||'')}`}
function photoPart(c,s){if(!s.photo?.file)return null;return mimeMap.get(s.photo.file)||null}
function blobFromPart(p){return p?.bytes?new Blob([p.bytes],{type:p.contentType||'image/jpeg'}):null}
function setStatus(text,kind=''){statusEl.className='status '+kind;statusEl.textContent=text}
function renderPreview(){
  if(!parsed){preview.innerHTML='<div class="empty">Choose an iSAMS MHTML export to begin.</div>';return}
  const classes=parsed.classes.filter((_,i)=>selected.has(i));
  preview.innerHTML=`<div class="preview-head"><div><h2>Import preview</h2><p>Review the classes before anything is stored locally.</p></div><div><b>${classes.length}</b> of ${parsed.classes.length} classes selected</div></div>${parsed.classes.map((c,i)=>classCard(c,i)).join('')}<div class="import-actions"><button id="confirm" ${classes.length?'':'disabled'}>Confirm import</button><button class="secondary" id="cancel">Cancel</button></div>`;
  preview.querySelectorAll('[data-class]').forEach(el=>el.addEventListener('change',()=>{const i=Number(el.dataset.class);el.checked?selected.add(i):selected.delete(i);renderPreview()}));
  $('#confirm')?.addEventListener('click',confirmImport);$('#cancel')?.addEventListener('click',()=>{parsed=null;selected.clear();fileInput.value='';preview.innerHTML='';setStatus('Import cancelled.')});
}
function classCard(c,i){const checked=selected.has(i),p=c.photoReport;return `<article class="import-card ${checked?'selected':''}"><label class="class-select"><input type="checkbox" data-class="${i}" ${checked?'checked':''}><span><strong>${esc(c.metadata['Set Name']||`Class ${c.ordinal}`)}</strong><small>${esc(c.metadata['Subject']||'')} · ${esc(c.metadata['Grade Group']||'')}</small></span><b>${c.students.length} students</b></label><div class="stats"><span>${p.matched}/${c.students.length} photos matched</span><span>${p.unmatchedImages.length} unmatched gallery photos</span><span>${Object.keys(c.metadata).length} metadata fields</span></div><details><summary>Students</summary><div class="mini-students">${c.students.map(s=>`<span>${esc([s.preferredName,s.surname].filter(Boolean).join(' '))}${s.photo?' ✓':' '}</span>`).join('')}</div></details></article>`}
async function loadLibrary(){const classes=await listClasses();if(!classes.length){library.innerHTML='<div class="empty">No imported classes yet.</div>';return}library.innerHTML=`<div class="library-head"><div><h2>Imported classes</h2><p>Stored locally in this browser.</p></div><span>${classes.length} classes</span></div>${classes.sort((a,b)=>a.name.localeCompare(b.name)).map(c=>`<article class="library-card"><div><strong>${esc(c.name)}</strong><small>${esc(c.subject||'')} · ${esc(c.gradeGroup||'')}</small></div><div class="library-meta"><span>${c.studentCount} students</span><span>Imported ${new Date(c.updatedAt).toLocaleDateString()}</span><button class="danger" data-delete="${esc(c.id)}" data-name="${esc(c.name)}">Delete permanently</button></div></article>`).join('')}`;library.querySelectorAll('[data-delete]').forEach(b=>b.addEventListener('click',async()=>{if(!confirm(`Permanently delete “${b.dataset.name}” and its students, photos and plans? This cannot be undone.`))return;await deleteClassPermanently(b.dataset.delete);setStatus('Class permanently deleted.','ok');loadLibrary()}))}
async function confirmImport(){const indices=[...selected].sort((a,b)=>a-b);if(!indices.length)return;$('#confirm').disabled=true;setStatus('Importing…');let imported=0,updated=0,newStudents=0,removed=0;
  try{
    for(const i of indices){const c=parsed.classes[i],identity=classKey(c),existing=(await listClasses()).find(x=>x.importKey===identity);const classId=existing?.id||uid();const old=existing?await getStudents(classId):[];const oldByKey=new Map(old.map(s=>[studentKey(s),s])),oldByLoose=new Map(old.map(s=>[looseStudentKey(s),s]));const seen=new Set();
      for(const s of c.students){const match=oldByKey.get(studentKey(s))||oldByLoose.get(looseStudentKey(s));const studentId=match?.id||uid();const record={id:studentId,classId,surname:s.surname,preferredName:s.preferredName,fields:s.fields,sourceRow:s.sourceRow,status:'active',lastImportedAt:new Date().toISOString(),photoId:match?.photoId||null};
        if(match)updated++;else newStudents++;seen.add(studentId);
        const part=photoPart(c,s);if(part){const photoId=match?.photoId||uid();record.photoId=photoId;await savePhoto({id:photoId,studentId, classId,blob:blobFromPart(part),file:s.photo.file,location:s.photo.location,updatedAt:new Date().toISOString()})}await saveStudent(record);
      }
      for(const s of old){if(!seen.has(s.id)&&s.status!=='missing'){s.status='missing';s.missingSince=new Date().toISOString();await saveStudent(s);removed++}}
      await saveClass({id:classId,importKey:identity,name:c.metadata['Set Name']||`Class ${c.ordinal}`,subject:c.metadata['Subject']||'',gradeGroup:c.metadata['Grade Group']||'',setCode:c.metadata['Set Code']||'',teacher:c.metadata['Teacher']||'',metadata:c.metadata,headers:c.headers,studentCount:c.students.length,source:'iSAMS MHTML',updatedAt:new Date().toISOString()});imported++;
    }
    await saveImport({id:uid(),fileName:parsed.fileName,classes:indices.length,importedAt:new Date().toISOString()});setStatus(`Import complete: ${imported} class${imported===1?'':'es'}, ${newStudents} new students, ${updated} updated${removed?`, ${removed} missing students retained`:''}.`,'ok');parsed=null;selected.clear();fileInput.value='';preview.innerHTML='';await loadLibrary();
  }catch(e){console.error(e);setStatus('Import failed: '+(e.message||e),'bad');$('#confirm').disabled=false}
}
fileInput.addEventListener('change',async()=>{const f=fileInput.files?.[0];if(!f)return;try{setStatus(`Reading ${f.name}…`);const raw=await f.text(),m=parseMhtml(raw),r=parseIsamsHtml(m.html,m.binaryParts);parsed={...r,fileName:f.name};mimeMap=new Map(m.binaryParts.map(p=>[decodeURIComponent(p.location.split('/').pop()),p]));selected=new Set(r.classes.map((_,i)=>i));setStatus(`${r.classes.length} classes and ${r.totals.students} students ready for review.`,'ok');renderPreview()}catch(e){console.error(e);setStatus('Could not parse this MHTML: '+(e.message||e),'bad');preview.innerHTML='<div class="empty">No data was imported.</div>'}});
loadLibrary();
