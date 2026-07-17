// ---------- FIREBASE INIT ----------
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

// IMPORTANT: some networks/routers/browser privacy settings silently block Firestore's
// default streaming connection (WebChannel). When that happens, writes just hang forever
// with no error — which is exactly the symptom we were chasing. Forcing long-polling makes
// Firestore fall back to plain HTTP requests, which get through almost everywhere.
db.settings({
  experimentalAutoDetectLongPolling: true,
  useFetchStreams: false
});

const LOGIN_DOMAIN_SUFFIX = "@jiox.net"; // usernames are stored as username@jiox.net in Firebase Auth

// ---------- SAVE TIMEOUT WRAPPER ----------
// Wrap any Firestore write in this so it can never hang silently forever again.
// If Firebase doesn't respond within TIMEOUT_MS, this rejects with a clear error
// instead of leaving the button stuck on "Saving…" with no explanation.
const SAVE_TIMEOUT_MS = 12000;
function withTimeout(promise, label){
  return Promise.race([
    promise,
    new Promise((_, reject)=> setTimeout(()=> reject(new Error(
      `${label||'Save'} timed out after ${SAVE_TIMEOUT_MS/1000}s — check your internet connection and try again.`
    )), SAVE_TIMEOUT_MS))
  ]);
}

// ---------- SMALL HELPERS ----------
function toast(msg, type){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.background = type==='error' ? 'var(--red)' : type==='success' ? 'var(--green)' : 'var(--navy)';
  t.classList.add('show');
  clearTimeout(t._hideTimer);
  t._hideTimer = setTimeout(()=>t.classList.remove('show'), type==='error' ? 4500 : 2800);
}
function showLoading(msg){
  document.getElementById('loadingText').textContent = msg || 'Saving…';
  document.getElementById('loadingOverlay').classList.add('show');
}
function hideLoading(){
  document.getElementById('loadingOverlay').classList.remove('show');
}
const CATEGORY_ORDER = ['Vegetables & Produce','Meat & Poultry','Dairy','General / Canned Goods','Other'];
function categoryBucket(cat){
  return CATEGORY_ORDER.includes(cat) ? cat : 'Other';
}
function escapeHtml(s){
  return (s||'').toString().replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}
function normalize(s){ return (s||'').toString().toLowerCase().replace(/[^a-z0-9]/g,''); }
function fmtDate(iso){
  if(!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'});
}
function todayISO(){ return new Date().toISOString().slice(0,10); }

function resizeImage(file, maxDim){
  return new Promise((resolve,reject)=>{
    const reader = new FileReader();
    reader.onload = (e)=>{
      const img = new Image();
      img.onload = ()=>{
        let { width, height } = img;
        if(width > maxDim || height > maxDim){
          const scale = maxDim / Math.max(width, height);
          width = Math.round(width*scale); height = Math.round(height*scale);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(img,0,0,width,height);
        resolve(canvas.toDataURL('image/jpeg', 0.7));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ---------- LOGIN ----------
document.getElementById('loginBtn').onclick = async ()=>{
  const user = document.getElementById('loginUser').value.trim();
  const pass = document.getElementById('loginPass').value;
  const email = user.includes('@') ? user : user + LOGIN_DOMAIN_SUFFIX;
  const loginBtn = document.getElementById('loginBtn');
  loginBtn.disabled = true;
  const originalText = loginBtn.textContent;
  loginBtn.textContent = 'Signing in…';
  try{
    const result = await withTimeout(auth.signInWithEmailAndPassword(email, pass), 'Sign in');
    console.log('[auth] Signed in OK as', result.user.email, 'uid:', result.user.uid);
    document.getElementById('loginError').style.display = 'none';
  }catch(e){
    console.error('[auth] Sign in failed:', e);
    document.getElementById('loginError').style.display = 'block';
    document.getElementById('loginError').textContent = e.message.replace('Firebase: ','');
  }finally{
    loginBtn.disabled = false;
    loginBtn.textContent = originalText;
  }
};
document.getElementById('logoutBtn').onclick = ()=> auth.signOut();

auth.onAuthStateChanged(user=>{
  if(user){
    console.log('[auth] onAuthStateChanged: logged in as', user.email, 'uid:', user.uid);
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('appScreen').style.display = 'block';
    startListeners();
  }else{
    console.log('[auth] onAuthStateChanged: logged out');
    document.getElementById('loginScreen').style.display = 'flex';
    document.getElementById('appScreen').style.display = 'none';
  }
});

// ---------- TABS ----------
document.querySelectorAll('.tab').forEach(tab=>{
  tab.onclick = ()=>{
    document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('view-'+tab.dataset.view).classList.add('active');
  };
});

// ================= CUSTOMERS =================
let customers = [];
let custPendingShots = [];
let selectedCustId = null;

function startListeners(){
  console.log('[listeners] Starting Firestore listeners…');
  db.collection('customers').onSnapshot(snap=>{
    customers = [];
    snap.forEach(doc=> customers.push({ id: doc.id, ...doc.data() }));
    console.log('[listeners] customers synced:', customers.length, 'records');
    renderCustomerLists();
  }, err=>{
    console.error('[listeners] customers listener FAILED:', err);
    toast('Could not load customer data: '+err.message, 'error');
  });
  db.collection('groceryItems').onSnapshot(snap=>{
    groceryItems = [];
    snap.forEach(doc=> groceryItems.push({ id: doc.id, ...doc.data() }));
    console.log('[listeners] groceryItems synced:', groceryItems.length, 'records');
    checkAutoReorder();
    renderGrocery();
  }, err=>{
    console.error('[listeners] groceryItems listener FAILED:', err);
    toast('Could not load grocery data: '+err.message, 'error');
  });
  db.collection('expenses').orderBy('date','desc').onSnapshot(snap=>{
    expenses = [];
    snap.forEach(doc=> expenses.push({ id: doc.id, ...doc.data() }));
    console.log('[listeners] expenses synced:', expenses.length, 'records');
    renderExpenses();
  }, err=>{
    console.error('[listeners] expenses listener FAILED:', err);
    toast('Could not load expense data: '+err.message, 'error');
  });
  db.collection('notes').orderBy('date','desc').onSnapshot(snap=>{
    notes = [];
    snap.forEach(doc=> notes.push({ id: doc.id, ...doc.data() }));
    console.log('[listeners] notes synced:', notes.length, 'records');
    renderNotes();
  }, err=>{
    console.error('[listeners] notes listener FAILED:', err);
    toast('Could not load notes: '+err.message, 'error');
  });
  startIncomingOrdersListener();
}

let lastSearchRan = false;

function renderCustomerLists(){
  // Re-run search results with fresh data (e.g. after a delete or edit) if a search is active.
  if(lastSearchRan) runCustomerSearch();
}

function nameColorClass(count){
  if(count >= 2) return 'name-red';
  if(count === 1) return 'name-yellow';
  return 'name-green';
}

const STATUS_LABELS = {
  trusted:{label:'Trusted customer', cls:'trusted'},
  repeat:{label:'Repeat customer', cls:'repeat'},
  onetime:{label:'One-time dispute', cls:'onetime'},
  review:{label:'Under review', cls:'review'},
  fraud:{label:'Repeat fraudulent customer', cls:'fraud'},
  blacklist:{label:'Blacklisted customer', cls:'blacklist'}
};
function statusPillHtml(tag){
  if(!tag || !STATUS_LABELS[tag]) return '';
  const s = STATUS_LABELS[tag];
  return `<span class="status-pill ${s.cls}">${escapeHtml(s.label)}</span>`;
}
function starRatingHtml(rating){
  rating = parseInt(rating)||0;
  if(!rating) return '';
  let html = '<span class="star-rating">';
  for(let i=1;i<=5;i++) html += `<span class="${i<=rating?'filled':''}">★</span>`;
  html += '</span>';
  return html;
}

function primaryRestaurant(c){
  if(c.restaurant) return c.restaurant;
  const orders = c.orders || [];
  if(!orders.length) return '';
  const sorted = [...orders].sort((a,b)=> new Date(b.date||0) - new Date(a.date||0));
  return sorted[0].restaurant || '';
}
function safetyLevel(c){
  const n = (c.incidents||[]).length;
  // Manual negative tags always win, regardless of incident count.
  if(c.statusTag==='blacklist' || c.statusTag==='fraud') return {level:'red', label:'Prohibited'};
  if(c.statusTag==='review') return {level:'yellow', label:'Doubt'};
  // Any cancelled/error/comment/refund incident on file makes the profile non-green — a prior
  // "trusted" or "repeat" tag must NEVER hide real order history. Actual incidents are the source
  // of truth, not a manual tag that may have been set before the bad order came in.
  if(n>=2) return {level:'red', label:'Prohibited'};
  if(n===1) return {level:'yellow', label:'Doubt'};
  if(c.statusTag==='onetime') return {level:'yellow', label:'Doubt'};
  return {level:'green', label:'Safe'};
}
function safetyBadgeHtml(c){
  const s = safetyLevel(c);
  return `<span class="safety-badge safety-${s.level}">${s.label}</span>`;
}

function custRowHtml(c, selectable){
  const count = (c.incidents||[]).length;
  const colorClass = nameColorClass(count);
  let tag = '';
  if(count >= 2) tag = `<span class="stamp stamp-red" style="margin-left:8px;">Repeated</span>`;
  else if(count === 1) tag = `<span class="stamp stamp-gold" style="margin-left:8px;">Defaulter</span>`;
  const rest = primaryRestaurant(c);
  const restTag = `<span class="rest-tag${rest?'':' rest-tag-empty'}">${rest?escapeHtml(rest):'No restaurant set'}</span>`;
  return `<div class="cust-row" data-cust-id="${c.id}">
    ${selectable ? `<input type="checkbox" class="cust-select-box" data-select-id="${c.id}" />` : ''}
    <div class="cust-row-info">
      <div style="margin-bottom:4px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;">${safetyBadgeHtml(c)}</div>
      <div class="name ${colorClass}">${escapeHtml(c.name)} ${restTag}${tag}</div>
      <div class="meta">${escapeHtml(c.phone||'')}${c.email?' · '+escapeHtml(c.email):''}</div>
      <div style="margin-top:5px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">${statusPillHtml(c.statusTag)}${starRatingHtml(c.rating)}</div>
    </div>
    ${count>0 ? `<span class="count-badge">${count} incident${count>1?'s':''}</span>` : ''}
  </div>`;
}

function runCustomerSearch(){
  const raw = document.getElementById('custSearch').value.trim();
  const q = normalize(raw);
  const resultsEl = document.getElementById('custSearchResults');
  if(!q){
    resultsEl.innerHTML = '<div class="empty">Type a name, phone, or email above and tap Search to see matching customers.</div>';
    lastSearchRan = false;
    return;
  }
  lastSearchRan = true;
  const filtered = customers.filter(c=>normalize(c.name).includes(q) || normalize(c.phone).includes(q) || normalize(c.email).includes(q));
  resultsEl.innerHTML = filtered.length
    ? `<div style="color:var(--text-dim);font-size:12.5px;margin-bottom:8px;">${filtered.length} result${filtered.length>1?'s':''}</div>` + filtered.map(c=>custRowHtml(c)).join('')
    : '<div class="empty">No customers found matching that search.</div>';
  document.querySelectorAll('#custSearchResults [data-cust-id]').forEach(row=>{
    row.onclick = ()=> showCustomerDetail(row.getAttribute('data-cust-id'));
  });
}

document.getElementById('searchCustBtn').onclick = runCustomerSearch;
document.getElementById('custSearch').addEventListener('keydown', e=>{
  if(e.key==='Enter'){ runCustomerSearch(); hideSuggestions(); }
  if(e.key==='Escape') hideSuggestions();
});
document.getElementById('resetCustBtn').onclick = ()=>{
  document.getElementById('custSearch').value = '';
  lastSearchRan = false;
  document.getElementById('custSearchResults').innerHTML = '<div class="empty">Type a name, phone, or email above and tap Search to see matching customers.</div>';
  document.getElementById('custDetail').innerHTML = '';
  selectedCustId = null;
  hideSuggestions();
};

// ---- live typeahead suggestions, matched letter-by-letter as the user types ----
function hideSuggestions(){
  const el = document.getElementById('custSuggestions');
  el.style.display = 'none';
  el.innerHTML = '';
}
document.getElementById('custSearch').addEventListener('input', ()=>{
  const raw = document.getElementById('custSearch').value.trim();
  const q = normalize(raw);
  const box = document.getElementById('custSuggestions');
  if(!q){ hideSuggestions(); return; }
  const matches = customers.filter(c=>
    normalize(c.name).includes(q) || normalize(c.phone).includes(q) || normalize(c.email).includes(q)
  ).slice(0,8);
  if(!matches.length){ hideSuggestions(); return; }
  box.innerHTML = matches.map(c=>{
    const s = safetyLevel(c);
    const rest = primaryRestaurant(c);
    return `<div class="suggest-item" data-sugg-id="${c.id}">
      <div class="top">
        <span class="nm">${escapeHtml(c.name)}</span>
        <span class="safety-badge safety-${s.level}">${s.label}</span>
      </div>
      <div class="meta">${rest?escapeHtml(rest)+' · ':''}${escapeHtml(c.phone||c.email||'')}</div>
    </div>`;
  }).join('');
  box.style.display = 'block';
  box.querySelectorAll('[data-sugg-id]').forEach(row=>{
    row.onclick = ()=>{
      const id = row.getAttribute('data-sugg-id');
      hideSuggestions();
      document.getElementById('custSearch').value = customers.find(c=>c.id===id)?.name || '';
      showCustomerDetail(id);
    };
  });
});
document.addEventListener('click', (e)=>{
  if(!e.target.closest('#custSuggestions') && e.target.id !== 'custSearch') hideSuggestions();
});

// ---------- DEFAULTERS MODAL + PDF ----------
// ---------- SHARED PDF LETTERHEAD ----------
// Used by every exported PDF so they all look like one professional, consistent
// document set for The Sector 17, rather than plain text dumps.
function drawPdfHeader(doc, subtitle){
  doc.setFont('helvetica','bold');
  doc.setFontSize(18);
  doc.setTextColor(22,35,58); // navy
  doc.text('THE SECTOR 17', 14, 18);
  doc.setFont('helvetica','normal');
  doc.setFontSize(8.5);
  doc.setTextColor(107,114,128); // text-dim
  doc.text('Halal Indian  ·  Mediterranean  ·  American', 14, 24);
  doc.text('338 S. Bouquet St, Oakland, Pittsburgh, PA   |   thesector17.com', 14, 29);
  doc.setDrawColor(184,134,63); // gold
  doc.setLineWidth(0.7);
  doc.line(14, 33, 196, 33);
  doc.setFont('helvetica','bold');
  doc.setFontSize(13);
  doc.setTextColor(28,31,36); // text
  doc.text(subtitle, 14, 42);
  doc.setFont('helvetica','normal');
  doc.setFontSize(8.5);
  doc.setTextColor(107,114,128);
  doc.text('Generated ' + new Date().toLocaleString(undefined,{dateStyle:'long', timeStyle:'short'}), 14, 47.5);
  doc.setTextColor(28,31,36);
  return 57; // y position where page content should start
}

document.getElementById('viewDefaultersBtn').onclick = ()=>{
  const defaulters = customers.filter(c=>(c.incidents||[]).length >= 1)
    .sort((a,b)=>(b.incidents||[]).length-(a.incidents||[]).length);
  const listEl = document.getElementById('defaultersList');
  listEl.innerHTML = defaulters.length
    ? defaulters.map(c=>custRowHtml(c)).join('')
    : '<div class="empty">No defaulter customers on file yet.</div>';
  document.querySelectorAll('#defaultersList [data-cust-id]').forEach(row=>{
    row.onclick = ()=>{
      document.getElementById('defaultersModal').classList.remove('show');
      showCustomerDetail(row.getAttribute('data-cust-id'));
    };
  });
  document.getElementById('defaultersModal').classList.add('show');
};
document.getElementById('closeDefaultersBtn').onclick = ()=> document.getElementById('defaultersModal').classList.remove('show');

document.getElementById('downloadDefaultersPdfBtn').onclick = ()=>{
  const defaulters = customers.filter(c=>(c.incidents||[]).length >= 1)
    .sort((a,b)=>(b.incidents||[]).length-(a.incidents||[]).length);
  if(!defaulters.length){ toast('No defaulters to export'); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  let y = drawPdfHeader(doc, 'Defaulter Customers');
  defaulters.forEach((c, i)=>{
    const count = (c.incidents||[]).length;
    if(y > 275){ doc.addPage(); y = 20; }
    doc.setFont('helvetica','bold'); doc.setFontSize(11); doc.setTextColor(28,31,36);
    doc.text(`${i+1}. ${c.name}`, 14, y);
    doc.setFont('helvetica','normal'); doc.setFontSize(9);
    doc.setTextColor(count>=2?184:184, count>=2?67:134, count>=2?62:63); // red if repeated, gold if single
    doc.text(`${count} incident${count>1?'s':''}`, 150, y);
    y += 5;
    doc.setTextColor(107,114,128);
    doc.text(`Phone: ${c.phone||'—'}   Email: ${c.email||'—'}   Restaurant: ${c.restaurant||'—'}`, 14, y);
    y += 5;
    doc.setTextColor(28,31,36);
    (c.incidents||[]).forEach((inc,ci)=>{
      if(y > 280){ doc.addPage(); y = 20; }
      doc.text(`   • Case #${ci+1}: ${fmtDate(inc.date)} — ${inc.platform||''} — ${inc.issue||''}${inc.amount?' ($'+inc.amount+')':''}`, 14, y);
      y += 5;
    });
    y += 4;
  });
  doc.save('the-sector-17-defaulters.pdf');
};

// ---------- ALL CUSTOMERS (roster of every customer, not just defaulters) ----------
let selectedCustIdsForDelete = new Set();

function renderAllCustomersList(){
  const all = [...customers].sort((a,b)=>(a.name||'').localeCompare(b.name||''));
  const listEl = document.getElementById('allCustomersList');
  listEl.innerHTML = all.length
    ? `<div style="color:var(--text-dim);font-size:12.5px;margin-bottom:8px;">${all.length} customer${all.length>1?'s':''} on file</div>` + all.map(c=>custRowHtml(c, true)).join('')
    : '<div class="empty">No customers on file yet.</div>';
  document.querySelectorAll('#allCustomersList [data-cust-id]').forEach(row=>{
    row.onclick = (e)=>{
      if(e.target.classList.contains('cust-select-box')) return; // checkbox click handled separately below
      document.getElementById('allCustomersModal').classList.remove('show');
      showCustomerDetail(row.getAttribute('data-cust-id'));
    };
  });
  document.querySelectorAll('#allCustomersList .cust-select-box').forEach(box=>{
    box.checked = selectedCustIdsForDelete.has(box.getAttribute('data-select-id'));
    box.onclick = (e)=>{
      e.stopPropagation();
      const id = box.getAttribute('data-select-id');
      if(box.checked) selectedCustIdsForDelete.add(id); else selectedCustIdsForDelete.delete(id);
      updateBulkDeleteUI();
    };
  });
  updateBulkDeleteUI();
}

function updateBulkDeleteUI(){
  const n = selectedCustIdsForDelete.size;
  document.getElementById('selectedCustCount').textContent = n;
  document.getElementById('deleteSelectedCustomersBtn').disabled = n === 0;
  const all = [...customers];
  document.getElementById('selectAllCustomersBox').checked = all.length>0 && n === all.length;
}

document.getElementById('viewAllCustomersBtn').onclick = ()=>{
  selectedCustIdsForDelete = new Set();
  renderAllCustomersList();
  document.getElementById('allCustomersModal').classList.add('show');
};
document.getElementById('selectAllCustomersBox').onclick = ()=>{
  const checked = document.getElementById('selectAllCustomersBox').checked;
  selectedCustIdsForDelete = checked ? new Set(customers.map(c=>c.id)) : new Set();
  renderAllCustomersList();
};
document.getElementById('deleteSelectedCustomersBtn').onclick = async ()=>{
  const ids = [...selectedCustIdsForDelete];
  if(!ids.length) return;
  if(!confirm(`Permanently delete ${ids.length} selected customer record${ids.length>1?'s':''}? This cannot be undone.`)) return;
  showLoading(`Deleting ${ids.length} customer record${ids.length>1?'s':''}…`);
  try{
    for(let i=0;i<ids.length;i+=400){
      const batch = db.batch();
      ids.slice(i,i+400).forEach(id=> batch.delete(db.collection('customers').doc(id)));
      await withTimeout(batch.commit(), 'Bulk delete customers');
    }
    toast(`✓ Deleted ${ids.length} customer record${ids.length>1?'s':''}`, 'success');
    selectedCustIdsForDelete = new Set();
    renderAllCustomersList();
    if(lastSearchRan) runCustomerSearch();
  }catch(e){
    console.error('[bulk-delete] Failed:', e);
    toast('Delete failed: '+e.message, 'error');
  }finally{
    hideLoading();
  }
};
document.getElementById('closeAllCustomersBtn').onclick = ()=> document.getElementById('allCustomersModal').classList.remove('show');

// ---------- MERGE DUPLICATE CUSTOMERS (one-time cleanup for records created before/outside the import de-dupe logic) ----------
// Groups existing customer records by normalized name. Within a name-group, if every record's
// phone/email either agrees or is blank, they're almost certainly the same person entered more
// than once (e.g. the same Excel file imported twice, or added manually and then imported) — these
// get merged into a single profile, with every order and incident combined and de-duplicated by
// DD Order ID / incident key (same logic the Excel importer already uses). If a name-group has two
// or more DIFFERENT non-blank phone numbers or emails, those are left untouched and flagged for
// manual review instead, since they're likely different people who just share a name.
function findDuplicateCustomerGroups(){
  const byName = new Map();
  customers.forEach(c=>{
    const key = normalize(c.name);
    if(!key) return;
    if(!byName.has(key)) byName.set(key, []);
    byName.get(key).push(c);
  });
  const mergeGroups = [];
  const reviewGroups = [];
  byName.forEach(list=>{
    if(list.length < 2) return;
    const phones = new Set(list.map(c=>normalize(c.phone||'')).filter(Boolean));
    const emails = new Set(list.map(c=>normalize(c.email||'')).filter(Boolean));
    if(phones.size <= 1 && emails.size <= 1) mergeGroups.push(list);
    else reviewGroups.push(list);
  });
  return { mergeGroups, reviewGroups };
}

const STATUS_SEVERITY = { blacklist:5, fraud:4, review:3, onetime:2, repeat:1, trusted:1 };
function mostSevereStatusTag(list){
  let best = '', bestScore = -1;
  list.forEach(c=>{
    const s = STATUS_SEVERITY[c.statusTag] || 0;
    if(c.statusTag && s > bestScore){ bestScore = s; best = c.statusTag; }
  });
  return best;
}
function pickPrimaryRecord(list){
  const score = c => (c.phone?2:0) + (c.email?2:0) + (c.restaurant?1:0) + ((c.incidents||[]).length) + ((c.orders||[]).length);
  return [...list].sort((a,b)=> score(b)-score(a))[0];
}

async function runDuplicateMerge(){
  const { mergeGroups, reviewGroups } = findDuplicateCustomerGroups();
  if(!mergeGroups.length && !reviewGroups.length){
    toast('No duplicate customers found — your records are already clean.', 'success');
    return;
  }
  let msg = '';
  if(mergeGroups.length){
    const totalRecords = mergeGroups.reduce((s,g)=>s+g.length,0);
    msg += `Found ${mergeGroups.length} customer name(s) with duplicate records (${totalRecords} records total). `+
           `Each set will be merged into one profile, combining all orders and incidents (case numbers preserved) and removing the extra entries.\n\n`;
  }
  if(reviewGroups.length){
    msg += `⚠ ${reviewGroups.length} name(s) have multiple records with DIFFERENT phone numbers or emails — these look like different customers who just share a name, so they will be left alone:\n`;
    msg += reviewGroups.map(g=>`  • ${g[0].name} (${g.length} records)`).join('\n') + '\n\n';
  }
  if(!mergeGroups.length){ alert(msg + 'Nothing to auto-merge.'); return; }
  msg += 'Proceed with merging the duplicate sets listed above?';
  if(!confirm(msg)) return;

  showLoading('Merging duplicate customers…');
  try{
    let mergedGroups = 0, removedRecords = 0;
    const batchOps = [];
    mergeGroups.forEach(group=>{
      const primary = pickPrimaryRecord(group);
      const others = group.filter(c=>c.id!==primary.id);
      let orders = [...(primary.orders||[])];
      let incidents = [...(primary.incidents||[])];
      let phone = primary.phone||'', email = primary.email||'', restaurant = primary.restaurant||'';
      let rating = parseInt(primary.rating)||0;
      let auditLog = [...(primary.auditLog||[])];
      others.forEach(o=>{
        (o.orders||[]).forEach(ord=>{ orders = mergeOrderIntoList(orders, ord, primary.name).orders; });
        (o.incidents||[]).forEach(inc=>{ incidents = mergeIncidentIntoList(incidents, inc, primary.name).incidents; });
        if(!phone && o.phone) phone = o.phone;
        if(!email && o.email) email = o.email;
        if(!restaurant && o.restaurant) restaurant = o.restaurant;
        rating = Math.max(rating, parseInt(o.rating)||0);
        auditLog = auditLog.concat(o.auditLog||[]);
      });
      const statusTag = mostSevereStatusTag(group) || primary.statusTag || '';
      auditLog.push({ date:new Date().toISOString(), action:`Merged ${others.length} duplicate record${others.length>1?'s':''} via cleanup tool — now ${incidents.length} case${incidents.length===1?'':'s'} on file` });

      batchOps.push({ type:'update', ref: db.collection('customers').doc(primary.id), data:{ phone, email, restaurant, rating, statusTag, orders, incidents, auditLog } });
      others.forEach(o=> batchOps.push({ type:'delete', ref: db.collection('customers').doc(o.id) }));
      removedRecords += others.length;
      mergedGroups++;
    });

    for(let i=0;i<batchOps.length;i+=400){
      const batch = db.batch();
      batchOps.slice(i,i+400).forEach(op=> op.type==='update' ? batch.update(op.ref, op.data) : batch.delete(op.ref));
      await withTimeout(batch.commit(), 'Duplicate merge commit');
    }
    toast(`✓ Merged ${mergedGroups} duplicate customer set(s), removed ${removedRecords} extra record(s)`, 'success');
    if(lastSearchRan) runCustomerSearch();
  }catch(e){
    console.error('[dedup] Merge failed:', e);
    toast('Merge failed: '+e.message, 'error');
  }finally{
    hideLoading();
  }
}
document.getElementById('mergeDuplicatesBtn').onclick = runDuplicateMerge;

// ---------- RESCAN FOR DEFAULTERS ----------
// Every imported order is stored on the customer record with its raw status/errorCharge/comment/
// errorCategory fields, even if that row wasn't flagged as an incident at import time (e.g. because
// of a mapping issue, a platform-specific status wording we didn't recognize yet, or a customer's
// manual "trusted" tag masking the badge). This walks every customer's stored orders back through
// the current classification rules and rebuilds their incident list — so fixes to the classifier
// apply retroactively without re-uploading any Excel file.
//
// IMPORTANT: once an order is saved, a truly blank error-charge cell and an explicit "$0.00" cell
// both end up stored as the same number (0) — there's no way to tell them apart after the fact.
// A ONE-CLEAN customer with a clean $0-charge order and a defaulter with a genuine but small charge
// look identical here, so this only flags on: a real status/comment/error-category keyword, a
// nonzero error charge, or actual comment text. It never invents a flag from a bare 0.
// It also strips out any "Error charge (logged as $0)" flags a previous buggy version of this tool
// may have added — those were false positives and are safe to remove on sight.
function rebuildIncidentsFromOrders(c){
  const orders = c.orders || [];
  let incidents = (c.incidents||[]).filter(inc=> inc.issue !== 'Error charge (logged as $0)');
  const removed = (c.incidents||[]).length - incidents.length;
  let added = 0;
  orders.forEach(o=>{
    const errorChargeNum = parseFloat(o.errorCharge)||0;
    let classification = classifyOrderStatus(o.status||'', (o.status||o.errorCategory) ? '' : (o.comment||''), o.errorCategory||'');
    if(!classification && (o.comment || errorChargeNum)){
      classification = { type:'flagged', issue: errorChargeNum ? 'Error charge' : 'Customer comment on order' };
    }
    if(!classification) return;
    const noteParts = [];
    if(o.comment) noteParts.push(o.comment);
    if(o.dasherName) noteParts.push(`Dasher: ${o.dasherName}`);
    const inc = {
      date: o.date ? new Date(o.date).toISOString() : new Date().toISOString(),
      platform: o.restaurant||'', order: o.orderId||'',
      amount: o.amount || String(o.errorCharge||''),
      issue: classification.issue,
      notes: noteParts.join(' — '),
      shots: []
    };
    const before = incidents.length;
    const r = mergeIncidentIntoList(incidents, inc, c.name);
    incidents = r.incidents;
    if(incidents.length > before) added++;
  });
  return { incidents, added, removed };
}

async function runDefaulterRescan(){
  showLoading('Rescanning order history…');
  try{
    const ops = [];
    let customersUpdated = 0, incidentsAdded = 0, incidentsRemoved = 0;
    customers.forEach(c=>{
      const { incidents, added, removed } = rebuildIncidentsFromOrders(c);
      if(added > 0 || removed > 0){
        const auditLog = [...(c.auditLog||[])];
        const parts = [];
        if(added) parts.push(`${added} case${added>1?'s':''} recovered from order history`);
        if(removed) parts.push(`${removed} incorrect "$0 charge" flag${removed>1?'s':''} removed`);
        auditLog.push({ date:new Date().toISOString(), action:`Rescan: ${parts.join(', ')} — now ${incidents.length} case${incidents.length===1?'':'s'} on file` });
        ops.push({ ref: db.collection('customers').doc(c.id), data:{ incidents, auditLog } });
        customersUpdated++; incidentsAdded += added; incidentsRemoved += removed;
      }
    });
    if(!ops.length){
      toast('Rescan complete — no changes needed. All flags are already correct.', 'success');
      return;
    }
    for(let i=0;i<ops.length;i+=400){
      const batch = db.batch();
      ops.slice(i,i+400).forEach(op=> batch.update(op.ref, op.data));
      await withTimeout(batch.commit(), 'Rescan commit');
    }
    toast(`✓ Rescan complete — ${customersUpdated} customer(s) updated (${incidentsAdded} case(s) recovered, ${incidentsRemoved} bad flag(s) removed)`, 'success');
    if(lastSearchRan) runCustomerSearch();
  }catch(e){
    console.error('[rescan] Failed:', e);
    toast('Rescan failed: '+e.message, 'error');
  }finally{
    hideLoading();
  }
}
document.getElementById('rescanDefaultersBtn').onclick = runDefaulterRescan;

document.getElementById('downloadAllCustomersPdfBtn').onclick = ()=>{
  const all = [...customers].sort((a,b)=>(a.name||'').localeCompare(b.name||''));
  if(!all.length){ toast('No customers to export'); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  let y = drawPdfHeader(doc, `All Customer Records (${all.length})`);
  all.forEach((c, i)=>{
    const count = (c.incidents||[]).length;
    if(y > 275){ doc.addPage(); y = 20; }
    doc.setFont('helvetica','bold'); doc.setFontSize(11); doc.setTextColor(28,31,36);
    doc.text(`${i+1}. ${c.name}`, 14, y);
    doc.setFont('helvetica','normal'); doc.setFontSize(9);
    if(count>=2) doc.setTextColor(184,67,62);
    else if(count===1) doc.setTextColor(184,134,63);
    else doc.setTextColor(47,122,79);
    doc.text(count ? `${count} incident${count>1?'s':''}` : 'No incidents on file', 150, y);
    y += 5;
    doc.setTextColor(107,114,128);
    doc.text(`Phone: ${c.phone||'—'}   Email: ${c.email||'—'}   Restaurant: ${c.restaurant||'—'}`, 14, y);
    y += 5;
    doc.setTextColor(28,31,36);
    (c.incidents||[]).forEach((inc,ci)=>{
      if(y > 280){ doc.addPage(); y = 20; }
      doc.text(`   • Case #${ci+1}: ${fmtDate(inc.date)} — ${inc.platform||''} — ${inc.issue||''}${inc.amount?' ($'+inc.amount+')':''}`, 14, y);
      y += 5;
    });
    y += 4;
  });
  doc.save('the-sector-17-all-customers.pdf');
};

function orderStatusBadge(o){
  if(o.status){
    const s = o.status.toLowerCase();
    if(/cancel/.test(s)) return `<span class="stamp stamp-red" style="margin-left:6px;">Cancelled</span>`;
    if(/error/.test(s)) return `<span class="stamp stamp-red" style="margin-left:6px;">Error charge</span>`;
    if(/charge.?back|dispute/.test(s)) return `<span class="stamp stamp-red" style="margin-left:6px;">Chargeback</span>`;
    if(/fraud/.test(s)) return `<span class="stamp stamp-red" style="margin-left:6px;">Fraud flag</span>`;
    if(/refund/.test(s)) return `<span class="stamp stamp-gold" style="margin-left:6px;">Refunded</span>`;
    if(/declin|fail|reject/.test(s)) return `<span class="stamp stamp-gold" style="margin-left:6px;">Declined</span>`;
    return `<span class="stamp stamp-green" style="margin-left:6px;">${escapeHtml(o.status)}</span>`;
  }
  if(parseFloat(o.errorCharge)||0) return `<span class="stamp stamp-red" style="margin-left:6px;">Error charge</span>`;
  if(o.comment) return `<span class="stamp stamp-gold" style="margin-left:6px;">Flagged</span>`;
  return '';
}
function ordersSummaryHtml(c){
  const orders = c.orders || [];
  if(!orders.length) return '';
  const isBadOrder = o=> (o.status && /cancel|error|charge.?back|dispute|fraud|declin|fail|reject/i.test(o.status)) || !!o.comment || !!(parseFloat(o.errorCharge)||0);
  const goodOrders = orders.filter(o=>!isBadOrder(o));
  const badOrders = orders.filter(isBadOrder);
  const total = goodOrders.reduce((s,o)=>s+(parseFloat(o.amount)||0),0);
  const disputedTotal = badOrders.reduce((s,o)=>s+(parseFloat(o.amount)||0),0);
  const byStore = {};
  goodOrders.forEach(o=>{ const r = o.restaurant||'Unknown'; byStore[r] = (byStore[r]||0) + (parseFloat(o.amount)||0); });
  const sorted = [...orders].sort((a,b)=> new Date(b.date||0) - new Date(a.date||0));
  return `
    <div class="card" style="background:var(--paper);">
      <div style="font-size:14.5px;font-weight:600;margin-bottom:10px;">Order history (imported)</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;">
        <div class="stat-chip"><span class="n">${orders.length}</span><span class="l">Total orders</span></div>
        <div class="stat-chip"><span class="n">$${total.toFixed(2)}</span><span class="l">Total spent</span></div>
        ${badOrders.length ? `<div class="stat-chip" style="background:var(--red-bg);border-color:var(--red);"><span class="n" style="color:var(--red);">$${disputedTotal.toFixed(2)}</span><span class="l" style="color:var(--red);">${badOrders.length} cancelled/error</span></div>` : ''}
        ${Object.entries(byStore).map(([r,amt])=>`<div class="stat-chip"><span class="n">$${amt.toFixed(2)}</span><span class="l">${escapeHtml(r)}</span></div>`).join('')}
      </div>
      <div>
        ${sorted.slice(0,25).map(o=>{
          const extraBits = [];
          if(o.items && o.items.length) extraBits.push(escapeHtml(o.items.join(', ')));
          if(o.dasherName) extraBits.push('Dasher: '+escapeHtml(o.dasherName));
          if(o.errorCategory) extraBits.push('Error category: '+escapeHtml(o.errorCategory));
          if(o.errorCharge) extraBits.push('Error charge: $'+(parseFloat(o.errorCharge)||0).toFixed(2));
          if(o.deliveryDate) extraBits.push('Delivered: '+fmtDate(o.deliveryDate));
          return `
          <div class="order-row">
            <div>
              <div><span class="rest-tag">${escapeHtml(o.restaurant||'Unknown restaurant')}</span>${o.orderId?' #'+escapeHtml(o.orderId):''}${orderStatusBadge(o)}${o.promotion?' · <span style="color:var(--gold);">'+escapeHtml(o.promotion)+'</span>':''}</div>
              ${extraBits.length?`<div class="l">${extraBits.join(' · ')}</div>`:''}
              ${o.comment?`<div class="l">${escapeHtml(o.comment)}</div>`:''}
            </div>
            <div style="text-align:right;white-space:nowrap;">
              <div style="${isBadOrder(o)?'color:var(--red);':''}">$${(parseFloat(o.amount)||0).toFixed(2)}</div>
              <div class="l">${o.date?fmtDate(o.date):''}</div>
            </div>
          </div>`;
        }).join('')}
        ${orders.length>25?`<div class="l" style="padding:8px 12px;">+ ${orders.length-25} more orders</div>`:''}
      </div>
    </div>`;
}

function showCustomerDetail(id){
  selectedCustId = id;
  const c = customers.find(x=>x.id===id);
  if(!c) return;
  const incidents = c.incidents || [];
  const isFlagged = incidents.length >= 2;
  const stamp = isFlagged
    ? `<span class="stamp stamp-red"><i class="ti ti-alert-triangle" aria-hidden="true"></i> Repeat dispute history</span>`
    : incidents.length===1 ? `<span class="stamp stamp-gold">1 prior incident</span>` : `<span class="stamp stamp-green">No incidents</span>`;

  const incidentHtml = incidents.map((inc,idx)=>`
    <div class="incident">
      <div class="meta"><span>Case #${idx+1} — ${fmtDate(inc.date)} · ${escapeHtml(inc.platform||'')}</span><span>${escapeHtml(inc.order||'')}</span></div>
      <div>${escapeHtml(inc.issue||'')}${inc.amount?' — $'+escapeHtml(String(inc.amount)):''}</div>
      ${inc.notes?`<div style="color:var(--text-dim);margin-top:4px;">${escapeHtml(inc.notes)}</div>`:''}
      ${(inc.shots&&inc.shots.length)?`<div class="shots">${inc.shots.map(s=>`<img src="${s}" data-full="${s}" />`).join('')}</div>`:''}
    </div>
  `).join('');

  let summary = '';
  if(incidents.length){
    const lines = [`Customer: ${c.name}${c.phone?' ('+c.phone+')':''}`, `Prior incidents on file: ${incidents.length}`];
    incidents.forEach((inc,i)=> lines.push(`Case #${i+1}: ${fmtDate(inc.date)} — ${inc.platform} order ${inc.order||'n/a'} — ${inc.issue}${inc.amount?` ($${inc.amount})`:''}`));
    lines.push('','Requesting: cancellation of this order without impact to our store cancellation rate, given the documented history above. Please confirm resolution and case number by email for our records.');
    summary = `<div class="summary-box">${escapeHtml(lines.join('\n'))}</div>`;
  }

  const auditLog = c.auditLog || [];
  const auditHtml = auditLog.length ? `
    <div class="audit-log">
      <button class="audit-log-toggle" id="toggleAuditBtn">Show change history (${auditLog.length})</button>
      <div id="auditEntries" style="display:none;margin-top:8px;">
        ${[...auditLog].reverse().map(a=>`<div class="audit-entry">${fmtDate(a.date)} — ${escapeHtml(a.action||'Updated')}</div>`).join('')}
      </div>
    </div>` : '';

  document.getElementById('custDetail').innerHTML = `
    <div class="card">
      ${stamp}
      <div style="margin:10px 0 4px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">${safetyBadgeHtml(c)}</div>
      <div style="font-size:19px;font-weight:600;margin:4px 0 2px;" class="${nameColorClass(incidents.length)}">${escapeHtml(c.name)} <span class="rest-tag${primaryRestaurant(c)?'':' rest-tag-empty'}">${primaryRestaurant(c)?escapeHtml(primaryRestaurant(c)):'No restaurant set'}</span></div>
      <div style="color:var(--text-dim);font-size:13px;margin-bottom:6px;">${escapeHtml(c.phone||'')}${c.email?' · '+escapeHtml(c.email):''}</div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px;">${statusPillHtml(c.statusTag)}${starRatingHtml(c.rating)}</div>
      ${ordersSummaryHtml(c)}
      ${incidentHtml}
      ${summary}
      ${auditHtml}
      <div style="display:flex;gap:10px;margin-top:14px;flex-wrap:wrap;">
        <button class="btn-outline" id="editCustBtn"><i class="ti ti-edit" aria-hidden="true"></i> Edit info</button>
        <button class="btn-outline" id="addIncidentBtn"><i class="ti ti-plus" aria-hidden="true"></i> Add new incident</button>
        ${incidents.length?`<button class="btn-outline" id="copySummaryBtn"><i class="ti ti-copy" aria-hidden="true"></i> Copy summary</button>`:''}
        <button class="btn-danger" id="deleteCustBtn">Delete record</button>
      </div>
    </div>
  `;
  if(auditLog.length){
    document.getElementById('toggleAuditBtn').onclick = ()=>{
      const el = document.getElementById('auditEntries');
      const showing = el.style.display !== 'none';
      el.style.display = showing ? 'none' : 'block';
      document.getElementById('toggleAuditBtn').textContent = showing ? `Show change history (${auditLog.length})` : 'Hide change history';
    };
  }
  document.getElementById('editCustBtn').onclick = ()=> openCustFormForEdit(c);
  document.getElementById('addIncidentBtn').onclick = ()=> openCustFormForEdit(c, true);
  if(incidents.length){
    document.getElementById('copySummaryBtn').onclick = async ()=>{
      const text = document.querySelector('#custDetail .summary-box').textContent;
      try{ await navigator.clipboard.writeText(text); toast('Copied to clipboard'); }catch(e){ toast('Could not copy'); }
    };
  }
  document.getElementById('deleteCustBtn').onclick = async ()=>{
    if(!confirm('Delete this customer record permanently?')) return;
    try{
      await withTimeout(db.collection('customers').doc(id).delete(), 'Delete customer');
      document.getElementById('custDetail').innerHTML = '';
      selectedCustId = null;
      customers = customers.filter(x=>x.id!==id); // remove locally right away, don't wait on the live sync
      if(lastSearchRan) runCustomerSearch();
      toast('Customer record deleted');
    }catch(e){
      toast('Delete failed: '+e.message);
    }
  };
  document.querySelectorAll('#custDetail .shots img').forEach(img=>{
    img.onclick = ()=>{
      document.getElementById('lightboxImg').src = img.getAttribute('data-full');
      document.getElementById('lightbox').classList.add('show');
    };
  });
}
document.getElementById('lightbox').onclick = ()=> document.getElementById('lightbox').classList.remove('show');

// Add customer form
let matchedExistingId = null;
let editingCustId = null;

function setRatingUI(rating){
  document.getElementById('f-rating').value = rating;
  document.querySelectorAll('#f-ratingSelect .star-btn').forEach(btn=>{
    btn.classList.toggle('filled', parseInt(btn.dataset.star) <= rating);
  });
}
document.querySelectorAll('#f-ratingSelect .star-btn').forEach(btn=>{
  btn.onclick = ()=>{
    const val = parseInt(btn.dataset.star);
    const current = parseInt(document.getElementById('f-rating').value)||0;
    setRatingUI(val === current ? 0 : val); // tap same star again to clear
  };
});

function resetCustFormFields(){
  ['f-name','f-phone','f-email','f-order','f-amount','f-notes'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('f-restaurant').selectedIndex = 0;
  document.getElementById('f-platform').selectedIndex = 0;
  document.getElementById('f-issue').selectedIndex = 0;
  document.getElementById('f-isIncident').value = 'no';
  document.getElementById('f-statusTag').value = '';
  setRatingUI(0);
  document.getElementById('incidentFields').style.display = 'none';
  custPendingShots = [];
  renderCustShotPreviews();
  matchedExistingId = null;
  editingCustId = null;
  document.getElementById('custMatchHint').innerHTML = '';
}

function openCustFormForEdit(c, wantIncident){
  resetCustFormFields();
  editingCustId = c.id;
  document.getElementById('f-name').value = c.name || '';
  document.getElementById('f-phone').value = c.phone || '';
  document.getElementById('f-email').value = c.email || '';
  if(c.restaurant) document.getElementById('f-restaurant').value = c.restaurant;
  document.getElementById('f-statusTag').value = c.statusTag || '';
  setRatingUI(parseInt(c.rating)||0);
  if(wantIncident){
    document.getElementById('f-isIncident').value = 'yes';
    document.getElementById('incidentFields').style.display = 'block';
  }
  document.getElementById('custMatchHint').innerHTML = `<div class="stamp stamp-gold">Editing existing record: ${escapeHtml(c.name)}${wantIncident ? ' — new incident will be added on save' : ''}</div>`;
  document.getElementById('custForm').style.display='block';
  document.getElementById('custForm').scrollIntoView({behavior:'smooth'});
}

document.getElementById('openCustFormBtn').onclick = ()=>{
  resetCustFormFields();
  document.getElementById('custForm').style.display='block';
  document.getElementById('custForm').scrollIntoView({behavior:'smooth'});
};
document.getElementById('cancelCustBtn').onclick = ()=>{
  resetCustFormFields();
  document.getElementById('custForm').style.display='none';
};
document.getElementById('f-isIncident').addEventListener('change', e=>{
  document.getElementById('incidentFields').style.display = e.target.value==='yes' ? 'block' : 'none';
});

document.getElementById('f-name').addEventListener('input', ()=>{
  const q = normalize(document.getElementById('f-name').value);
  const hintEl = document.getElementById('custMatchHint');
  matchedExistingId = null;
  if(q.length < 2){ hintEl.innerHTML = ''; return; }
  const matches = customers.filter(c=>normalize(c.name).includes(q)).slice(0,5);
  if(!matches.length){ hintEl.innerHTML = '<div style="font-size:12px;color:var(--text-dim);">No existing customer matches this name — this will create a new record.</div>'; return; }
  hintEl.innerHTML = `<div style="font-size:12px;color:var(--text-dim);margin-bottom:6px;">Existing customer? Tap to attach this incident to their record instead of creating a duplicate:</div>` +
    matches.map(c=>{
      const count=(c.incidents||[]).length;
      return `<div class="cust-row" data-pick-id="${c.id}" style="padding:8px 12px;margin-bottom:4px;">
        <div><div class="name ${nameColorClass(count)}" style="font-size:13.5px;">${escapeHtml(c.name)}</div>
        <div class="meta">${escapeHtml(c.phone||'')}${c.email?' · '+escapeHtml(c.email):''}${c.restaurant?' · '+escapeHtml(c.restaurant):''}</div></div>
        ${count>0?`<span class="count-badge">${count} incident${count>1?'s':''}</span>`:''}
      </div>`;
    }).join('');
  hintEl.querySelectorAll('[data-pick-id]').forEach(row=>{
    row.onclick = ()=>{
      const c = customers.find(x=>x.id===row.getAttribute('data-pick-id'));
      if(!c) return;
      matchedExistingId = c.id;
      document.getElementById('f-name').value = c.name;
      document.getElementById('f-phone').value = c.phone||'';
      document.getElementById('f-email').value = c.email||'';
      if(c.restaurant) document.getElementById('f-restaurant').value = c.restaurant;
      const count=(c.incidents||[]).length;
      hintEl.innerHTML = `<div class="stamp stamp-gold">Attaching to existing record: ${escapeHtml(c.name)} — currently ${count} incident${count!==1?'s':''}. Saving will make this ${count+1}.</div>`;
    };
  });
});
document.getElementById('shotUpload').onclick = ()=> document.getElementById('shotFile').click();
document.getElementById('shotFile').onchange = async (e)=>{
  for(const file of Array.from(e.target.files)){
    try{ custPendingShots.push(await resizeImage(file, 900)); }catch(err){ toast('Could not read image'); }
  }
  renderCustShotPreviews();
  e.target.value = '';
};
function renderCustShotPreviews(){
  const row = document.getElementById('shotPreviewRow');
  row.innerHTML = custPendingShots.map((s,i)=>`<div class="shot-preview"><img src="${s}"/><div class="rm" data-i="${i}">×</div></div>`).join('');
  row.querySelectorAll('.rm').forEach(btn=> btn.onclick = ()=>{ custPendingShots.splice(parseInt(btn.dataset.i),1); renderCustShotPreviews(); });
}

document.getElementById('saveCustBtn').onclick = async ()=>{
  const saveBtn = document.getElementById('saveCustBtn');
  const name = document.getElementById('f-name').value.trim();
  const phone = document.getElementById('f-phone').value.trim();
  const email = document.getElementById('f-email').value.trim();
  const restaurant = document.getElementById('f-restaurant').value;
  const platform = document.getElementById('f-platform').value;
  const isIncident = document.getElementById('f-isIncident').value === 'yes';
  const statusTag = document.getElementById('f-statusTag').value;
  const rating = parseInt(document.getElementById('f-rating').value) || 0;

  if(!name){ toast('Customer name is required'); return; }

  saveBtn.disabled = true;
  showLoading('Saving customer…');

  const key = normalize(name)+'|'+normalize(phone);
  let existing = editingCustId
    ? customers.find(c => c.id === editingCustId)
    : matchedExistingId
      ? customers.find(c => c.id === matchedExistingId)
      : customers.find(c => (normalize(c.name)+'|'+normalize(c.phone)) === key);

  const newIncident = isIncident ? {
    date: new Date().toISOString(),
    platform,
    order: document.getElementById('f-order').value.trim(),
    amount: document.getElementById('f-amount').value.trim(),
    issue: document.getElementById('f-issue').value,
    notes: document.getElementById('f-notes').value.trim(),
    shots: custPendingShots.slice()
  } : null;

  try{
    if(existing){
      const incidents = existing.incidents || [];
      if(newIncident) incidents.push(newIncident);

      // Build a lightweight audit log of what changed on this save.
      const auditLog = existing.auditLog || [];
      const changes = [];
      if(existing.name !== name) changes.push(`name → ${name}`);
      if((existing.phone||'') !== phone) changes.push('phone updated');
      if((existing.email||'') !== email) changes.push('email updated');
      if((existing.restaurant||'') !== restaurant) changes.push(`restaurant → ${restaurant}`);
      if((existing.statusTag||'') !== statusTag) changes.push(`status tag → ${statusTag ? STATUS_LABELS[statusTag].label : 'none'}`);
      if((parseInt(existing.rating)||0) !== rating) changes.push(`rating → ${rating||'none'}★`);
      if(newIncident) changes.push('new incident logged');
      if(changes.length) auditLog.push({ date: new Date().toISOString(), action: changes.join('; ') });

      console.log('[customers] Updating existing record', existing.id, { name, phone, email, restaurant, statusTag, rating });
      await withTimeout(
        db.collection('customers').doc(existing.id).update({ name, phone, email, restaurant, statusTag, rating, incidents, auditLog }),
        'Customer save'
      );
    }else{
      console.log('[customers] Creating new record', { name, phone, email, restaurant, statusTag, rating });
      await withTimeout(
        db.collection('customers').add({
          name, phone, email, restaurant, statusTag, rating,
          incidents: newIncident ? [newIncident] : [],
          auditLog: [{ date: new Date().toISOString(), action: 'Record created' }]
        }),
        'Customer save'
      );
    }
    console.log('[customers] Save confirmed by Firestore ✓');
    toast('✓ Customer saved successfully', 'success');
    resetCustFormFields();
    document.getElementById('custForm').style.display='none';
  }catch(e){
    console.error('Save customer failed:', e);
    toast('Save failed: '+e.message, 'error');
  }finally{
    saveBtn.disabled = false;
    hideLoading();
  }
};

// ================= EXCEL IMPORT (customer orders) =================
let importRows = [];        // raw data rows (array of arrays), header excluded
let importHeaders = [];
let importMapping = {};     // { colIndex: fieldName }

const IMPORT_FIELDS = [
  {key:'ignore', label:'Ignore this column'},
  {key:'name', label:'Customer name'},
  {key:'phone', label:'Phone'},
  {key:'email', label:'Email'},
  {key:'restaurant', label:'Restaurant / store'},
  {key:'orderId', label:'DD Order ID'},
  {key:'date', label:'Order date'},
  {key:'deliveryDate', label:'Order delivery date'},
  {key:'amount', label:'Amount ($)'},
  {key:'errorCharge', label:'Error charge ($)'},
  {key:'errorCategory', label:'Error category'},
  {key:'status', label:'Order status (completed / cancelled / error / refund…)'},
  {key:'itemName', label:'Item name'},
  {key:'dasherName', label:'Dasher name'},
  {key:'cancelledBy', label:'Cancelled or handled by'},
  {key:'promotion', label:'Promotion / discount'},
  {key:'comment', label:'Customer comment / notes / reason'}
];

function guessImportField(header){
  const h = (header||'').toString().toLowerCase();
  if(/dd.?order|order.?(id|no|number|#)/.test(h)) return 'orderId';
  if(/dasher/.test(h)) return 'dasherName';
  if(/error.?(category|type|reason)/.test(h)) return 'errorCategory';
  if(/error.?charge|charge.?amount|refund.?amount|refund.?charge/.test(h)) return 'errorCharge';
  if(/deliver(y|ed).?date/.test(h)) return 'deliveryDate';
  if(/item|product/.test(h) && /name/.test(h)) return 'itemName';
  if(/cancel.*by|handled.?by|voided.?by|refunded.?by|staff|employee|agent/.test(h)) return 'cancelledBy';
  if(/status|outcome|result|disposition/.test(h)) return 'status';
  if(/name/.test(h) && !/store|restaurant|item|product|dasher/.test(h)) return 'name';
  if(/phone|mobile|contact/.test(h)) return 'phone';
  if(/e[-\s]?mail/.test(h)) return 'email';
  if(/restaurant|store|location|branch|outlet/.test(h)) return 'restaurant';
  if(/date/.test(h)) return 'date';
  if(/promo|discount|coupon|offer/.test(h)) return 'promotion';
  if(/comment|note|remark|reason/.test(h)) return 'comment';
  if(/amount|total|spent|price|paid/.test(h)) return 'amount';
  return 'ignore';
}

function classifyOrderStatus(statusText, commentText, errorCategory){
  const s = ((statusText||'') + ' ' + (commentText||'') + ' ' + (errorCategory||'')).toLowerCase();
  if(/fraud/.test(s)) return { type:'fraud', issue:'Fraud flag' };
  if(/charge.?back/.test(s)) return { type:'chargeback', issue:'Chargeback / bank dispute' };
  if(/dispute/.test(s)) return { type:'dispute', issue:'Customer dispute' };
  if(/cancel|void/.test(s)) return { type:'cancelled', issue:'Order cancelled' };
  if(/no.?show/.test(s)) return { type:'noshow', issue:'Customer no-show' };
  if(/missing|wrong.?(item|order)|incorrect.?(item|order)/.test(s)) return { type:'error', issue:'Missing / incorrect item' };
  if(/error/.test(s)) return { type:'error', issue:'Order / charge error' };
  if(/refund/.test(s)) return { type:'refund', issue:'Refund issued' };
  if(/complain/.test(s)) return { type:'complaint', issue:'Customer complaint' };
  if(/declin|fail|reject|undeliver/.test(s)) return { type:'failed', issue:'Order declined / failed' };
  return null; // completed / normal order — not an incident
}

function orderKey(o, custName){
  return o.orderId ? 'id:'+normalize(o.orderId) : 'x:'+normalize(custName)+'|'+o.date+'|'+o.amount+'|'+normalize(o.restaurant);
}
function incidentKey(inc, custName){
  return inc.order ? 'id:'+normalize(inc.order) : 'x:'+normalize(custName)+'|'+normalize(inc.date||'')+'|'+normalize(inc.platform||'')+'|'+(inc.amount||'');
}

// Merges an incoming order into an existing orders array, matching by DD order ID.
// Fills in any blank fields, unions item lists, and escalates status if the new row
// indicates a worse outcome (e.g. a later row reveals the order was actually cancelled).
function mergeOrderIntoList(orders, incoming, custName){
  const key = orderKey(incoming, custName);
  const idx = orders.findIndex(o=> orderKey(o, custName) === key);
  if(idx === -1) return { orders: [...orders, incoming], isNew:true, isMerge:false };
  const existing = orders[idx];
  const merged = { ...existing };
  ['restaurant','date','deliveryDate','amount','errorCharge','promotion','comment','status','errorCategory','dasherName','orderId'].forEach(f=>{
    if((merged[f]===undefined || merged[f]==='' || merged[f]===0 || merged[f]===null) && incoming[f]) merged[f] = incoming[f];
  });
  const itemSet = new Set([...(existing.items||[]), ...(incoming.items||[])].filter(Boolean));
  merged.items = Array.from(itemSet);
  const severity = s => ({cancelled:2,error:2,dispute:2,failed:2,chargeback:3,fraud:3,refund:1,completed:0,'':0}[s]||0);
  if(severity(incoming.status) > severity(existing.status)) merged.status = incoming.status;
  const changed = JSON.stringify(merged) !== JSON.stringify(existing);
  const next = [...orders]; next[idx] = merged;
  return { orders: next, isNew:false, isMerge: changed };
}

// Same idea for incidents — combines notes instead of duplicating the incident.
function mergeIncidentIntoList(incidents, incoming, custName){
  const key = incidentKey(incoming, custName);
  const idx = incidents.findIndex(i=> incidentKey(i, custName) === key);
  if(idx === -1) return { incidents: [...incidents, incoming], isNew:true, isMerge:false };
  const existing = incidents[idx];
  const merged = { ...existing };
  ['platform','amount','issue'].forEach(f=>{ if(!merged[f] && incoming[f]) merged[f] = incoming[f]; });
  if(incoming.notes && (!merged.notes || merged.notes.indexOf(incoming.notes)===-1)){
    merged.notes = merged.notes ? merged.notes+' | '+incoming.notes : incoming.notes;
  }
  const changed = JSON.stringify(merged) !== JSON.stringify(existing);
  const next = [...incidents]; next[idx] = merged;
  return { incidents: next, isNew:false, isMerge: changed };
}

function excelDateToISO(val){
  if(val === null || val === undefined || val === '') return '';
  if(typeof val === 'number'){
    const ms = Math.round((val - 25569) * 86400 * 1000); // Excel serial date → JS date
    const d = new Date(ms);
    if(!isNaN(d.getTime())) return d.toISOString().slice(0,10);
  }
  const d = new Date(val);
  if(!isNaN(d.getTime())) return d.toISOString().slice(0,10);
  return '';
}

function resetImportModal(){
  importRows = []; importHeaders = []; importMapping = {};
  document.getElementById('importStep1').style.display = 'block';
  document.getElementById('importStep2').style.display = 'none';
  document.getElementById('importStep3').style.display = 'none';
  document.getElementById('importFileName').textContent = '';
  document.getElementById('importFile').value = '';
}
document.getElementById('openImportBtn').onclick = ()=>{
  resetImportModal();
  document.getElementById('importModal').classList.add('show');
};
document.getElementById('closeImportBtn').onclick = ()=> document.getElementById('importModal').classList.remove('show');
document.getElementById('doneImportBtn').onclick = ()=> document.getElementById('importModal').classList.remove('show');
document.getElementById('backImportBtn').onclick = ()=>{
  document.getElementById('importStep1').style.display = 'block';
  document.getElementById('importStep2').style.display = 'none';
};
document.getElementById('importFileUpload').onclick = ()=> document.getElementById('importFile').click();

document.getElementById('importFile').onchange = (e)=>{
  const file = e.target.files[0];
  if(!file) return;
  document.getElementById('importFileName').textContent = 'Reading '+file.name+'…';
  const reader = new FileReader();
  reader.onload = (ev)=>{
    try{
      const wb = XLSX.read(ev.target.result, { type:'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { header:1, raw:true, defval:'' });
      if(!rows.length){ toast('That file appears to be empty', 'error'); return; }
      importHeaders = rows[0].map(h=> (h||'').toString().trim());
      importRows = rows.slice(1).filter(r=> r.some(c=> c!==null && c!==undefined && c.toString().trim()!==''));
      if(!importRows.length){ toast('No data rows found below the header row', 'error'); return; }
      document.getElementById('importFileName').textContent = `${file.name} — ${importRows.length} rows detected`;
      renderImportMapping();
      document.getElementById('importStep1').style.display = 'none';
      document.getElementById('importStep2').style.display = 'block';
    }catch(err){
      console.error('[import] Could not parse file:', err);
      toast("Could not read this file — make sure it's a valid Excel or CSV file", 'error');
    }
  };
  reader.onerror = ()=> toast('Could not read the file', 'error');
  reader.readAsArrayBuffer(file);
  e.target.value = '';
};

function renderImportMapping(){
  const wrap = document.getElementById('importMappingRows');
  wrap.innerHTML = importHeaders.map((h,i)=>{
    const guess = guessImportField(h);
    importMapping[i] = guess;
    return `<div class="map-row">
      <div class="col-name">${escapeHtml(h || '(column '+(i+1)+')')}</div>
      <select data-map-col="${i}">
        ${IMPORT_FIELDS.map(f=>`<option value="${f.key}" ${f.key===guess?'selected':''}>${f.label}</option>`).join('')}
      </select>
    </div>`;
  }).join('');
  wrap.querySelectorAll('[data-map-col]').forEach(sel=>{
    sel.onchange = ()=> importMapping[parseInt(sel.dataset.mapCol)] = sel.value;
  });
  document.getElementById('importPreviewInfo').textContent = `${importRows.length} order rows ready to import. Rows with no value in the "Customer name" column will be skipped.`;
}

document.getElementById('runImportBtn').onclick = async ()=>{
  const colByField = {};
  Object.entries(importMapping).forEach(([idx,field])=>{ if(field!=='ignore' && !(field in colByField)) colByField[field] = parseInt(idx); });
  if(colByField.name === undefined){ toast('Map at least one column to "Customer name" before importing', 'error'); return; }

  const defaultRestaurant = document.getElementById('import-defaultRestaurant').value;
  const runBtn = document.getElementById('runImportBtn');
  runBtn.disabled = true;
  showLoading('Importing customer orders…');

  try{
    // Match customers: name+phone first, then email, then name-only as a last resort.
    // The name-only fallback matters a lot for restaurant order exports, which often
    // don't include phone/email at all — without it, every re-upload of the same file
    // would silently create brand-new duplicate profiles instead of matching.
    const custByKey = new Map();
    customers.forEach(c=> custByKey.set(normalize(c.name)+'|'+normalize(c.phone), c));
    const custByEmail = new Map();
    customers.forEach(c=> { if(c.email) custByEmail.set(normalize(c.email), c); });
    const custByName = new Map();
    customers.forEach(c=> { const k = normalize(c.name); if(k && !custByName.has(k)) custByName.set(k, c); });

    // Working buckets hold a live copy of each touched customer's orders/incidents so that
    // multiple spreadsheet rows sharing the same DD Order ID (e.g. one row per item) merge
    // into a single order instead of creating duplicates or separate partial records.
    const updates = new Map();       // existing customer.id -> { customer, name, orders, incidents, ordersChanged, incidentsChanged }
    const newCustomers = new Map();  // batch key -> { name, phone, email, orders, incidents }
    let skippedNoName = 0, newOrders = 0, mergedOrders = 0, incidentsFlagged = 0, mergedIncidents = 0;

    importRows.forEach(row=>{
      const get = (field)=> colByField[field]!==undefined ? (row[colByField[field]]!==undefined ? row[colByField[field]] : '') : '';
      const name = (get('name')||'').toString().trim();
      if(!name){ skippedNoName++; return; }
      const phone = (get('phone')||'').toString().trim();
      const email = (get('email')||'').toString().trim();
      const restaurant = (get('restaurant')||'').toString().trim() || defaultRestaurant;
      const orderId = (get('orderId')||'').toString().trim();
      const date = excelDateToISO(get('date'));
      const deliveryDate = excelDateToISO(get('deliveryDate'));
      const amountRaw = (get('amount')||'').toString().replace(/[^0-9.-]/g,'');
      const amount = amountRaw ? parseFloat(amountRaw) : 0;
      const errorChargeRaw = (get('errorCharge')||'').toString().replace(/[^0-9.-]/g,'');
      const errorCharge = errorChargeRaw ? parseFloat(errorChargeRaw) : 0;
      const errorCategory = (get('errorCategory')||'').toString().trim();
      const statusText = (get('status')||'').toString().trim();
      const itemName = (get('itemName')||'').toString().trim();
      const dasherName = (get('dasherName')||'').toString().trim();
      const cancelledBy = (get('cancelledBy')||'').toString().trim();
      const promotion = (get('promotion')||'').toString().trim();
      const comment = (get('comment')||'').toString().trim();
      const order = {
        orderId, date, deliveryDate, restaurant, amount, errorCharge, errorCategory,
        promotion, comment, status: statusText, dasherName,
        items: itemName ? [itemName] : [], importedAt: new Date().toISOString()
      };

      // Defaulter rule: a cancelled/error/dispute/refund/chargeback/fraud keyword in the status or
      // error-category column, OR a nonzero error charge, OR any text in the customer-comment column
      // — any one of those marks the order as an incident. A clean order (no status keyword, $0 or
      // blank error charge, blank comment) is never flagged.
      let classification = classifyOrderStatus(statusText, (statusText||errorCategory) ? '' : comment, errorCategory);
      if(!classification && (comment || errorCharge)){
        classification = { type:'flagged', issue: errorCharge ? 'Error charge' : 'Customer comment on order' };
      }
      let incident = null;
      if(classification){
        const noteParts = [];
        if(comment) noteParts.push(comment);
        if(dasherName) noteParts.push(`Dasher: ${dasherName}`);
        if(cancelledBy) noteParts.push(`Cancelled/handled by: ${cancelledBy}`);
        incident = {
          date: date ? new Date(date).toISOString() : new Date().toISOString(),
          platform: restaurant, order: orderId,
          amount: amountRaw || String(errorCharge||''),
          issue: classification.issue,
          notes: noteParts.join(' — '),
          shots: []
        };
      }

      const key = normalize(name)+'|'+normalize(phone);
      let existing = (phone ? custByKey.get(key) : null) || (email ? custByEmail.get(normalize(email)) : null) || custByName.get(normalize(name));

      if(existing){
        if(!updates.has(existing.id)){
          updates.set(existing.id, {
            customer: existing, name: existing.name,
            orders: [...(existing.orders||[])], incidents: [...(existing.incidents||[])],
            ordersChanged:false, incidentsChanged:false
          });
        }
        const bucket = updates.get(existing.id);
        const or = mergeOrderIntoList(bucket.orders, order, bucket.name);
        bucket.orders = or.orders;
        if(or.isNew){ newOrders++; bucket.ordersChanged = true; }
        else if(or.isMerge){ mergedOrders++; bucket.ordersChanged = true; }

        if(incident){
          const ir = mergeIncidentIntoList(bucket.incidents, incident, bucket.name);
          bucket.incidents = ir.incidents;
          if(ir.isNew){ incidentsFlagged++; bucket.incidentsChanged = true; }
          else if(ir.isMerge){ mergedIncidents++; bucket.incidentsChanged = true; }
        }
      }else{
        const batchKey = key || normalize(email) || normalize(name);
        if(!newCustomers.has(batchKey)) newCustomers.set(batchKey, { name, phone, email, orders: [], incidents: [] });
        const nb = newCustomers.get(batchKey);
        const or = mergeOrderIntoList(nb.orders, order, name);
        nb.orders = or.orders;
        if(or.isNew) newOrders++; else if(or.isMerge) mergedOrders++;
        if(incident){
          const ir = mergeIncidentIntoList(nb.incidents, incident, name);
          nb.incidents = ir.incidents;
          if(ir.isNew) incidentsFlagged++; else if(ir.isMerge) mergedIncidents++;
        }
        if(!nb.phone && phone) nb.phone = phone;
        if(!nb.email && email) nb.email = email;
      }
    });

    const ops = [];
    updates.forEach(({customer, orders, incidents, ordersChanged, incidentsChanged})=>{
      if(!ordersChanged && !incidentsChanged) return;
      const data = {};
      if(ordersChanged) data.orders = orders;
      if(incidentsChanged){
        data.incidents = incidents;
        const auditLog = customer.auditLog || [];
        auditLog.push({ date:new Date().toISOString(), action:'Order/incident data updated from Excel import' });
        data.auditLog = auditLog;
      }
      ops.push({ type:'update', ref: db.collection('customers').doc(customer.id), data });
    });
    newCustomers.forEach(nb=>{
      ops.push({ type:'set', ref: db.collection('customers').doc(), data: {
        name: nb.name, phone: nb.phone||'', email: nb.email||'', restaurant: (nb.orders[0]&&nb.orders[0].restaurant)||'', statusTag:'', rating:0,
        incidents: nb.incidents, orders: nb.orders,
        auditLog:[{ date:new Date().toISOString(), action:`Created via Excel import (${nb.orders.length} order${nb.orders.length>1?'s':''}${nb.incidents.length?`, ${nb.incidents.length} flagged incident${nb.incidents.length>1?'s':''}`:''})` }]
      }});
    });

    // Commit in chunks of 400 to stay safely under Firestore's 500-write batch limit.
    for(let i=0;i<ops.length;i+=400){
      const batch = db.batch();
      ops.slice(i,i+400).forEach(op=> op.type==='update' ? batch.update(op.ref, op.data) : batch.set(op.ref, op.data));
      await withTimeout(batch.commit(), 'Import batch commit');
    }

    document.getElementById('importResultBox').textContent =
`Import complete.

Customers updated: ${updates.size}
New customer profiles created: ${newCustomers.size}
New orders added: ${newOrders}
Existing orders merged with new info (matched by DD Order ID): ${mergedOrders}
Incidents flagged (cancelled / error / dispute / fraud orders): ${incidentsFlagged}
Existing incidents updated with new details: ${mergedIncidents}
Rows skipped (no name): ${skippedNoName}

Flagged customers will now show a yellow or red name and appear in "View all defaulters" with full order details, status, dasher, item, and comment info.`;
    document.getElementById('importStep2').style.display = 'none';
    document.getElementById('importStep3').style.display = 'block';
    toast('✓ Import complete', 'success');
  }catch(e){
    console.error('[import] Failed:', e);
    toast('Import failed: '+e.message, 'error');
  }finally{
    runBtn.disabled = false;
    hideLoading();
  }
};

// ================= GROCERY =================
let groceryItems = [];
let groceryPendingShot = null;

function daysBetween(a,b){ return Math.round((new Date(b)-new Date(a))/86400000); }

function checkAutoReorder(){
  // If an item's predicted next-due date has passed, drop it into the cart automatically as a suggestion.
  groceryItems.forEach(async item=>{
    if(item.inCart) return;
    const history = item.purchaseHistory || [];
    if(history.length < 2) return;
    const sorted = [...history].sort((a,b)=> new Date(a.date)-new Date(b.date));
    let totalGap = 0;
    for(let i=1;i<sorted.length;i++) totalGap += daysBetween(sorted[i-1].date, sorted[i].date);
    const avgGap = totalGap / (sorted.length-1);
    const lastDate = sorted[sorted.length-1].date;
    const nextDue = new Date(lastDate); nextDue.setDate(nextDue.getDate()+Math.round(avgGap));
    if(new Date() >= nextDue){
      try{
        await withTimeout(db.collection('groceryItems').doc(item.id).update({ inCart:true, cartQty: item.cartQty||1, autoAdded:true }), 'Auto-reorder update');
      }catch(e){ console.error('Auto-reorder failed:', e); }
    }
  });
}

function predictedDueLabel(item){
  const history = item.purchaseHistory || [];
  if(history.length < 2) return '';
  const sorted = [...history].sort((a,b)=> new Date(a.date)-new Date(b.date));
  let totalGap = 0;
  for(let i=1;i<sorted.length;i++) totalGap += daysBetween(sorted[i-1].date, sorted[i].date);
  const avgGap = Math.round(totalGap/(sorted.length-1));
  return `Usually runs out every ~${avgGap} day${avgGap===1?'':'s'}`;
}

function renderGrocery(){
  const sorted = [...groceryItems].sort((a,b)=>(a.name||'').localeCompare(b.name||''));
  if(!sorted.length){
    document.getElementById('generalGroceryList').innerHTML = '<div class="empty">No items in your grocery catalog yet. Tap "Add item" to start one.</div>';
  }else{
    let html = '';
    CATEGORY_ORDER.forEach(cat=>{
      const group = sorted.filter(i=>categoryBucket(i.category)===cat);
      if(!group.length) return;
      html += `<div class="cat-group-heading">${escapeHtml(cat)}</div>` + group.map(generalGroceryRowHtml).join('');
    });
    document.getElementById('generalGroceryList').innerHTML = html;
  }

  document.querySelectorAll('[data-cart-add]').forEach(btn=>{
    btn.onclick = async ()=>{
      try{ await withTimeout(db.collection('groceryItems').doc(btn.getAttribute('data-cart-add')).update({ inCart:true, cartQty:1, autoAdded:false }), 'Add to cart'); }
      catch(e){ console.error('Add to cart failed:', e); toast('Failed to add to cart: '+e.message, 'error'); }
    };
  });
  document.querySelectorAll('[data-cart-remove-general]').forEach(btn=>{
    btn.onclick = async ()=>{
      try{ await withTimeout(db.collection('groceryItems').doc(btn.getAttribute('data-cart-remove-general')).update({ inCart:false }), 'Remove from cart'); }
      catch(e){ console.error('Remove from cart failed:', e); toast('Failed: '+e.message, 'error'); }
    };
  });
  document.querySelectorAll('[data-grocery-delete]').forEach(btn=>{
    btn.onclick = async ()=>{
      if(!confirm('Remove this item permanently?')) return;
      try{ await withTimeout(db.collection('groceryItems').doc(btn.getAttribute('data-grocery-delete')).delete(), 'Delete grocery item'); }
      catch(e){ console.error('Grocery delete failed:', e); toast('Delete failed: '+e.message, 'error'); }
    };
  });
  document.querySelectorAll('[data-grocery-edit]').forEach(btn=>{
    btn.onclick = ()=>{
      const item = groceryItems.find(i=>i.id===btn.getAttribute('data-grocery-edit'));
      if(item) openGroceryFormForEdit(item);
    };
  });
  document.querySelectorAll('[data-grocery-fav]').forEach(btn=>{
    btn.onclick = async ()=>{
      const item = groceryItems.find(i=>i.id===btn.getAttribute('data-grocery-fav'));
      if(!item) return;
      try{ await withTimeout(db.collection('groceryItems').doc(item.id).update({ favorite: !item.favorite }), 'Toggle favorite'); }
      catch(e){ console.error('Favorite toggle failed:', e); toast('Failed: '+e.message, 'error'); }
    };
  });
  document.querySelectorAll('[data-grocery-dup]').forEach(btn=>{
    btn.onclick = async ()=>{
      const item = groceryItems.find(i=>i.id===btn.getAttribute('data-grocery-dup'));
      if(!item) return;
      try{
        await withTimeout(db.collection('groceryItems').add({
          name: item.name+' (copy)', category: item.category||'', price: item.price||'',
          qty: item.qty||1, unit: item.unit||'', notes: item.notes||'', image: item.image||null,
          status:'active', inCart:false, cartQty:1, autoAdded:false, favorite:false, purchaseHistory:[]
        }), 'Duplicate grocery item');
        toast('✓ Item duplicated', 'success');
      }catch(e){ console.error('Duplicate failed:', e); toast('Failed: '+e.message, 'error'); }
    };
  });

  renderCart();
}

function generalGroceryRowHtml(item){
  const dueLabel = predictedDueLabel(item);
  const qtyUnit = [item.qty>1?item.qty:'', item.unit].filter(Boolean).join(' ');
  return `<div class="grocery-item">
    ${item.image ? `<img src="${item.image}"/>` : `<div style="width:52px;height:52px;border-radius:8px;background:var(--paper);flex:none;display:flex;align-items:center;justify-content:center;color:var(--text-dim);"><i class="ti ti-shopping-cart" aria-hidden="true"></i></div>`}
    <div class="info">
      <div class="name">${item.favorite?'<i class="ti ti-star-filled" style="color:var(--gold);font-size:13px;" aria-hidden="true"></i> ':''}${escapeHtml(item.name)}</div>
      <div class="price">${escapeHtml(item.category||'')}${item.price?' · $'+escapeHtml(String(item.price)):''}${qtyUnit?' · '+escapeHtml(qtyUnit):''}</div>
      ${item.notes?`<div class="price" style="font-style:italic;">${escapeHtml(item.notes)}</div>`:''}
      ${dueLabel ? `<div class="due">${dueLabel}</div>` : ''}
      ${item.inCart ? `<div class="due" style="color:var(--green);">${item.autoAdded?'Auto-added — running low':'In cart'}</div>` : ''}
    </div>
    <div class="grocery-actions-col">
      ${item.inCart
        ? `<button class="btn-outline" data-cart-remove-general="${item.id}">Remove from cart</button>`
        : `<button class="btn-primary" data-cart-add="${item.id}">Add to cart</button>`}
      <div class="grocery-actions-grid">
        <button class="btn-outline" data-grocery-edit="${item.id}" title="Edit"><i class="ti ti-edit" aria-hidden="true"></i> Edit</button>
        <button class="btn-outline" data-grocery-fav="${item.id}" title="Favorite"><i class="ti ti-star${item.favorite?'-filled':''}" aria-hidden="true"></i> ${item.favorite?'Unfav':'Fav'}</button>
        <button class="btn-outline" data-grocery-dup="${item.id}" title="Duplicate"><i class="ti ti-copy" aria-hidden="true"></i> Copy</button>
        <button class="btn-danger" data-grocery-delete="${item.id}" title="Delete"><i class="ti ti-trash" aria-hidden="true"></i> Delete</button>
      </div>
    </div>
  </div>`;
}

function cartRowHtml(item){
  const qty = item.cartQty || 1;
  const subtotal = (parseFloat(item.price)||0) * qty;
  return `<div class="cart-item">
    ${item.image ? `<img src="${item.image}" style="width:44px;height:44px;object-fit:cover;border-radius:8px;"/>` : ''}
    <div class="info">
      <div class="name">${escapeHtml(item.name)}${item.autoAdded?'<span class="stamp stamp-gold" style="margin-left:6px;">Auto</span>':''}</div>
      <div class="price">${item.price?'$'+parseFloat(item.price).toFixed(2)+' each':'no price set'}</div>
    </div>
    <input type="number" min="1" class="qty-input" data-cart-qty="${item.id}" value="${qty}" />
    <div class="cart-subtotal">$${subtotal.toFixed(2)}</div>
    <button class="btn-danger" data-cart-remove="${item.id}">Remove</button>
  </div>`;
}

function renderCart(){
  const cartItems = groceryItems.filter(i=>i.inCart);
  const listEl = document.getElementById('cartList');
  listEl.innerHTML = cartItems.length
    ? cartItems.map(cartRowHtml).join('')
    : '<div class="empty">Cart is empty. Add items from the general list above.</div>';

  document.querySelectorAll('[data-cart-qty]').forEach(inp=>{
    inp.onchange = async ()=>{
      const qty = Math.max(1, parseInt(inp.value)||1);
      try{ await withTimeout(db.collection('groceryItems').doc(inp.getAttribute('data-cart-qty')).update({ cartQty: qty }), 'Update quantity'); }
      catch(e){ console.error('Qty update failed:', e); toast('Failed to update quantity: '+e.message, 'error'); }
    };
  });
  document.querySelectorAll('[data-cart-remove]').forEach(btn=>{
    btn.onclick = async ()=>{
      try{ await withTimeout(db.collection('groceryItems').doc(btn.getAttribute('data-cart-remove')).update({ inCart:false }), 'Remove from cart'); }
      catch(e){ console.error('Remove from cart failed:', e); toast('Failed: '+e.message, 'error'); }
    };
  });

  const total = cartItems.reduce((s,i)=> s + (parseFloat(i.price)||0)*(i.cartQty||1), 0);
  document.getElementById('cartTotal').textContent = '$'+total.toFixed(2);
  document.getElementById('cartTotalCard').style.display = cartItems.length ? 'block' : 'none';
  const badge = document.getElementById('cartCountBadge');
  badge.style.display = cartItems.length ? 'inline-block' : 'none';
  badge.textContent = cartItems.length;

  const startBtn = document.getElementById('startShoppingBtn');
  if(activeSessionDoc){
    startBtn.innerHTML = '<i class="ti ti-player-play" aria-hidden="true"></i> Resume shopping trip';
  }else{
    startBtn.innerHTML = '<i class="ti ti-shopping-cart" aria-hidden="true"></i> Start shopping';
  }
}

document.getElementById('completeCartBtn').onclick = async ()=>{
  const cartItems = groceryItems.filter(i=>i.inCart);
  if(!cartItems.length) return;
  if(!confirm(`Mark all ${cartItems.length} cart items as purchased?`)) return;
  try{
    for(const item of cartItems){
      const history = item.purchaseHistory || [];
      history.push({ date: new Date().toISOString(), price: item.price || null, qty: item.cartQty || 1 });
      await withTimeout(db.collection('groceryItems').doc(item.id).update({
        purchaseHistory: history.slice(-12), inCart:false, cartQty:1, autoAdded:false, status:'done'
      }), 'Complete cart');
    }
    toast('✓ Purchase recorded — cart cleared', 'success');
  }catch(e){ console.error('Complete cart failed:', e); toast('Failed to complete: '+e.message, 'error'); }
};

document.getElementById('copyCartBtn').onclick = ()=>{
  const cartItems = groceryItems.filter(i=>i.inCart);
  if(!cartItems.length){ toast('Cart is empty'); return; }
  const total = cartItems.reduce((s,i)=> s + (parseFloat(i.price)||0)*(i.cartQty||1), 0);
  let text = `Jiox Restaurant Manager — Grocery List\n${new Date().toLocaleString()}\n\n`;
  cartItems.forEach(i=>{
    const qty = i.cartQty||1;
    const sub = (parseFloat(i.price)||0)*qty;
    text += `${i.name} x${qty}${i.price?' — $'+sub.toFixed(2):''}\n`;
  });
  text += `\nTotal: $${total.toFixed(2)}`;
  navigator.clipboard.writeText(text).then(()=>{
    toast('Copied — paste into WhatsApp, SMS, or email to share', 'success');
  }).catch(()=> toast('Could not copy — select and copy manually', 'error'));
};

document.getElementById('downloadCartPdfBtn').onclick = ()=>{
  const cartItems = groceryItems.filter(i=>i.inCart);
  if(!cartItems.length){ toast('Cart is empty'); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const RIGHT = 196;
  let y = drawPdfHeader(doc, 'Grocery Order Receipt');

  function drawColumnHeaders(){
    doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.setTextColor(107,114,128);
    doc.text('ITEM', 26, y);
    doc.text('QTY', 148, y, {align:'right'});
    doc.text('PRICE', 168, y, {align:'right'});
    doc.text('SUBTOTAL', RIGHT, y, {align:'right'});
    y += 3;
    doc.setDrawColor(227,224,214); doc.setLineWidth(0.4);
    doc.line(14, y, RIGHT, y);
    y += 7;
    doc.setTextColor(28,31,36);
  }
  function ensureSpace(needed){
    if(y + needed > 283){ doc.addPage(); y = 20; drawColumnHeaders(); }
  }

  drawColumnHeaders();
  let grandTotal = 0;

  CATEGORY_ORDER.forEach(cat=>{
    const group = cartItems.filter(i=>categoryBucket(i.category)===cat);
    if(!group.length) return;
    ensureSpace(14);
    doc.setFillColor(251,241,226); // gold-bg
    doc.rect(14, y-5, RIGHT-14, 7, 'F');
    doc.setFont('helvetica','bold'); doc.setFontSize(9.5); doc.setTextColor(184,134,63);
    doc.text(cat.toUpperCase(), 16, y);
    y += 8;

    let catTotal = 0;
    group.forEach(item=>{
      ensureSpace(11);
      const qty = item.cartQty || 1;
      const price = parseFloat(item.price)||0;
      const sub = price*qty;
      catTotal += sub; grandTotal += sub;

      let textX = 14;
      if(item.image){
        try{ doc.addImage(item.image, 'JPEG', 14, y-6.5, 9, 9); textX = 26; }
        catch(e){ console.warn('[pdf] Could not embed image for', item.name, e); }
      }
      doc.setFont('helvetica','normal'); doc.setFontSize(9.5); doc.setTextColor(28,31,36);
      doc.text(String(item.name).slice(0,42), textX, y);
      doc.text(String(qty), 148, y, {align:'right'});
      doc.text(price?('$'+price.toFixed(2)):'—', 168, y, {align:'right'});
      doc.text('$'+sub.toFixed(2), RIGHT, y, {align:'right'});
      y += 11;
    });

    ensureSpace(9);
    doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.setTextColor(107,114,128);
    doc.text(`${cat} subtotal:`, 148, y, {align:'right'});
    doc.setTextColor(28,31,36);
    doc.text('$'+catTotal.toFixed(2), RIGHT, y, {align:'right'});
    y += 10;
  });

  ensureSpace(16);
  doc.setDrawColor(22,35,58); doc.setLineWidth(0.6);
  doc.line(120, y-5, RIGHT, y-5);
  doc.setFont('helvetica','bold'); doc.setFontSize(13); doc.setTextColor(22,35,58);
  doc.text('TOTAL:', 160, y+2, {align:'right'});
  doc.text('$'+grandTotal.toFixed(2), RIGHT, y+2, {align:'right'});

  doc.save('the-sector-17-grocery-receipt-'+todayISO()+'.pdf');
};

// ================= SHOPPING MODE =================
let currentSession = null;      // { id, items:[{id,name,category,price,cartQty,status,note}], startedAt }
let activeSessionDoc = null;    // most recent 'active' session from Firestore, for resume
let pendingReceiptImage = null;
let shoppingHistory = [];

// Note: filtering by status client-side (rather than a Firestore where+orderBy combo)
// avoids needing to create a composite index in the Firebase console.
db.collection('shoppingSessions').onSnapshot(snap=>{
  const all = [];
  snap.forEach(doc=> all.push({ id: doc.id, ...doc.data() }));
  const activeDocs = all.filter(s=>s.status==='active').sort((a,b)=> new Date(b.startedAt||0)-new Date(a.startedAt||0));
  activeSessionDoc = activeDocs[0] || null;
  shoppingHistory = all.filter(s=>s.status==='completed');
  if(typeof renderCart === 'function' && document.getElementById('startShoppingBtn')) renderCart();
}, err=> console.error('[shopping] sessions listener failed:', err));

document.getElementById('startShoppingBtn').onclick = ()=>{
  const cartItems = groceryItems.filter(i=>i.inCart);
  if(activeSessionDoc){
    currentSession = { id: activeSessionDoc.id, items: activeSessionDoc.items, startedAt: activeSessionDoc.startedAt };
    toast('Resuming your paused shopping trip');
    openShoppingMode();
    return;
  }
  if(!cartItems.length){ toast('Cart is empty — add items before starting shopping'); return; }
  const items = cartItems.map(i=>({ id:i.id, name:i.name, category:i.category||'Other', price: parseFloat(i.price)||0, cartQty:i.cartQty||1, status:'pending', note:'' }));
  db.collection('shoppingSessions').add({ items, status:'active', startedAt: new Date().toISOString() })
    .then(ref=>{
      currentSession = { id: ref.id, items, startedAt: new Date().toISOString() };
      openShoppingMode();
    })
    .catch(e=>{ console.error('[shopping] Could not start session:', e); toast('Could not start shopping: '+e.message, 'error'); });
};

function openShoppingMode(){
  document.getElementById('shoppingModeModal').classList.add('show');
  renderShoppingMode();
}
function persistSession(){
  if(!currentSession) return;
  db.collection('shoppingSessions').doc(currentSession.id).update({ items: currentSession.items })
    .catch(e=> console.error('[shopping] Could not save progress:', e));
}
function setItemStatus(id, status){
  if(!currentSession) return;
  const item = currentSession.items.find(i=>i.id===id);
  if(!item) return;
  item.status = status;
  persistSession();
  renderShoppingMode();
}
function shoppingModeRowHtml(item, picked){
  const sub = (item.price||0) * (item.cartQty||1);
  const unavailable = item.status === 'unavailable' || item.status === 'skipped';
  return `<div class="shop-item ${picked?'picked':(unavailable?'unavailable':'')}">
    <button class="tap-circle" data-tap="${item.id}">${picked?'<i class="ti ti-check" aria-hidden="true"></i>':''}</button>
    <div class="info">
      <div class="name">${escapeHtml(item.name)}${item.note?` <span style="color:var(--text-dim);font-weight:400;">— ${escapeHtml(item.note)}</span>`:''}</div>
      <div class="sub">${escapeHtml(item.category)} · qty ${item.cartQty||1}${item.price?' · $'+sub.toFixed(2):''} ${item.status==='unavailable'?' · <b style="color:var(--red);">Not available</b>':''}${item.status==='skipped'?' · <b style="color:var(--text-dim);">Skipped</b>':''}${item.substitute?' · Substitute: '+escapeHtml(item.substitute):''}</div>
    </div>
    <div class="item-actions">
      ${picked || unavailable ? `<button class="btn-outline" data-undo="${item.id}">Undo</button>` : `
        <button class="btn-outline" data-unavailable="${item.id}">Not available</button>
        <button class="btn-outline" data-sub="${item.id}">Substitute</button>`}
    </div>
  </div>`;
}
function renderShoppingMode(){
  if(!currentSession) return;
  const q = normalize(document.getElementById('shopSearchInput').value);
  const items = currentSession.items.filter(i=> !q || normalize(i.name).includes(q));
  const remaining = items.filter(i=>i.status==='pending');
  const picked = items.filter(i=>i.status==='picked');
  const missing = currentSession.items.filter(i=>i.status==='unavailable'||i.status==='skipped');

  document.getElementById('shopRemainingList').innerHTML = remaining.length
    ? `<div class="shop-section-label">Remaining (${remaining.length})</div>` + remaining.map(i=>shoppingModeRowHtml(i,false)).join('')
    : '<div class="empty">Nothing left to pick — tap "Ready to pay" when you\'re done.</div>';
  document.getElementById('shopPickedWrap').innerHTML = picked.length
    ? `<div class="shop-section-label">Picked up (${picked.length})</div>` + picked.map(i=>shoppingModeRowHtml(i,true)).join('')
    : '';

  document.querySelectorAll('[data-tap]').forEach(btn=> btn.onclick = ()=> setItemStatus(btn.dataset.tap,'picked'));
  document.querySelectorAll('[data-undo]').forEach(btn=> btn.onclick = ()=> setItemStatus(btn.dataset.undo,'pending'));
  document.querySelectorAll('[data-unavailable]').forEach(btn=> btn.onclick = ()=> setItemStatus(btn.dataset.unavailable,'unavailable'));
  document.querySelectorAll('[data-sub]').forEach(btn=> btn.onclick = ()=>{
    const name = prompt('Substitute item name:');
    if(!name) return;
    const item = currentSession.items.find(i=>i.id===btn.dataset.sub);
    item.substitute = name;
    item.status = 'picked';
    persistSession();
    renderShoppingMode();
  });

  const totalCount = currentSession.items.length;
  const pickedCount = currentSession.items.filter(i=>i.status==='picked').length;
  const pct = totalCount ? Math.round((pickedCount+missing.length)/totalCount*100) : 0;
  document.getElementById('shopProgressLabel').textContent = `${pickedCount} of ${totalCount} picked up`;
  document.getElementById('shopProgressPct').textContent = pct+'%';
  document.getElementById('shopProgressFill').style.width = pct+'%';
  const runningTotal = currentSession.items.filter(i=>i.status==='picked').reduce((s,i)=>s+(i.price||0)*(i.cartQty||1),0);
  document.getElementById('shopRunningTotal').textContent = 'Running total: $'+runningTotal.toFixed(2);
  document.getElementById('shopMissingCount').textContent = missing.length+' missing / unavailable';
}
document.getElementById('shopSearchInput').addEventListener('input', renderShoppingMode);

document.getElementById('pauseShoppingBtn').onclick = ()=>{
  document.getElementById('shoppingModeModal').classList.remove('show');
  toast('Shopping trip paused — tap "Start shopping" to resume');
};
document.getElementById('exitShoppingBtn').onclick = async ()=>{
  if(!confirm('Exit and cancel this shopping trip? Nothing will be marked as purchased.')) return;
  try{
    if(currentSession) await db.collection('shoppingSessions').doc(currentSession.id).delete();
  }catch(e){ console.error('[shopping] Could not cancel session:', e); }
  currentSession = null;
  document.getElementById('shoppingModeModal').classList.remove('show');
};

document.getElementById('readyToPayBtn').onclick = ()=>{
  if(!currentSession) return;
  const picked = currentSession.items.filter(i=>i.status==='picked');
  const missing = currentSession.items.filter(i=>i.status==='unavailable'||i.status==='skipped');
  const estTotal = currentSession.items.reduce((s,i)=>s+(i.price||0)*(i.cartQty||1),0);
  const actualTotal = picked.reduce((s,i)=>s+(i.price||0)*(i.cartQty||1),0);
  document.getElementById('co-estTotal').textContent = '$'+estTotal.toFixed(2);
  document.getElementById('co-actualTotal').textContent = '$'+actualTotal.toFixed(2);
  document.getElementById('co-purchasedCount').textContent = picked.length;
  document.getElementById('co-missingCount').textContent = missing.length;
  document.getElementById('co-date').value = todayISO();
  document.getElementById('shoppingModeModal').classList.remove('show');
  document.getElementById('checkoutModal').classList.add('show');
};
document.getElementById('cancelCheckoutBtn').onclick = ()=>{
  document.getElementById('checkoutModal').classList.remove('show');
  document.getElementById('shoppingModeModal').classList.add('show');
};

document.getElementById('receiptUpload').onclick = ()=> document.getElementById('receiptFile').click();
document.getElementById('receiptFile').onchange = async (e)=>{
  const file = e.target.files[0];
  if(!file) return;
  try{
    pendingReceiptImage = await resizeImage(file, 1000);
    document.getElementById('receiptPreviewWrap').innerHTML = `<div class="receipt-preview"><img src="${pendingReceiptImage}"/><div class="rm" id="rmReceiptBtn" style="position:absolute;top:-6px;right:-6px;background:var(--red);color:#fff;border-radius:50%;width:20px;height:20px;display:flex;align-items:center;justify-content:center;font-size:11px;cursor:pointer;">×</div></div>`;
    document.getElementById('rmReceiptBtn').onclick = ()=>{ pendingReceiptImage = null; document.getElementById('receiptPreviewWrap').innerHTML=''; };
  }catch(err){ toast('Could not read receipt image', 'error'); }
  e.target.value = '';
};

document.getElementById('finishCheckoutBtn').onclick = async ()=>{
  if(!currentSession) return;
  const store = document.getElementById('co-store').value.trim();
  const purchaseDate = document.getElementById('co-date').value || todayISO();
  const location = document.getElementById('co-location').value.trim();
  const notes = document.getElementById('co-notes').value.trim();
  const picked = currentSession.items.filter(i=>i.status==='picked');
  const missing = currentSession.items.filter(i=>i.status==='unavailable'||i.status==='skipped');
  const estTotal = currentSession.items.reduce((s,i)=>s+(i.price||0)*(i.cartQty||1),0);
  const actualTotal = picked.reduce((s,i)=>s+(i.price||0)*(i.cartQty||1),0);

  const finishBtn = document.getElementById('finishCheckoutBtn');
  finishBtn.disabled = true;
  showLoading('Saving shopping session…');
  try{
    // Record purchase history + clear cart flags on the real grocery items.
    for(const item of currentSession.items){
      const groceryItem = groceryItems.find(g=>g.id===item.id);
      if(!groceryItem) continue;
      const update = { inCart:false, cartQty:1, autoAdded:false };
      if(item.status === 'picked'){
        const history = groceryItem.purchaseHistory || [];
        history.push({ date: new Date().toISOString(), price: groceryItem.price || null, qty: item.cartQty || 1 });
        update.purchaseHistory = history.slice(-12);
        update.status = 'done';
      }
      await withTimeout(db.collection('groceryItems').doc(item.id).update(update), 'Update item after shopping');
    }
    await withTimeout(db.collection('shoppingSessions').doc(currentSession.id).update({
      status:'completed', completedAt:new Date().toISOString(), store, purchaseDate, location, notes,
      receiptImage: pendingReceiptImage || null, estTotal, actualTotal,
      purchasedCount: picked.length, missingCount: missing.length
    }), 'Save shopping session');

    toast('✓ Shopping session saved', 'success');
    currentSession = null;
    pendingReceiptImage = null;
    document.getElementById('receiptPreviewWrap').innerHTML = '';
    ['co-store','co-location','co-notes'].forEach(id=>document.getElementById(id).value='');
    document.getElementById('checkoutModal').classList.remove('show');
  }catch(e){
    console.error('[shopping] Checkout failed:', e);
    toast('Could not finish checkout: '+e.message, 'error');
  }finally{
    finishBtn.disabled = false;
    hideLoading();
  }
};

function shoppingSessionRowHtml(s){
  const date = s.purchaseDate ? fmtDate(s.purchaseDate) : fmtDate(s.completedAt);
  return `<div class="session-row">
    <div class="top"><span>${escapeHtml(s.store || 'Unnamed store')}</span><span>$${(parseFloat(s.actualTotal)||0).toFixed(2)}</span></div>
    <div class="meta">${date}${s.location?' · '+escapeHtml(s.location):''} · ${s.purchasedCount||0} purchased${s.missingCount?', '+s.missingCount+' missing':''}</div>
    ${s.notes?`<div class="meta">${escapeHtml(s.notes)}</div>`:''}
    ${s.receiptImage?`<div class="shots" style="margin-top:8px;"><img src="${s.receiptImage}" data-full="${s.receiptImage}" style="width:56px;height:56px;object-fit:cover;border-radius:6px;border:1px solid var(--line);cursor:pointer;"/></div>`:''}
  </div>`;
}
document.getElementById('viewShoppingHistoryBtn').onclick = ()=>{
  const sorted = [...shoppingHistory].sort((a,b)=> new Date(b.completedAt||0) - new Date(a.completedAt||0));
  document.getElementById('shoppingHistoryList').innerHTML = sorted.length
    ? sorted.map(shoppingSessionRowHtml).join('')
    : '<div class="empty">No completed shopping trips yet.</div>';
  document.querySelectorAll('#shoppingHistoryList img[data-full]').forEach(img=>{
    img.onclick = ()=>{
      document.getElementById('lightboxImg').src = img.getAttribute('data-full');
      document.getElementById('lightbox').classList.add('show');
    };
  });
  document.getElementById('shoppingHistoryModal').classList.add('show');
};
document.getElementById('closeShoppingHistoryBtn').onclick = ()=> document.getElementById('shoppingHistoryModal').classList.remove('show');

let editingGroceryId = null;

document.getElementById('openGroceryFormBtn').onclick = ()=>{
  resetGroceryForm();
  document.getElementById('groceryForm').style.display='block';
  document.getElementById('groceryForm').scrollIntoView({behavior:'smooth'});
};
function resetGroceryForm(){
  editingGroceryId = null;
  document.getElementById('groceryFormTitle').textContent = 'Add grocery item';
  document.getElementById('saveGroceryBtn').textContent = 'Save item';
  ['g-name','g-price','g-notes'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('g-qty').value = 1;
  document.getElementById('g-category').selectedIndex = 0;
  document.getElementById('g-unit').selectedIndex = 0;
  groceryPendingShot = null;
  document.getElementById('groceryShotPreview').innerHTML='';
}
function openGroceryFormForEdit(item){
  resetGroceryForm();
  editingGroceryId = item.id;
  document.getElementById('groceryFormTitle').textContent = 'Edit grocery item';
  document.getElementById('saveGroceryBtn').textContent = 'Save changes';
  document.getElementById('g-name').value = item.name || '';
  if(item.category) document.getElementById('g-category').value = item.category;
  document.getElementById('g-price').value = item.price || '';
  document.getElementById('g-qty').value = item.qty || 1;
  if(item.unit) document.getElementById('g-unit').value = item.unit;
  document.getElementById('g-notes').value = item.notes || '';
  if(item.image){
    groceryPendingShot = item.image;
    document.getElementById('groceryShotPreview').innerHTML = `<div class="shot-preview"><img src="${item.image}"/></div>`;
  }
  document.getElementById('groceryForm').style.display='block';
  document.getElementById('groceryForm').scrollIntoView({behavior:'smooth'});
}
document.getElementById('cancelGroceryBtn').onclick = ()=>{
  resetGroceryForm();
  document.getElementById('groceryForm').style.display='none';
};
document.getElementById('groceryShotUpload').onclick = ()=> document.getElementById('groceryShotFile').click();
document.getElementById('groceryShotFile').onchange = async (e)=>{
  const file = e.target.files[0];
  if(!file) return;
  try{
    groceryPendingShot = await resizeImage(file, 500);
    document.getElementById('groceryShotPreview').innerHTML = `<div class="shot-preview"><img src="${groceryPendingShot}"/></div>`;
  }catch(err){ toast('Could not read image', 'error'); }
  e.target.value = '';
};

document.getElementById('saveGroceryBtn').onclick = async ()=>{
  const name = document.getElementById('g-name').value.trim();
  if(!name){ toast('Item name is required'); return; }
  const saveBtn = document.getElementById('saveGroceryBtn');
  saveBtn.disabled = true;
  showLoading('Saving item…');
  const data = {
    name,
    category: document.getElementById('g-category').value,
    price: document.getElementById('g-price').value.trim(),
    qty: parseInt(document.getElementById('g-qty').value) || 1,
    unit: document.getElementById('g-unit').value,
    notes: document.getElementById('g-notes').value.trim(),
    image: groceryPendingShot || null
  };
  try{
    if(editingGroceryId){
      console.log('[grocery] Updating item', editingGroceryId, data);
      await withTimeout(db.collection('groceryItems').doc(editingGroceryId).update(data), 'Grocery item update');
      toast('✓ Item updated', 'success');
    }else{
      console.log('[grocery] Adding item', name);
      await withTimeout(db.collection('groceryItems').add({
        ...data, status:'active', inCart:false, cartQty:1, autoAdded:false, favorite:false, purchaseHistory:[]
      }), 'Grocery item save');
      toast('✓ Item added to general list', 'success');
    }
    resetGroceryForm();
    document.getElementById('groceryForm').style.display='none';
  }catch(e){
    console.error('[grocery] Save failed:', e);
    toast('Save failed: '+e.message, 'error');
  }finally{
    saveBtn.disabled = false;
    hideLoading();
  }
};

// ================= EXPENSES =================
let expenses = [];
document.getElementById('openExpenseFormBtn').onclick = ()=>{
  document.getElementById('e-date').value = todayISO();
  document.getElementById('expenseForm').style.display='block';
  document.getElementById('expenseForm').scrollIntoView({behavior:'smooth'});
};
document.getElementById('cancelExpenseBtn').onclick = ()=> document.getElementById('expenseForm').style.display='none';
document.getElementById('saveExpenseBtn').onclick = async ()=>{
  const date = document.getElementById('e-date').value || todayISO();
  const category = document.getElementById('e-category').value.trim();
  const amount = parseFloat(document.getElementById('e-amount').value) || 0;
  const note = document.getElementById('e-note').value.trim();
  if(!category || !amount){ toast('Category and amount are required'); return; }
  const saveBtn = document.getElementById('saveExpenseBtn');
  saveBtn.disabled = true;
  const originalText = saveBtn.textContent;
  saveBtn.textContent = 'Saving…';
  try{
    console.log('[expenses] Adding', { date, category, amount, note });
    await withTimeout(db.collection('expenses').add({ date, category, amount, note }), 'Expense save');
    console.log('[expenses] Save confirmed by Firestore ✓');
    toast('Expense saved', 'success');
    ['e-category','e-amount','e-note'].forEach(id=>document.getElementById(id).value='');
    document.getElementById('expenseForm').style.display='none';
  }catch(e){
    console.error('[expenses] Save failed:', e);
    toast('Save failed: '+e.message, 'error');
  }finally{
    saveBtn.disabled = false;
    saveBtn.textContent = originalText;
  }
};
function renderExpenses(){
  const total = expenses.reduce((sum,e)=>sum+(parseFloat(e.amount)||0),0);
  document.getElementById('expTotal').textContent = '$'+total.toFixed(2);
  document.getElementById('expenseList').innerHTML = expenses.length ? expenses.map(e=>`
    <div class="exp-row">
      <div>
        <div style="font-weight:600;">${escapeHtml(e.category)}</div>
        <div style="color:var(--text-dim);font-size:12px;">${fmtDate(e.date)}${e.note?' · '+escapeHtml(e.note):''}</div>
      </div>
      <div style="display:flex;align-items:center;gap:10px;">
        <div style="font-weight:600;">$${parseFloat(e.amount).toFixed(2)}</div>
        <button class="btn-danger" data-exp-del="${e.id}">Delete</button>
      </div>
    </div>
  `).join('') : '<div class="empty">No expenses logged yet.</div>';
  document.querySelectorAll('[data-exp-del]').forEach(btn=>{
    btn.onclick = ()=> db.collection('expenses').doc(btn.dataset.expDel).delete()
      .catch(e=>{ console.error('Expense delete failed:', e); toast('Delete failed: '+e.message, 'error'); });
  });
}

// ================= NOTES =================
let notes = [];
document.getElementById('openNoteFormBtn').onclick = ()=>{
  document.getElementById('noteForm').style.display='block';
};
document.getElementById('cancelNoteBtn').onclick = ()=> document.getElementById('noteForm').style.display='none';
document.getElementById('saveNoteBtn').onclick = async ()=>{
  const text = document.getElementById('n-text').value.trim();
  if(!text){ return; }
  const saveBtn = document.getElementById('saveNoteBtn');
  saveBtn.disabled = true;
  const originalText = saveBtn.textContent;
  saveBtn.textContent = 'Saving…';
  try{
    console.log('[notes] Adding note');
    await withTimeout(db.collection('notes').add({ text, date: new Date().toISOString() }), 'Note save');
    console.log('[notes] Save confirmed by Firestore ✓');
    document.getElementById('n-text').value = '';
    document.getElementById('noteForm').style.display='none';
    toast('Note saved', 'success');
  }catch(e){
    console.error('[notes] Save failed:', e);
    toast('Save failed: '+e.message, 'error');
  }finally{
    saveBtn.disabled = false;
    saveBtn.textContent = originalText;
  }
};
function renderNotes(){
  document.getElementById('notesList').innerHTML = notes.length ? notes.map(n=>`
    <div class="note-card">
      <div>${escapeHtml(n.text)}</div>
      <div class="date">${fmtDate(n.date)}
        <button class="btn-danger" data-note-del="${n.id}" style="margin-left:8px;">Delete</button>
      </div>
    </div>
  `).join('') : '<div class="empty">No notes yet.</div>';
  document.querySelectorAll('[data-note-del]').forEach(btn=>{
    btn.onclick = ()=> db.collection('notes').doc(btn.dataset.noteDel).delete()
      .catch(e=>{ console.error('Note delete failed:', e); toast('Delete failed: '+e.message, 'error'); });
  });
}

// ================= AUTO-DETECTED ORDERS (Gmail → Firestore → live popup) =================
// A separate, private Google Apps Script (NOT part of this public repo) watches your Gmail
// for DoorDash order emails and writes a document into the `incomingOrders` collection here.
// This app never touches your inbox directly — it only reads what Apps Script already wrote
// to Firestore, which is the only safe way to do this from a public, client-side website.
let handledOrderIds = new Set();     // guards against re-showing a popup if the snapshot re-fires
let orderFeedItems = [];
let notifPermissionAsked = false;

function startIncomingOrdersListener(){
  db.collection('incomingOrders').onSnapshot(snap=>{
    orderFeedItems = [];
    snap.forEach(doc=> orderFeedItems.push({ id: doc.id, ...doc.data() }));
    orderFeedItems.sort((a,b)=> new Date(b.receivedAt||0) - new Date(a.receivedAt||0));

    const unseenCount = orderFeedItems.filter(o=>!o.processed).length;
    const bellCount = document.getElementById('orderBellCount');
    bellCount.style.display = unseenCount ? 'inline-block' : 'none';
    bellCount.textContent = unseenCount;

    snap.docChanges().forEach(change=>{
      if(change.type !== 'added') return;
      const order = { id: change.doc.id, ...change.doc.data() };
      if(order.processed) return;               // already handled by another device/tab
      if(handledOrderIds.has(order.id)) return;  // already shown in this tab
      handledOrderIds.add(order.id);
      handleIncomingOrder(order);
    });
  }, err=> console.error('[incomingOrders] listener failed:', err));
}

async function handleIncomingOrder(orderDoc){
  const p = orderDoc.parsed || {};
  const name = (p.name||'').trim();
  if(!name){
    // Nothing usable to match/save — leave it unprocessed for manual review in the feed.
    showOrderPopup({ title:'Unrecognized order email', isNew:false, flagged:true, name:'Needs manual review', meta:`Could not detect a customer name — open the live feed to review the raw email.` });
    return;
  }
  const phone = (p.phone||'').trim();
  const email = (p.email||'').trim();
  const restaurant = p.restaurant || '';
  const order = {
    orderId: p.orderId || orderDoc.gmailMessageId || '',
    date: orderDoc.receivedAt || new Date().toISOString(),
    restaurant, amount: parseFloat(p.amount)||0, promotion: p.promotion||'', comment: p.itemsSummary||'',
    status: p.status||'', importedAt: new Date().toISOString(), source:'doordash_email'
  };
  const classification = classifyOrderStatus(p.status||'', p.itemsSummary||'');
  let incident = null;
  if(classification){
    incident = { date: order.date, platform: restaurant, order: order.orderId, amount: order.amount||'', issue: classification.issue, notes: p.itemsSummary||'', shots: [] };
  }

  const key = normalize(name)+'|'+normalize(phone);
  let existing = (phone ? customers.find(c=> normalize(c.name)+'|'+normalize(c.phone) === key) : null)
              || (email ? customers.find(c=> c.email && normalize(c.email)===normalize(email)) : null)
              || customers.find(c=> normalize(c.name)===normalize(name));

  try{
    if(existing){
      const or = mergeOrderIntoList(existing.orders||[], order, existing.name);
      const data = {};
      if(or.isNew || or.isMerge) data.orders = or.orders;
      if(incident){
        const ir = mergeIncidentIntoList(existing.incidents||[], incident, existing.name);
        if(ir.isNew || ir.isMerge) data.incidents = ir.incidents;
      }
      if(Object.keys(data).length) await db.collection('customers').doc(existing.id).update(data);
      await db.collection('incomingOrders').doc(orderDoc.id).update({ processed:true, action:'matched', matchedCustomerId: existing.id });
      showOrderPopup({
        title: incident ? 'Order flagged — existing customer' : (or.isMerge ? 'Order info merged — existing customer' : 'New order — existing customer'),
        isNew:false, flagged:!!incident, custId: existing.id, name: existing.name,
        meta: `${restaurant||'Restaurant not detected'} · $${(order.amount||0).toFixed(2)}${incident?' · '+classification.issue:''}`
      });
    }else{
      const ref = db.collection('customers').doc();
      await ref.set({
        name, phone, email, restaurant, statusTag:'', rating:0,
        incidents: incident ? [incident] : [], orders:[order],
        auditLog:[{ date:new Date().toISOString(), action:'Created automatically from a DoorDash order email' }]
      });
      await db.collection('incomingOrders').doc(orderDoc.id).update({ processed:true, action:'created', matchedCustomerId: ref.id });
      showOrderPopup({
        title: incident ? 'Order flagged — new customer' : 'New customer + order saved',
        isNew:true, flagged:!!incident, custId: ref.id, name,
        meta: `${restaurant||'Restaurant not detected'} · $${(order.amount||0).toFixed(2)}${incident?' · '+classification.issue:''}`
      });
    }
  }catch(e){
    console.error('[incomingOrders] Could not process order:', e);
    toast('Could not auto-save an incoming order: '+e.message, 'error');
  }
}

function playPopSound(){
  try{
    const ctx = new (window.AudioContext||window.webkitAudioContext)();
    const osc = ctx.createOscillator(); const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = 880; gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime+0.35);
    osc.start(); osc.stop(ctx.currentTime+0.35);
  }catch(e){ /* audio not available — non-critical */ }
}

function showOrderPopup({title, isNew, flagged, custId, name, meta}){
  playPopSound();
  if('Notification' in window && Notification.permission === 'granted'){
    try{ new Notification(title, { body: `${name} — ${meta}` }); }catch(e){}
  }
  const wrap = document.getElementById('orderPopupWrap');
  const el = document.createElement('div');
  el.className = 'order-popup' + (flagged ? ' flagged' : (isNew ? ' new-cust' : ''));
  el.innerHTML = `
    <div class="op-top"><span>${escapeHtml(title)}</span><button class="op-close">×</button></div>
    <div class="op-name">${escapeHtml(name)}</div>
    <div class="op-meta">${escapeHtml(meta)}</div>
    <div class="op-actions">
      ${custId?`<button class="btn-primary" data-view-cust="${custId}">View profile</button>`:''}
      <button class="btn-outline op-dismiss">Dismiss</button>
    </div>`;
  wrap.appendChild(el);
  const remove = ()=> el.remove();
  el.querySelector('.op-close').onclick = remove;
  el.querySelector('.op-dismiss').onclick = remove;
  if(custId) el.querySelector('[data-view-cust]').onclick = ()=>{
    document.querySelector('.tab[data-view="customers"]').click();
    showCustomerDetail(custId);
    remove();
  };
  setTimeout(remove, 15000);
}

function renderOrderFeed(){
  document.getElementById('orderFeedList').innerHTML = orderFeedItems.length ? orderFeedItems.slice(0,60).map(o=>{
    const p = o.parsed || {};
    return `<div class="feed-row">
      <div class="top"><span>${escapeHtml(p.name || 'Unrecognized email')}</span><span>${o.processed?(o.action==='created'?'New profile':'Matched'):'Needs review'}</span></div>
      <div class="meta">${escapeHtml(p.restaurant||'Restaurant not detected')} · $${(parseFloat(p.amount)||0).toFixed(2)}${p.status?' · '+escapeHtml(p.status):''} · ${fmtDate(o.receivedAt)}</div>
      ${o.matchedCustomerId?`<button class="btn-outline" style="margin-top:6px;font-size:12px;padding:5px 10px;" data-feed-view="${o.matchedCustomerId}">View profile</button>`:''}
    </div>`;
  }).join('') : '<div class="empty">No auto-detected orders yet. Once your Gmail sync is set up, DoorDash order emails will show up here within about a minute.</div>';
  document.querySelectorAll('[data-feed-view]').forEach(btn=> btn.onclick = ()=>{
    document.getElementById('orderFeedModal').classList.remove('show');
    document.querySelector('.tab[data-view="customers"]').click();
    showCustomerDetail(btn.dataset.feedView);
  });
}

document.getElementById('orderBellBtn').onclick = ()=>{
  renderOrderFeed();
  document.getElementById('orderFeedNotifHint').style.display = ('Notification' in window && Notification.permission==='default') ? 'block' : 'none';
  document.getElementById('orderFeedModal').classList.add('show');
};
document.getElementById('closeOrderFeedBtn').onclick = ()=> document.getElementById('orderFeedModal').classList.remove('show');
document.getElementById('enableNotifBtn').onclick = ()=>{
  if('Notification' in window) Notification.requestPermission().then(()=> {
    document.getElementById('orderFeedNotifHint').style.display = Notification.permission==='default' ? 'block' : 'none';
  });
};
