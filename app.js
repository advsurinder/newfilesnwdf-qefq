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

function custRowHtml(c){
  const count = (c.incidents||[]).length;
  const colorClass = nameColorClass(count);
  let tag = '';
  if(count >= 2) tag = `<span class="stamp stamp-red" style="margin-left:8px;">Repeated</span>`;
  else if(count === 1) tag = `<span class="stamp stamp-gold" style="margin-left:8px;">Defaulter</span>`;
  return `<div class="cust-row" data-cust-id="${c.id}">
    <div>
      <div class="name ${colorClass}">${escapeHtml(c.name)}${tag}${c.restaurant?`<span class="rest-tag">${escapeHtml(c.restaurant)}</span>`:''}</div>
      <div class="meta">${escapeHtml(c.phone||'')}${c.email?' · '+escapeHtml(c.email):''}</div>
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
  if(e.key==='Enter') runCustomerSearch();
});
document.getElementById('resetCustBtn').onclick = ()=>{
  document.getElementById('custSearch').value = '';
  lastSearchRan = false;
  document.getElementById('custSearchResults').innerHTML = '<div class="empty">Type a name, phone, or email above and tap Search to see matching customers.</div>';
  document.getElementById('custDetail').innerHTML = '';
  selectedCustId = null;
};

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
    (c.incidents||[]).forEach(inc=>{
      if(y > 280){ doc.addPage(); y = 20; }
      doc.text(`   • ${fmtDate(inc.date)} — ${inc.platform||''} — ${inc.issue||''}${inc.amount?' ($'+inc.amount+')':''}`, 14, y);
      y += 5;
    });
    y += 4;
  });
  doc.save('the-sector-17-defaulters.pdf');
};

// ---------- ALL CUSTOMERS (roster of every customer, not just defaulters) ----------
document.getElementById('viewAllCustomersBtn').onclick = ()=>{
  const all = [...customers].sort((a,b)=>(a.name||'').localeCompare(b.name||''));
  const listEl = document.getElementById('allCustomersList');
  listEl.innerHTML = all.length
    ? `<div style="color:var(--text-dim);font-size:12.5px;margin-bottom:8px;">${all.length} customer${all.length>1?'s':''} on file</div>` + all.map(c=>custRowHtml(c)).join('')
    : '<div class="empty">No customers on file yet.</div>';
  document.querySelectorAll('#allCustomersList [data-cust-id]').forEach(row=>{
    row.onclick = ()=>{
      document.getElementById('allCustomersModal').classList.remove('show');
      showCustomerDetail(row.getAttribute('data-cust-id'));
    };
  });
  document.getElementById('allCustomersModal').classList.add('show');
};
document.getElementById('closeAllCustomersBtn').onclick = ()=> document.getElementById('allCustomersModal').classList.remove('show');

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
    (c.incidents||[]).forEach(inc=>{
      if(y > 280){ doc.addPage(); y = 20; }
      doc.text(`   • ${fmtDate(inc.date)} — ${inc.platform||''} — ${inc.issue||''}${inc.amount?' ($'+inc.amount+')':''}`, 14, y);
      y += 5;
    });
    y += 4;
  });
  doc.save('the-sector-17-all-customers.pdf');
};

function showCustomerDetail(id){
  selectedCustId = id;
  const c = customers.find(x=>x.id===id);
  if(!c) return;
  const incidents = c.incidents || [];
  const isFlagged = incidents.length >= 2;
  const stamp = isFlagged
    ? `<span class="stamp stamp-red"><i class="ti ti-alert-triangle" aria-hidden="true"></i> Repeat dispute history</span>`
    : incidents.length===1 ? `<span class="stamp stamp-gold">1 prior incident</span>` : `<span class="stamp stamp-green">No incidents</span>`;

  const incidentHtml = incidents.map(inc=>`
    <div class="incident">
      <div class="meta"><span>${fmtDate(inc.date)} · ${escapeHtml(inc.platform||'')}</span><span>${escapeHtml(inc.order||'')}</span></div>
      <div>${escapeHtml(inc.issue||'')}${inc.amount?' — $'+escapeHtml(String(inc.amount)):''}</div>
      ${inc.notes?`<div style="color:var(--text-dim);margin-top:4px;">${escapeHtml(inc.notes)}</div>`:''}
      ${(inc.shots&&inc.shots.length)?`<div class="shots">${inc.shots.map(s=>`<img src="${s}" data-full="${s}" />`).join('')}</div>`:''}
    </div>
  `).join('');

  let summary = '';
  if(incidents.length){
    const lines = [`Customer: ${c.name}${c.phone?' ('+c.phone+')':''}`, `Prior incidents on file: ${incidents.length}`];
    incidents.forEach((inc,i)=> lines.push(`${i+1}. ${fmtDate(inc.date)} — ${inc.platform} order ${inc.order||'n/a'} — ${inc.issue}${inc.amount?` ($${inc.amount})`:''}`));
    lines.push('','Requesting: cancellation of this order without impact to our store cancellation rate, given the documented history above. Please confirm resolution and case number by email for our records.');
    summary = `<div class="summary-box">${escapeHtml(lines.join('\n'))}</div>`;
  }

  document.getElementById('custDetail').innerHTML = `
    <div class="card">
      ${stamp}
      <div style="font-size:19px;font-weight:600;margin:12px 0 2px;" class="${nameColorClass(incidents.length)}">${escapeHtml(c.name)}${c.restaurant?`<span class="rest-tag">${escapeHtml(c.restaurant)}</span>`:''}</div>
      <div style="color:var(--text-dim);font-size:13px;margin-bottom:12px;">${escapeHtml(c.phone||'')}${c.email?' · '+escapeHtml(c.email):''}</div>
      ${incidentHtml}
      ${summary}
      <div style="display:flex;gap:10px;margin-top:14px;">
        ${incidents.length?`<button class="btn-outline" id="copySummaryBtn"><i class="ti ti-copy" aria-hidden="true"></i> Copy summary</button>`:''}
        <button class="btn-danger" id="deleteCustBtn">Delete record</button>
      </div>
    </div>
  `;
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

document.getElementById('openCustFormBtn').onclick = ()=>{
  matchedExistingId = null;
  document.getElementById('custMatchHint').innerHTML = '';
  document.getElementById('custForm').style.display='block';
  document.getElementById('custForm').scrollIntoView({behavior:'smooth'});
};
document.getElementById('cancelCustBtn').onclick = ()=>{
  matchedExistingId = null;
  document.getElementById('custMatchHint').innerHTML = '';
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

  if(!name){ toast('Customer name is required'); return; }

  saveBtn.disabled = true;
  showLoading('Saving customer…');

  const key = normalize(name)+'|'+normalize(phone);
  let existing = matchedExistingId
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
      console.log('[customers] Updating existing record', existing.id, { name, phone, email, restaurant });
      await withTimeout(
        db.collection('customers').doc(existing.id).update({ name, phone, email, restaurant, incidents }),
        'Customer save'
      );
    }else{
      console.log('[customers] Creating new record', { name, phone, email, restaurant });
      await withTimeout(
        db.collection('customers').add({
          name, phone, email, restaurant,
          incidents: newIncident ? [newIncident] : []
        }),
        'Customer save'
      );
    }
    console.log('[customers] Save confirmed by Firestore ✓');
    toast('✓ Customer saved successfully', 'success');
    // Full reset — text fields, dropdowns back to their first option, incident section collapsed
    ['f-name','f-phone','f-email','f-order','f-amount','f-notes'].forEach(id=>document.getElementById(id).value='');
    document.getElementById('f-restaurant').selectedIndex = 0;
    document.getElementById('f-platform').selectedIndex = 0;
    document.getElementById('f-issue').selectedIndex = 0;
    document.getElementById('f-isIncident').value = 'no';
    document.getElementById('incidentFields').style.display = 'none';
    custPendingShots = [];
    renderCustShotPreviews();
    document.getElementById('custForm').style.display='none';
    matchedExistingId = null;
    document.getElementById('custMatchHint').innerHTML = '';
  }catch(e){
    console.error('Save customer failed:', e);
    toast('Save failed: '+e.message, 'error');
  }finally{
    saveBtn.disabled = false;
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

  renderCart();
}

function generalGroceryRowHtml(item){
  const dueLabel = predictedDueLabel(item);
  return `<div class="grocery-item">
    ${item.image ? `<img src="${item.image}"/>` : `<div style="width:52px;height:52px;border-radius:8px;background:var(--paper);flex:none;display:flex;align-items:center;justify-content:center;color:var(--text-dim);"><i class="ti ti-shopping-cart" aria-hidden="true"></i></div>`}
    <div class="info">
      <div class="name">${escapeHtml(item.name)}</div>
      <div class="price">${escapeHtml(item.category||'')}${item.price?' · $'+escapeHtml(String(item.price)):''}</div>
      ${dueLabel ? `<div class="due">${dueLabel}</div>` : ''}
      ${item.inCart ? `<div class="due" style="color:var(--green);">${item.autoAdded?'Auto-added — running low':'In cart'}</div>` : ''}
    </div>
    ${item.inCart
      ? `<button class="btn-outline" data-cart-remove-general="${item.id}">Remove from cart</button>`
      : `<button class="btn-primary" data-cart-add="${item.id}">Add to cart</button>`}
    <button class="btn-danger" data-grocery-delete="${item.id}" style="margin-left:4px;">Delete</button>
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

document.getElementById('openGroceryFormBtn').onclick = ()=>{
  document.getElementById('groceryForm').style.display='block';
  document.getElementById('groceryForm').scrollIntoView({behavior:'smooth'});
};
document.getElementById('cancelGroceryBtn').onclick = ()=> document.getElementById('groceryForm').style.display='none';
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
  try{
    console.log('[grocery] Adding item', name);
    await withTimeout(db.collection('groceryItems').add({
      name,
      category: document.getElementById('g-category').value,
      price: document.getElementById('g-price').value.trim(),
      image: groceryPendingShot || null,
      status: 'active',
      inCart: false,
      cartQty: 1,
      autoAdded: false,
      purchaseHistory: []
    }), 'Grocery item save');
    console.log('[grocery] Save confirmed by Firestore ✓');
    toast('✓ Item added to general list', 'success');
    ['g-name','g-price'].forEach(id=>document.getElementById(id).value='');
    document.getElementById('g-category').selectedIndex = 0;
    groceryPendingShot = null;
    document.getElementById('groceryShotPreview').innerHTML='';
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
