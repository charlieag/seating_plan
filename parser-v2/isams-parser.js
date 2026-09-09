/* iSAMS MHTML parser — Build 1.1.5 */
const META=['Set Name','Set Code','Teacher','Linked Teachers','Subject','Grade Group','Set Block','Set Number','Year Group','Form','Academic Year'];
const clean=v=>String(v??'').replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();
const SPECIAL={'ł':'l','Ł':'L','ø':'o','Ø':'O','đ':'d','Đ':'D','ð':'d','Ð':'D','þ':'th','Þ':'TH','ħ':'h','Ħ':'H','ı':'i','İ':'I'};
export const normalise=v=>clean(v).replace(/[łŁøØđĐðÐþÞħĦıİ]/g,c=>SPECIAL[c]).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
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
function galleryLabel(img){const p=img.closest('td')||img.parentElement;if(!p)return'';const d=[...p.childNodes].filter(n=>n.nodeType===Node.TEXT_NODE).map(n=>clean(n.nodeValue)).filter(Boolean).join(' ');return d||clean(p.textContent).replace(/\bGrade\s+.*$/i,'').trim()}
function studentNames(s){const surname=normalise(s.surname),preferred=normalise(s.preferredName),first=normalise(s.fields['First Name']||s.fields['First name']||s.fields['Forename']||'');const out=new Set();for(const a of [preferred,first].filter(Boolean)){out.add(a+' '+surname);out.add(surname+' '+a)}return out}
function galleryNames(v){
  v=clean(v);
  const bracket=v.match(/\(([^()]*)\)\s*$/)?.[1]?.trim()||'';
  const main=v.replace(/\s*\([^()]*\)\s*$/,'').trim();
  const tokens=main.split(/\s+/).filter(Boolean);
  const s=new Set([normalise(v),normalise(main)]);
  if(tokens.length>1)s.add(normalise(tokens.at(-1)+' '+tokens.slice(0,-1).join(' ')));
  if(bracket){
    // iSAMS commonly uses: Legal Firstname Surname (Preferred Name)
    // The preferred name in brackets should therefore be combined with
    // the surname from the main name, e.g. "Charles Gatehouse (Charlie)"
    // -> "Charlie Gatehouse".
    if(tokens.length>1){
      const surname=tokens.at(-1);
      s.add(normalise(bracket+' '+surname));
      s.add(normalise(surname+' '+bracket));
    }
    s.add(normalise(bracket));
  }
  return s;
}
function photos(students,images,map){const used=new Set(),matches=[],unmatched=[];for(const image of images){const cs=galleryNames(image.label);let hit=-1;for(let i=0;i<students.length;i++){if(used.has(i))continue;if([...cs].some(x=>studentNames(students[i]).has(x))){if(hit!==-1){hit=-2;break}hit=i}}if(hit>=0){used.add(hit);matches.push({studentIndex:hit,image,part:map.get(image.file)||null})}else unmatched.push({image,reason:hit===-2?'ambiguous':'no-name-match'})}return{matches,unmatched,unphotographed:students.map((_,i)=>i).filter(i=>!used.has(i))}}
export function parseIsamsHtml(html,mimeParts=[]){const doc=new DOMParser().parseFromString(html,'text/html'),tables=[...doc.querySelectorAll('table')],candidates=tables.map((table,index)=>({table,index,parsed:studentTable(table)})).filter(x=>x.parsed);if(!candidates.length)throw Error('No iSAMS student tables were found.');const map=new Map(mimeParts.map(p=>[base(p.location),p])),elements=[...doc.querySelectorAll('table, img')],metas=metadataTables(doc);const classes=candidates.map((c,i)=>{const start=elements.indexOf(c.table),end=candidates[i+1]?elements.indexOf(candidates[i+1].table):elements.length;const images=elements.slice(start+1,end).filter(x=>x.tagName==='IMG').map(img=>{const src=clean(img.getAttribute('src')||img.getAttribute('data-src'));return{src,alt:clean(img.getAttribute('alt')),title:clean(img.getAttribute('title')),label:galleryLabel(img),file:base(src)}}).filter(x=>map.has(x.file));const metadata=meta(metadataBefore(c.table,metas)),pr=photos(c.parsed.students,images,map);pr.matches.forEach(m=>c.parsed.students[m.studentIndex].photo={location:m.image.src,file:m.image.file,mimePartIndex:m.part?.index??null,embedded:Boolean(m.part?.bytes)});return{ordinal:i+1,identity:normalise(`${metadata['Set Code']||metadata['Set Name']||''} ${metadata['Subject']||metadata['Grade Group']||''}`)||`class-${i+1}`,metadata,headers:c.parsed.headers,students:c.parsed.students,photoReport:{galleryImages:images.length,matched:pr.matches.length,unmatchedImages:pr.unmatched,studentsWithoutPhoto:pr.unphotographed.length}}});return{classes,totals:{classes:classes.length,students:classes.reduce((n,c)=>n+c.students.length,0),galleryImages:classes.reduce((n,c)=>n+c.photoReport.galleryImages,0),matchedPhotos:classes.reduce((n,c)=>n+c.photoReport.matched,0)}}}
export const parseIamsHtml=parseIsamsHtml;
