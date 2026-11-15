let ytab=null;
const reloadY=()=>yonetim($("#main"));

function addForm(url,extra,fields,label){
  return `<div class="addf row" data-url="${url}" data-extra="${esc(JSON.stringify(extra))}">${fields}<button class="gold sm" data-send>${label}</button></div>`;
}
function bindAdmin(root){
  root.onclick=async e=>{
    const d=e.target.closest("[data-del]");
    if(d){
      if(!confirm(d.dataset.ask||"Silinsin mi?"))return;
      try{await api(d.dataset.del,{method:"DELETE"});reloadY()}catch(x){alert(x.message)}
      return;
    }
    const s=e.target.closest("[data-send]");
    if(s){
      const f=s.closest(".addf");
      const body=JSON.parse(f.dataset.extra||"{}");
      f.querySelectorAll("[name]").forEach(i=>{body[i.name]=i.value.trim()});
      try{await api(f.dataset.url,{method:"POST",body});reloadY()}catch(x){alert(x.message)}
    }
  };
}

async function yonetim(m){
  const tabs=[];
  if(me.isOwner){tabs.push(["staff","Yetkililer"],["grup","Grup Ayarları"])}
  tabs.push(["rutbe","Rütbe Ver / Al"]);
  if(me.isOwner||me.canDelegate)tabs.push(["yetki","Rütbe Yetkileri"]);
  if(!ytab||!tabs.some(t=>t[0]===ytab))ytab=tabs[0][0];
  m.innerHTML=`<h2 class="t">Yönetim</h2><div class="tabs">${tabs.map(t=>`<button data-yt="${t[0]}" class="${t[0]===ytab?"on":""}">${t[1]}</button>`).join("")}</div><div id="ybody"></div>`;
  m.querySelectorAll("[data-yt]").forEach(b=>b.onclick=()=>{ytab=b.dataset.yt;yonetim(m)});
  const b=$("#ybody");
  if(ytab==="staff")await ySt(b);
  else if(ytab==="grup")await yGrup(b);
  else if(ytab==="rutbe")await yRutbe(b);
  else await yYetki(b);
}

/* ---- Yetkililer (sadece sahip) ---- */
async function ySt(b){
  const list=await api("/api/admin/staff");
  b.innerHTML=`<div class="card"><h3>Yetkili ekle veya güncelle</h3>
   <label>Discord ID</label><input id="ai" inputmode="numeric" maxlength="20" placeholder="örn. 1422615267309129751">
   <p style="margin:8px 0 0;font-size:14px">Aynı ID’yi tekrar girersen yetkileri güncellenir.</p>
   <label>Baktığı alanlar</label>${Object.entries(PERM_ETIKET).map(([k,v])=>`<label class="chk"><input type="checkbox" value="${k}"> ${v}</label>`).join("")}
   <button class="gold" id="as" style="margin-top:10px">Kaydet</button><div class="err" id="er"></div></div>
  <h3 style="margin:22px 0 10px;font-size:22px">Yetkililer</h3>
  ${list.length?list.map(s=>`<div class="card"><div class="row sp"><b>${esc(s.username||"Henüz giriş yapmadı")} <span style="color:var(--mute);font-weight:400">${esc(s.id)}</span></b><button class="danger" data-r="${esc(s.id)}">Yetkiyi al</button></div><div class="tags" style="margin-top:8px">${s.perms.map(p=>`<span class="tag">${esc(PERM_ETIKET[p]||p)}</span>`).join("")}</div></div>`).join(""):`<div class="card"><p style="margin:0">Henüz yetkili eklenmedi.</p></div>`}`;
  $("#as").onclick=async()=>{
    const perms=[...b.querySelectorAll(".chk input:checked")].map(i=>i.value);
    try{await api("/api/admin/staff",{method:"POST",body:{discordId:$("#ai").value.trim(),perms}});reloadY()}catch(e){$("#er").textContent=e.message}
  };
  b.querySelectorAll("[data-r]").forEach(x=>x.onclick=async()=>{
    if(!confirm("Bu kişinin yetkisi alınsın mı?"))return;
    try{await api("/api/admin/staff/"+x.dataset.r,{method:"DELETE"});reloadY()}catch(e){alert(e.message)}
  });
}

/* ---- Grup ayarları (sadece sahip) ---- */
async function yGrup(b){
  const c=await api("/api/admin/config");
  const so=c.servers.map(s=>`<option value="${esc(s.guildId)}">${esc(s.name)}</option>`).join("");
  const sn=id=>{const s=c.servers.find(x=>x.guildId===id);return s?s.name:id};
  const roleRow=(r,url)=>`<div class="row sp line"><span>${esc(sn(r.guildId))} · <code>${esc(r.roleId)}</code></span><button class="rm" data-del="${url}/${r.id}">Sil</button></div>`;
  const roleAdd=(url,extra)=>so?addForm(url,extra,`<select name="guildId" style="flex:1;min-width:130px">${so}</select><input name="roleId" placeholder="Rol ID" inputmode="numeric" style="flex:1;min-width:130px">`,"Rol ekle"):`<p style="margin:8px 0 0">Önce yukarıdan bir sunucu ekle.</p>`;
  b.innerHTML=`
  <div class="card"><h3>Sunucular</h3><p>Botun bulunduğu ve rol verebileceği Discord sunucuları.</p>
   ${c.servers.map(s=>`<div class="row sp line"><span>${esc(s.name)} · <code>${esc(s.guildId)}</code></span><button class="rm" data-del="/api/admin/servers/${esc(s.guildId)}" data-ask="Sunucu ve bu sunucudaki tüm rol tanımları silinsin mi?">Sil</button></div>`).join("")}
   ${addForm("/api/admin/servers",{},`<input name="name" placeholder="Sunucu adı" style="flex:1;min-width:130px"><input name="guildId" placeholder="Sunucu ID" inputmode="numeric" style="flex:1;min-width:130px">`,"Sunucu ekle")}</div>
  <div class="card"><h3>Yeni grup (branş veya birim)</h3>
   ${addForm("/api/admin/groups",{},`<input name="label" placeholder="Ad (örn. BÖRÜ)" style="flex:1;min-width:130px"><input name="key" placeholder="Anahtar (örn. boru)" style="flex:1;min-width:130px"><input name="branch" placeholder="Branş (örn. Kara Kuvvetleri)" style="flex:1;min-width:130px"><input name="sort" placeholder="Sıra" inputmode="numeric" style="width:80px">`,"Grup ekle")}
   <p style="margin:8px 0 0;font-size:14px">Aynı anahtarı tekrar girersen grubun adı, branşı ve sırası güncellenir.</p></div>
  ${c.groups.map(g=>`<div class="card"><div class="row sp"><h3>${esc(g.label)}</h3><button class="rm" data-del="/api/admin/groups/${esc(g.key)}" data-ask="Grup, rolleri, rütbeleri ve üyelikleri silinsin mi?">Grubu sil</button></div>
    <p>${esc(g.branch)} · anahtar: ${esc(g.key)}</p>
    <b>Üye rolleri</b><p style="font-size:14px;margin:4px 0 0">Onaylanan kişiye /update ile verilir.</p>
    ${g.roles.map(r=>roleRow(r,"/api/admin/group-roles")).join("")}
    ${roleAdd("/api/admin/group-roles",{groupKey:g.key})}
    <b style="display:block;margin-top:18px">Rütbeler</b>
    ${g.ranks.map(r=>`<div class="line"><div class="row sp"><b>${esc(r.name)}</b><button class="rm" data-del="/api/admin/ranks/${r.id}" data-ask="Rütbe silinsin mi?">Rütbeyi sil</button></div>${r.roles.map(x=>roleRow(x,"/api/admin/rank-roles")).join("")}${roleAdd("/api/admin/rank-roles",{rankId:r.id})}</div>`).join("")}
    ${addForm("/api/admin/ranks",{groupKey:g.key},`<input name="name" placeholder="Yeni rütbe adı" style="flex:1;min-width:130px"><input name="sort" placeholder="Sıra" inputmode="numeric" style="width:80px">`,"Rütbe ekle")}
  </div>`).join("")}`;
  bindAdmin(b);
}

/* ---- Rütbe ver / al ---- */
async function yRutbe(b){
  const d=await api("/api/manage/overview");
  if(!d.groups.length){b.innerHTML=`<div class="card"><p style="margin:0">Yönetebileceğin bir grup yok.</p></div>`;return}
  b.innerHTML=`<div class="card"><h3>Rütbe ver / al</h3>
   <label>Grup</label><select id="rg">${d.groups.map(g=>`<option value="${esc(g.key)}">${esc(g.label)}</option>`).join("")}</select>
   <label>Kişi (Discord ID veya Minecraft adı)</label><input id="rt" autocomplete="off">
   <label>Rütbeler</label><div id="rr"></div>
   <label>Sunucular</label><div id="rs">${d.servers.map(s=>`<label class="chk"><input type="checkbox" value="${esc(s.guildId)}"> ${esc(s.name)}</label>`).join("")||"<p style='margin:0'>Henüz sunucu eklenmedi.</p>"}</div>
   <p style="font-size:14px;margin:8px 0">Sunucu seçmezsen rütbe, tanımlı olduğu tüm sunucularda geçerli olur. Kişi Discord’da /update yazınca roller güncellenir. Rütbe vermek kişiyi gruba da ekler.</p>
   <div class="row"><button class="gold" id="rv">Rütbe ver</button><button class="danger" id="ra">Rütbe al</button></div><div class="err" id="er"></div></div>`;
  const draw=()=>{
    const g=d.groups.find(x=>x.key===$("#rg").value);
    $("#rr").innerHTML=g.ranks.map(r=>`<label class="chk"><input type="checkbox" value="${r.id}"> ${esc(r.name)}</label>`).join("")||"<p style='margin:0'>Bu grupta rütbe yok ya da hiçbirini verme yetkin yok.</p>";
  };
  $("#rg").onchange=draw;draw();
  const send=async path=>{
    const rankIds=[...b.querySelectorAll("#rr input:checked")].map(i=>+i.value);
    const guildIds=[...b.querySelectorAll("#rs input:checked")].map(i=>i.value);
    const er=$("#er");
    try{
      await api(path,{method:"POST",body:{groupKey:$("#rg").value,target:$("#rt").value,rankIds,guildIds}});
      er.style.color="var(--ok)";er.textContent="Tamam. Kişi /update yazınca roller güncellenir.";
    }catch(e){er.style.color="";er.textContent=e.message}
  };
  $("#rv").onclick=()=>send("/api/manage/rank/give");
  $("#ra").onclick=()=>send("/api/manage/rank/take");
}

/* ---- Rütbe yetkileri ---- */
async function yYetki(b){
  const d=await api("/api/manage/overview");
  const gs=d.groups.filter(g=>me.isOwner||g.delegateAny);
  if(!gs.length){b.innerHTML=`<div class="card"><p style="margin:0">Yetki verebileceğin bir grup yok.</p></div>`;return}
  b.innerHTML=`<div class="card"><h3>Rütbe yetkisi ver</h3>
   <label>Grup</label><select id="yg">${gs.map(g=>`<option value="${esc(g.key)}">${esc(g.label)}</option>`).join("")}</select>
   <label>Kişi (Discord ID veya kayıtlı isim)</label><input id="yt" autocomplete="off">
   <label>Hangi rütbeleri verip alabilsin?</label><div id="yr"></div>
   <p style="font-size:14px;margin:4px 0 8px">Hiçbirini seçmezsen grubun tüm rütbeleri için geçerli olur.</p>
   ${me.isOwner?`<label class="chk"><input type="checkbox" id="yd"> Bu yetkiyi başkalarına da verebilsin</label>`:""}
   <button class="gold" id="yv" style="margin-top:8px">Yetki ver</button><div class="err" id="er"></div></div>
  <h3 style="margin:22px 0 10px;font-size:22px">Verilmiş yetkiler</h3><div id="yl"></div>`;
  const list=async()=>{
    const rows=await api("/api/manage/perms?group="+encodeURIComponent($("#yg").value));
    $("#yl").innerHTML=rows.length?rows.map(p=>`<div class="card row sp"><span><b>${esc(p.mcName||p.username||p.userId)}</b> <small style="color:var(--mute)">${esc(p.userId)}</small><br>${esc(p.rankName||"Tüm rütbeler")}${p.canDelegate?" · yetki verebilir":""}</span><button class="rm" data-pd="${p.id}">Sil</button></div>`).join(""):`<div class="card"><p style="margin:0">Bu grupta verilmiş yetki yok.</p></div>`;
    $("#yl").querySelectorAll("[data-pd]").forEach(x=>x.onclick=async()=>{
      if(!confirm("Bu yetki silinsin mi?"))return;
      try{await api("/api/manage/perms/"+x.dataset.pd,{method:"DELETE"});list()}catch(e){alert(e.message)}
    });
  };
  const draw=()=>{
    const g=gs.find(x=>x.key===$("#yg").value);
    $("#yr").innerHTML=g.ranks.filter(r=>me.isOwner||r.canDelegate).map(r=>`<label class="chk"><input type="checkbox" value="${r.id}"> ${esc(r.name)}</label>`).join("")||"<p style='margin:0'>Bu grupta rütbe yok.</p>";
    list();
  };
  $("#yg").onchange=draw;draw();
  $("#yv").onclick=async()=>{
    const rankIds=[...b.querySelectorAll("#yr input:checked")].map(i=>+i.value);
    const er=$("#er");
    try{
      await api("/api/manage/perms",{method:"POST",body:{groupKey:$("#yg").value,target:$("#yt").value,rankIds,canDelegate:me.isOwner&&$("#yd").checked}});
      er.style.color="var(--ok)";er.textContent="Yetki verildi.";list();
    }catch(e){er.style.color="";er.textContent=e.message}
  };
}
