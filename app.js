// ---------- FIREBASE INIT ----------
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

const LOGIN_DOMAIN_SUFFIX = "@jiox.net"; // usernames are stored as username@jiox.net in Firebase Auth

// ---------- SMALL HELPERS ----------
function toast(msg, type){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.background = type==='error' ? 'var(--red)' : type==='success' ? 'var(--green)' : 'var(--navy)';
  t.classList.add('show');
  clearTimeout(t._hideTimer);
  t._hideTimer = setTimeout(()=>t.classList.remove('show'), type==='error' ? 4500 : 2800);
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
  try{
    await auth.signInWithEmailAndPassword(email, pass);
  }catch(e){
    document.getElementById('loginError').style.display = 'block';
    document.getElementById('loginError').textContent = e.message.replace('Firebase: ','');
  }
};
document.getElementById('logoutBtn').onclick = ()=> auth.signOut();

auth.onAuthStateChanged(user=>{
  if(user){
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('appScreen').style.display = 'block';
    startListeners();
  }else{
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
  db.collection('customers').onSnapshot(snap=>{
    customers = [];
    snap.forEach(doc=> customers.push({ id: doc.id, ...doc.data() }));
    renderCustomerLists();
  });
  db.collection('groceryItems').onSnapshot(snap=>{
    groceryItems = [];
    snap.forEach(doc=> groceryItems.push({ id: doc.id, ...doc.data() }));
    checkAutoReorder();
    renderGrocery();
  });
  db.collection('expenses').orderBy('date','desc').onSnapshot(snap=>{
    expenses = [];
    snap.forEach(doc=> expenses.push({ id: doc.id, ...doc.data() }));
    renderExpenses();
  });
  db.collection('notes').orderBy('date','desc').onSnapshot(snap=>{
    notes = [];
    snap.forEach(doc=> notes.push({ id: doc.id, ...doc.data() }));
    renderNotes();
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
  doc.setFontSize(14);
  doc.text('Jiox Restaurant Manager — Defaulter Customers', 14, 16);
  doc.setFontSize(9);
  doc.text('Generated ' + new Date().toLocaleString(), 14, 22);
  let y = 32;
  defaulters.forEach((c, i)=>{
    const count = (c.incidents||[]).length;
    if(y > 275){ doc.addPage(); y = 20; }
    doc.setFontSize(11);
    doc.text(`${i+1}. ${c.name}  (${count} incident${count>1?'s':''})`, 14, y);
    y += 5;
    doc.setFontSize(9);
    doc.text(`Phone: ${c.phone||'—'}   Email: ${c.email||'—'}   Restaurant: ${c.restaurant||'—'}`, 14, y);
    y += 5;
    (c.incidents||[]).forEach(inc=>{
      if(y > 280){ doc.addPage(); y = 20; }
      doc.text(`   • ${fmtDate(inc.date)} — ${inc.platform||''} — ${inc.issue||''}${inc.amount?' ($'+inc.amount+')':''}`, 14, y);
      y += 5;
    });
    y += 4;
  });
  doc.save('jiox-defaulters.pdf');
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
      await db.collection('customers').doc(id).delete();
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
  saveBtn.textContent = 'Saving…';

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
      await db.collection('customers').doc(existing.id).update({ name, phone, email, restaurant, incidents });
    }else{
      await db.collection('customers').add({
        name, phone, email, restaurant,
        incidents: newIncident ? [newIncident] : []
      });
    }
    toast('✓ Customer saved successfully', 'success');
    ['f-name','f-phone','f-email','f-order','f-amount','f-notes'].forEach(id=>document.getElementById(id).value='');
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
    saveBtn.textContent = 'Save';
  }
};

// ================= GROCERY =================
let groceryItems = [];
let groceryPendingShot = null;

function daysBetween(a,b){ return Math.round((new Date(b)-new Date(a))/86400000); }

function checkAutoReorder(){
  // If a "done" item's predicted next-due date has passed, move it back to active.
  groceryItems.forEach(async item=>{
    if(item.status !== 'done') return;
    const history = item.purchaseHistory || [];
    if(history.length < 2) return;
    const sorted = [...history].sort((a,b)=> new Date(a.date)-new Date(b.date));
    let totalGap = 0;
    for(let i=1;i<sorted.length;i++) totalGap += daysBetween(sorted[i-1].date, sorted[i].date);
    const avgGap = totalGap / (sorted.length-1);
    const lastDate = sorted[sorted.length-1].date;
    const nextDue = new Date(lastDate); nextDue.setDate(nextDue.getDate()+Math.round(avgGap));
    if(new Date() >= nextDue){
      await db.collection('groceryItems').doc(item.id).update({ status:'active' });
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
  const active = groceryItems.filter(i=>i.status!=='done').sort((a,b)=>(a.name||'').localeCompare(b.name||''));
  const done = groceryItems.filter(i=>i.status==='done').sort((a,b)=>(a.name||'').localeCompare(b.name||''));

  document.getElementById('activeGroceryList').innerHTML = active.length ? active.map(groceryRowHtml).join('') : '<div class="empty">Nothing on this week\'s list yet. Tap "Add item."</div>';
  document.getElementById('doneGroceryList').innerHTML = done.length ? done.map(groceryRowHtml).join('') : '<div class="empty">Items you\'ve bought will move here until they\'re due again.</div>';

  document.querySelectorAll('[data-grocery-toggle]').forEach(btn=>{
    btn.onclick = async ()=>{
      const id = btn.getAttribute('data-grocery-toggle');
      const item = groceryItems.find(i=>i.id===id);
      if(!item) return;
      if(item.status === 'done'){
        await db.collection('groceryItems').doc(id).update({ status:'active' });
      }else{
        const history = item.purchaseHistory || [];
        history.push({ date: new Date().toISOString(), price: item.price || null });
        await db.collection('groceryItems').doc(id).update({ status:'done', purchaseHistory: history.slice(-12) });
      }
    };
  });
  document.querySelectorAll('[data-grocery-delete]').forEach(btn=>{
    btn.onclick = async ()=>{
      if(!confirm('Remove this item permanently?')) return;
      await db.collection('groceryItems').doc(btn.getAttribute('data-grocery-delete')).delete();
    };
  });
}

function groceryRowHtml(item){
  const isDone = item.status === 'done';
  const dueLabel = predictedDueLabel(item);
  return `<div class="grocery-item">
    ${item.image ? `<img src="${item.image}"/>` : `<div style="width:52px;height:52px;border-radius:8px;background:var(--paper);flex:none;display:flex;align-items:center;justify-content:center;color:var(--text-dim);"><i class="ti ti-shopping-cart" aria-hidden="true"></i></div>`}
    <div class="info">
      <div class="name">${escapeHtml(item.name)}</div>
      <div class="price">${escapeHtml(item.category||'')}${item.price?' · $'+escapeHtml(String(item.price)):''}</div>
      ${dueLabel ? `<div class="due">${dueLabel}</div>` : ''}
    </div>
    <button class="checkbtn ${isDone?'done':''}" data-grocery-toggle="${item.id}" aria-label="${isDone?'Mark needed again':'Mark purchased'}">
      <i class="ti ${isDone?'ti-refresh':'ti-check'}" aria-hidden="true"></i>
    </button>
    <button class="btn-danger" data-grocery-delete="${item.id}" style="margin-left:4px;">Delete</button>
  </div>`;
}

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
  }catch(err){ toast('Could not read image'); }
  e.target.value = '';
};

document.getElementById('saveGroceryBtn').onclick = async ()=>{
  const name = document.getElementById('g-name').value.trim();
  if(!name){ toast('Item name is required'); return; }
  try{
    await db.collection('groceryItems').add({
      name,
      category: document.getElementById('g-category').value.trim(),
      price: document.getElementById('g-price').value.trim(),
      image: groceryPendingShot || null,
      status: 'active',
      purchaseHistory: []
    });
    toast('Item added');
  }catch(e){ toast('Save failed: '+e.message); }
  ['g-name','g-category','g-price'].forEach(id=>document.getElementById(id).value='');
  groceryPendingShot = null;
  document.getElementById('groceryShotPreview').innerHTML='';
  document.getElementById('groceryForm').style.display='none';
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
  try{
    await db.collection('expenses').add({ date, category, amount, note });
    toast('Expense saved');
  }catch(e){ toast('Save failed: '+e.message); }
  ['e-category','e-amount','e-note'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('expenseForm').style.display='none';
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
    btn.onclick = ()=> db.collection('expenses').doc(btn.dataset.expDel).delete();
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
  await db.collection('notes').add({ text, date: new Date().toISOString() });
  document.getElementById('n-text').value = '';
  document.getElementById('noteForm').style.display='none';
  toast('Note saved');
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
    btn.onclick = ()=> db.collection('notes').doc(btn.dataset.noteDel).delete();
  });
}
