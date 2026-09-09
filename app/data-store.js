const DB_NAME='isams-seating-planner';
const DB_VERSION=1;
const STORES=['classes','students','rooms','plans','photos','imports'];

function openDb(){return new Promise((resolve,reject)=>{const r=indexedDB.open(DB_NAME,DB_VERSION);r.onerror=()=>reject(r.error||new Error('Could not open local database.'));r.onupgradeneeded=()=>{const db=r.result;for(const name of STORES){if(!db.objectStoreNames.contains(name)){const s=db.createObjectStore(name,{keyPath:'id'});if(name==='students')s.createIndex('classId','classId');if(name==='plans')s.createIndex('classId','classId');if(name==='photos')s.createIndex('studentId','studentId');if(name==='rooms')s.createIndex('name','name',{unique:false})}}};r.onsuccess=()=>resolve(r.result)})}
function tx(store,mode,fn){return openDb().then(db=>new Promise((resolve,reject)=>{const t=db.transaction(store,mode),s=t.objectStore(store);let result;try{result=fn(s)}catch(e){reject(e);return}t.oncomplete=()=>resolve(result);t.onerror=()=>reject(t.error||new Error('Database operation failed.'));t.onabort=()=>reject(t.error||new Error('Database operation aborted.'))}))}
function req(r){return new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})}
const all=store=>tx(store,'readonly',s=>req(s.getAll()));
const get=(store,id)=>tx(store,'readonly',s=>req(s.get(id)));
const put=(store,value)=>tx(store,'readwrite',s=>{s.put(value);return value});
const remove=(store,id)=>tx(store,'readwrite',s=>{s.delete(id)});

export async function listClasses(){return all('classes')}
export async function getClass(id){return get('classes',id)}
export async function getStudents(classId){return tx('students','readonly',s=>req(s.index('classId').getAll(classId)))}
export async function saveClass(record){return put('classes',record)}
export async function saveStudent(record){return put('students',record)}
export async function savePhoto(record){return put('photos',record)}
export async function getPhoto(id){return get('photos',id)}
export async function saveImport(record){return put('imports',record)}

export async function deleteClassPermanently(classId){
  const db=await openDb();
  return new Promise((resolve,reject)=>{
    const t=db.transaction(STORES,'readwrite');
    for(const store of ['classes'])t.objectStore(store).delete(classId);
    for(const store of ['students','plans']){
      const s=t.objectStore(store),idx=s.index('classId');
      idx.openCursor(classId).onsuccess=e=>{const c=e.target.result;if(c){s.delete(c.primaryKey);c.continue()}};
    }
    const ps=t.objectStore('photos'),idx=ps.index('studentId');
    const ss=t.objectStore('students'),cursor=ss.index('classId').openCursor(classId);cursor.onsuccess=e=>{const c=e.target.result;if(c){idx.openCursor(c.primaryKey).onsuccess=x=>{const p=x.target.result;if(p)ps.delete(p.primaryKey)};c.continue()}};
    t.oncomplete=()=>resolve();t.onerror=()=>reject(t.error||new Error('Permanent deletion failed.'));t.onabort=()=>reject(t.error||new Error('Permanent deletion failed.'));
  });
}
export async function clearAllData(){const db=await openDb();return new Promise((resolve,reject)=>{const t=db.transaction(STORES,'readwrite');STORES.forEach(n=>t.objectStore(n).clear());t.oncomplete=resolve;t.onerror=()=>reject(t.error);t.onabort=()=>reject(t.error)})}
