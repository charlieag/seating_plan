/* iSAMS MHTML parser — Build 1.1.6 */
const META=['Set Name','Set Code','Teacher','Linked Teachers','Subject','Grade Group','Set Block','Set Number','Year Group','Form','Academic Year'];
const clean=v=>String(v??'').replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();
const SPECIAL={'ł':'l','Ł':'L','ø':'o','Ø':'O','đ':'d','Đ':'D','ð':'d','Ð':'D','þ':'th','Þ':'TH','ħ':'h','Ħ':'H','ı':'i','İ':'I','ß':'ss','ẞ':'SS','æ':'ae','Æ':'AE','œ':'oe','Œ':'OE'};
export const normalise=v=>clean(v).replace(/[łŁøØđĐðÐþÞħĦıİßẞæÆœŒ]/g,c=>SPECIAL[c]).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
function tokens(v){return normalise(v).split(/\s+/).filter(Boolean)}
function headers(s){const o={};let k='';for(const l of s.replace(/\r\n/g,'\n').split('\n')){if(/^[ \t]/.test(l)&&k){o[k]+=' '+l.trim();continue}const m=l.match(/^([^:]+):\s*(.*)$/);if(m){k=m[1].toLowerCase();o[k]=m[2].trim()}}return o}
function qp(s){return s.replace(/=\r?\n/g,'').replace(/=([0-9a-f]{2})/gi,(_,h)=>String.fromCharCode(parseInt(h,16)))}
function b64(s){const x=atob(s.replace(/[\r\n\t ]/g,''));const a=new Uint8Array(x.length);for(let i=0;i<x.length;i++)a[i]=x.charCodeAt(i);return a}
function boundary(ct){const m=String(ct||'').match(/boundary\s*=\s*(?:"([^"]+)"|([^;]+))/i);return clean(m?.[1]||m?.[2]||'')}
function split(raw,b){return raw.split('--'+b).flatMap(piece=>{if(/^--\s*$/.test(piece.trim()))return[];piece=piece.replace(/^\r?\n/,'');const n=piece.search(/\r?\n\r?\n/);if(n<0)return[];return[{headers:headers(piece.slice(0,n)),body:piece.slice(n).replace(/^\r?\n\r?\n/,'')}]})}
export function parseMhtml(raw){if(!raw?.trim())throw Error('The selected file is empty.');const n=raw.search(/\r?\n\r?\n/);if(n<0)throw Error('Invalid MIME header.');const top=headers(raw.slice(0,n)),b=boundary(top['content-type']);if(!b)throw Error('No MHTML MIME boundary found.');const parts=split(raw,b).map((p,index)=>({index,headers:p.headers,contentType:clean(p.headers['content-type']).toLowerCase(),location:clean(p.headers['content-location']),transferEncoding:clean(p.headers['content-transfer-encoding']).toLowerCase(),body:p.body}));const h=parts.find(p=>p.contentType.startsWith('text/html'));if(!h)throw Error('No text/html part found.');let html=h.body;if(h.transferEncoding==='base64')html=new TextDecoder().decode(b64(h.body));else if(h.transferEncoding==='quoted-printable')html=qp(h.body);return{html,parts,htmlPartIndex:h.index,binaryParts:parts.filter(p=>/^image\/(jpeg|jpg)$/i.test(p.contentType)).map(p=>({...p,bytes:p.transferEncoding==='base64'?b64(p.body):null}))}}
function rows(t){const out=[];for(const x of t.children){if(x.tagName==='TR')out.push(x);else if(/^(TBODY|THEAD|TFOOT)$/i.test(x.tagName))out.push(...[...x.children].filter(y=>y.tagName==='TR'))}return out}
function cells(r){return[...r.children].filter(x=>/^(TD|TH)$/i.test(x.tagName))}
function vals(r){let v=cells(r).map(x=>clean(x.textContent));if(/^\d+\.$/.test(v[0]||''))v=v.slice(1);return v}
function studentTable(t){const rs=rows(t),hi=rs.findIndex(r=>{const v=vals(r).map(normalise);return v.includes('surname')&&v.includes('preferred name')});if(hi<0)return null;let hs=vals(rs[hi]);if(!normalise(hs[0]))hs=hs.slice(1);const si=hs.findIndex(x=>normalise(x)==='surname'),pi=hs.findIndex(x=>normalise(x)==='preferred name');if(si<0||pi<0)return null;const students=[];for(const r of rs.slice(hi+1)){const v=vals(r);if(!v.length)continue;const fields={};hs.forEach((h,i)=>fields[h]=v[i]??'');if(!v[si]&&!v[pi])continue;students.push({sourceRow:students.length+1,surname:v[si]||'',preferredName:v[pi]||'',fields,photo:null})}return{headers:hs,students}}
function metadataTables(doc){return[...doc.querySelectorAll('table')].filter(e=>{const t=normalise(e.textContent);return t.includes('set name')&&(t.includes('teacher')||t.includes('set code'))&&t.length<1400})}
function metadataBefore(table,ms){let best=null;for(const m of ms){if(m.compareDocumentPosition(table)&Node.DOCUMENT_POSITION_FOLLOWING)best=m}return best}
function meta(el){const t=clean(el?.textContent||''),o={};if(!t)return o;const escaped=META.map(x=>x.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));for(let i=0;i<META.length;i++){const next=escaped.filter((_,j)=>j!==i);const re=new RegExp(escaped[i]+'\\s*:?\\s*(.*?)(?=\\s*(?:'+next.join('|')+')\\s*:?|$)','i');const m=t.match(re);if(m)o[META[i]]=clean(m[1])}return o}
function base(u){try{return decodeURIComponent(new URL(u,'https://isams.invalid/').pathname.split('/').pop()||'')}catch{return String(u||'').split(/[\\/]/).pop()||''}}

// iSAMS gallery cells contain the pupil label as a text node, followed by
// a <b>Grade ...</b>. Remove presentation-only suffixes without depending
// on exact whitespace in the export.
function galleryLabel(img){
  const p=img.closest('td')||img.parentElement;
  if(!p)return'';
  const clone=p.cloneNode(true);
  clone.querySelectorAll('b').forEach(e=>e.remove());
  let text=clean(clone.textContent);
  text=text.replace(/\s*\|\s*$/,'').trim();
  return text;
}

function surnameVariants(s){
  const raw=clean(s);
  const n=normalise(raw);
  const out=new Set(n?[n]:[]);
  // Treat punctuation/hyphens as equivalent, and allow compound surnames.
  const ts=tokens(raw);
  if(ts.length>1){
    out.add(ts.join(' '));
    for(let k=2;k<=Math.min(3,ts.length);k++)out.add(ts.slice(-k).join(' '));
  }
  return out;
}

function firstNameVariants(s){
  const out=new Set();
  for(const value of [s.preferredName,s.fields['First Name'],s.fields['First name'],s.fields['Forename']]){
    const n=normalise(value);
    if(!n)continue;
    out.add(n);
    const ts=n.split(' ');
    if(ts.length>1)out.add(ts[0]);
  }
  return out;
}

function studentIdentity(s){
  return {surname:surnameVariants(s.surname),first:firstNameVariants(s)};
}

function galleryIdentity(v){
  v=clean(v);
  const bracket=v.match(/\(([^()]*)\)\s*$/)?.[1]?.trim()||'';
  const main=v.replace(/\s*\([^()]*\)\s*$/,'').trim();
  const mt=tokens(main), bt=tokens(bracket);
  const surname=new Set(), first=new Set(), full=new Set();
  if(bracket)for(const x of bt)first.add(x);
  if(mt.length){
    // A comma explicitly signals surname-first ordering.
    const comma=/,/.test(main);
    if(comma){
      const pieces=main.split(',').map(clean);
      if(pieces[0])for(const x of tokens(pieces[0]))surname.add(x);
      if(pieces[1])for(const x of tokens(pieces[1]))first.add(x);
    }
    // The last token is the normal surname candidate.
    surname.add(mt.at(-1));
    if(mt.length>1)first.add(mt[0]);
    // Keep the whole normalised label for exact full-name matches.
    full.add(normalise(main));
    full.add(normalise(v));
  }
  // Also retain contiguous two-token windows, useful when iSAMS includes
  // legal/middle names: "Marcus Jinghao Li" -> "Marcus Li".
  for(let i=0;i<mt.length;i++)for(let j=i+1;j<mt.length;j++){
    if(j-i<=2)full.add(`${mt[i]} ${mt[j]}`);
  }
  return {surname,first,full,bracket:Boolean(bracket)};
}

function intersection(a,b){for(const x of a)if(b.has(x))return true;return false}
function exactFullMatch(student,gi){
  const id=studentIdentity(student);
  for(const first of id.first)for(const surname of id.surname){
    if(gi.full.has(`${first} ${surname}`)||gi.full.has(`${surname} ${first}`))return true;
  }
  return false;
}

function scorePhoto(student,label){
  const si=studentIdentity(student),gi=galleryIdentity(label);
  const surname=intersection(si.surname,gi.surname);
  const first=intersection(si.first,gi.first);
  if(!surname)return 0;
  if(first)return gi.bracket?100:95;
  if(exactFullMatch(student,gi))return 90;
  return 0;
}

function photos(students,images,map){
  const used=new Set(),matches=[],unmatched=[];
  for(const image of images){
    let bestScore=0,best=[];
    for(let i=0;i<students.length;i++){
      if(used.has(i))continue;
      const score=scorePhoto(students[i],image.label);
      if(score>bestScore){bestScore=score;best=[i]}
      else if(score>0&&score===bestScore)best.push(i);
    }
    // Only accept a high-confidence, unique match. This deliberately avoids
    // guessing when two pupils could plausibly fit the same gallery label.
    if(bestScore>=90&&best.length===1){
      const i=best[0];used.add(i);matches.push({studentIndex:i,image,score:bestScore,part:map.get(image.file)||null});
    }else{
      unmatched.push({image,reason:best.length>1?'ambiguous':'no-name-match',candidates:best.map(i=>({studentIndex:i,score:bestScore}))});
    }
  }
  return{matches,unmatched,unphotographed:students.map((_,i)=>i).filter(i=>!used.has(i))}
}

export function parseIsamsHtml(html,mimeParts=[]){
  const doc=new DOMParser().parseFromString(html,'text/html'),tables=[...doc.querySelectorAll('table')],candidates=tables.map((table,index)=>({table,index,parsed:studentTable(table)})).filter(x=>x.parsed);
  if(!candidates.length)throw Error('No iSAMS student tables were found.');
  const map=new Map(mimeParts.map(p=>[base(p.location),p])),elements=[...doc.querySelectorAll('table, img')],metas=metadataTables(doc);
  const classes=candidates.map((c,i)=>{
    const start=elements.indexOf(c.table),end=candidates[i+1]?elements.indexOf(candidates[i+1].table):elements.length;
    const images=elements.slice(start+1,end).filter(x=>x.tagName==='IMG').map(img=>{const src=clean(img.getAttribute('src')||img.getAttribute('data-src'));return{src,alt:clean(img.getAttribute('alt')),title:clean(img.getAttribute('title')),label:galleryLabel(img),file:base(src)}}).filter(x=>map.has(x.file));
    const metadata=meta(metadataBefore(c.table,metas)),pr=photos(c.parsed.students,images,map);
    pr.matches.forEach(m=>c.parsed.students[m.studentIndex].photo={location:m.image.src,file:m.image.file,mimePartIndex:m.part?.index??null,embedded:Boolean(m.part?.bytes),matchScore:m.score});
    return{ordinal:i+1,identity:normalise(`${metadata['Set Code']||metadata['Set Name']||''} ${metadata['Subject']||metadata['Grade Group']||''}`)||`class-${i+1}`,metadata,headers:c.parsed.headers,students:c.parsed.students,photoReport:{galleryImages:images.length,matched:pr.matches.length,unmatchedImages:pr.unmatched,studentsWithoutPhoto:pr.unphotographed.length}};
  });
  return{classes,totals:{classes:classes.length,students:classes.reduce((n,c)=>n+c.students.length,0),galleryImages:classes.reduce((n,c)=>n+c.photoReport.galleryImages,0),matchedPhotos:classes.reduce((n,c)=>n+c.photoReport.matched,0)}}
}
export const parseIamsHtml=parseIsamsHtml;
