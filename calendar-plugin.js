/**
 * 日曆同步 — Roche Plugin
 * 拉取 Google 共享日曆 → 顯示近期行程 → 寫入聊天記憶讓 char 知道你的日程
 */
(function(){
'use strict';
const app={
  id:'calendar-sync',name:'日曆同步',icon:'chat',iconImage:'',

  async mount(container,roche){
    const BG='#fff',T1='#1a1a1a',T2='#555',T3='#999',BD='#E8E4DF',
          ACC='#4285F4',ACCL='#E8F0FE',ACCD='#1967D2'; // Google 藍

    const DAY_NAMES=['日','一','二','三','四','五','六'];

    // ── State ──
    const S={
      showSettings:false,
      cfg:{scriptUrl:'',charId:'',charName:'',convId:'',userName:'',autoSync:true},
      events:[],       // 從 Google 拉回的事件
      lastFetched:'',  // 上次拉取時間
      fetching:false,
      fetchMsg:'',fetchErr:false,
      syncMsg:'',syncErr:false,
      charList:[],convList:[],
    };

    // ── Storage ──
    const load=async k=>{try{const s=await roche.storage.get(k);return s?JSON.parse(s):null}catch(_){return null}};
    const sv=async(k,v)=>{try{await roche.storage.set(k,JSON.stringify(v))}catch(_){}};
    Object.assign(S.cfg,(await load('cal_cfg'))||{});
    S.events=(await load('cal_events'))||[];
    S.lastFetched=(await load('cal_lastFetch'))||'';
    const saveCfg=()=>sv('cal_cfg',S.cfg);
    const saveEvents=()=>{sv('cal_events',S.events);sv('cal_lastFetch',S.lastFetched);};

    try{S.charList=await roche.character.list()||[]}catch(_){}
    try{S.convList=await roche.conversation.list()||[]}catch(_){}
    if(!S.cfg.userName){try{const u=await roche.persona.getActiveUserPersona();if(u)S.cfg.userName=u.name||u.handle||'';}catch(_){}}
    if(!S.cfg.charId&&S.charList.length){S.cfg.charId=S.charList[0].id;S.cfg.charName=S.charList[0].name}
    if(!S.cfg.convId&&S.convList.length){
      const match=S.convList.find(c=>c.contactId===S.cfg.charId||c.name===S.cfg.charName);
      S.cfg.convId=(match||S.convList[0]).conversationId||(match||S.convList[0]).id;
    }

    // ── 日期工具 ──
    function ds(d){return`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
    function fmtDate(iso){const d=new Date(iso);return`${d.getMonth()+1}/${d.getDate()}（${DAY_NAMES[d.getDay()]}）`}
    function fmtTime(iso){const d=new Date(iso);return`${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`}
    function fmtRange(ev){
      if(ev.isAllDay)return fmtDate(ev.startTime)+' 全天';
      const sd=new Date(ev.startTime),ed=new Date(ev.endTime);
      if(ds(sd)===ds(ed))return fmtDate(ev.startTime)+' '+fmtTime(ev.startTime)+'~'+fmtTime(ev.endTime);
      return fmtDate(ev.startTime)+' '+fmtTime(ev.startTime)+' ~ '+fmtDate(ev.endTime)+' '+fmtTime(ev.endTime);
    }
    function isToday(iso){return ds(new Date(iso))===ds(new Date())}
    function isTomorrow(iso){const t=new Date();t.setDate(t.getDate()+1);return ds(new Date(iso))===ds(t)}
    function isPast(iso){return new Date(iso)<new Date()}
    function daysFromNow(iso){return Math.ceil((new Date(iso)-new Date())/86400000)}

    // ── 分組事件 ──
    function groupEvents(){
      const today=[],tomorrow=[],thisWeek=[],later=[],past=[];
      const now=new Date();
      const weekEnd=new Date(now);weekEnd.setDate(weekEnd.getDate()+(7-weekEnd.getDay()));
      S.events.forEach(ev=>{
        if(isPast(ev.endTime||ev.startTime)){past.push(ev);return;}
        if(isToday(ev.startTime)){today.push(ev);return;}
        if(isTomorrow(ev.startTime)){tomorrow.push(ev);return;}
        if(new Date(ev.startTime)<=weekEnd){thisWeek.push(ev);return;}
        later.push(ev);
      });
      return{today,tomorrow,thisWeek,later,past};
    }

    // ── 拉取日曆 ──
    async function fetchCalendar(){
      const url=S.cfg.scriptUrl;
      if(!url){S.fetchMsg='請先到設定填入 Google Apps Script 的 URL';S.fetchErr=true;render();return;}
      S.fetching=true;S.fetchMsg='';render();
      try{
        const res=await fetch(url);
        if(!res.ok)throw new Error('HTTP '+res.status);
        const data=await res.json();
        if(!data.success)throw new Error(data.error||'回應格式錯誤');
        S.events=data.events||[];
        S.lastFetched=new Date().toISOString();
        saveEvents();
        S.fetchMsg=`✅ 取得 ${S.events.length} 個事件（${fmtDate(data.rangeStart)} ~ ${fmtDate(data.rangeEnd)}）`;
        S.fetchErr=false;
        toast('📅 已取得 '+S.events.length+' 個行程');
      }catch(e){
        S.fetchMsg='拉取失敗：'+e.message;S.fetchErr=true;
        toast('⚠ 拉取失敗');
      }
      S.fetching=false;render();
    }

    // ── 建構同步文字 ──
    function buildSyncText(){
      if(!S.events.length)return null;
      const g=groupEvents();
      const today=ds(new Date());
      let t=`[日曆同步 ${today}]\n`;
      t+=`以下是${S.cfg.userName||'User'}近期的日程安排：\n`;
      if(g.today.length){
        t+=`\n【今天 ${fmtDate(new Date().toISOString())}】\n`;
        g.today.forEach(ev=>{t+=`- ${fmtTime(ev.startTime)}~${fmtTime(ev.endTime||ev.startTime)} ${ev.title}${ev.location?' @ '+ev.location:''}\n`;});
      }else{t+=`\n【今天】無行程\n`;}
      if(g.tomorrow.length){
        t+=`\n【明天】\n`;
        g.tomorrow.forEach(ev=>{t+=`- ${ev.isAllDay?'全天':fmtTime(ev.startTime)+'~'+fmtTime(ev.endTime||ev.startTime)} ${ev.title}${ev.location?' @ '+ev.location:''}\n`;});
      }
      if(g.thisWeek.length){
        t+=`\n【本週稍後】\n`;
        g.thisWeek.forEach(ev=>{t+=`- ${fmtDate(ev.startTime)} ${ev.isAllDay?'全天':fmtTime(ev.startTime)} ${ev.title}\n`;});
      }
      if(g.later.length){
        t+=`\n【未來行程】\n`;
        g.later.slice(0,15).forEach(ev=>{t+=`- ${fmtDate(ev.startTime)} ${ev.title}\n`;});
        if(g.later.length>15)t+=`...還有 ${g.later.length-15} 個行程\n`;
      }
      return t;
    }

    async function syncToMemory(){
      const text=buildSyncText();
      if(!text){S.syncMsg='沒有事件可以同步，請先拉取日曆';S.syncErr=true;render();return;}
      const convId=S.cfg.convId;
      if(!convId){S.syncMsg='請到設定選擇對話';S.syncErr=true;render();return;}
      try{
        const now=new Date();
        const utcStr=`${now.getUTCFullYear()}-${String(now.getUTCMonth()+1).padStart(2,'0')}-${String(now.getUTCDate()).padStart(2,'0')} ${String(now.getUTCHours()).padStart(2,'0')}:${String(now.getUTCMinutes()).padStart(2,'0')} UTC`;
        await roche.memory.write({
          conversationId:convId,summaryText:text,
          who:[S.cfg.userName||'用戶',S.cfg.charName||'角色'],
          action:text,when:utcStr+' -> '+utcStr,where:'日曆同步',
          source:'plugin:calendar-sync'
        });
        S.syncMsg='✅ 已同步到「'+S.cfg.charName+'」的記憶';S.syncErr=false;
        toast('✨ 已同步');
      }catch(e){S.syncMsg='同步失敗：'+e.message;S.syncErr=true;}
      render();
    }

    // ── Style ──
    const style=document.createElement('style');
    style.textContent=`
      .ca{width:100%;height:100%;position:relative;overflow:hidden;font-family:-apple-system,"PingFang SC","Helvetica Neue",sans-serif;background:${BG};display:flex;flex-direction:column;color:${T1}}
      .ca *{box-sizing:border-box}
      .ca-hdr{height:50px;display:flex;align-items:center;justify-content:space-between;padding:0 14px;border-bottom:1px solid ${BD};flex-shrink:0}
      .ca-hdr-btn{width:34px;height:34px;display:flex;align-items:center;justify-content:center;background:none;border:none;border-radius:50%;cursor:pointer;color:${T1}}
      .ca-body{flex:1;overflow-y:auto;padding:0 0 20px}
      .ca-summary{margin:14px;padding:18px;border-radius:16px;background:linear-gradient(135deg,${ACC},${ACCD});color:#fff;position:relative;overflow:hidden}
      .ca-summary-title{font-size:20px;font-weight:800}
      .ca-summary-sub{font-size:13px;margin-top:6px;opacity:.85;line-height:1.5}
      .ca-summary-bg{position:absolute;right:14px;top:10px;font-size:48px;opacity:.15}
      .ca-section{margin:16px 14px 0}
      .ca-section-title{font-size:13px;font-weight:700;color:${ACC};margin-bottom:8px;display:flex;align-items:center;gap:6px}
      .ca-ev{display:flex;gap:10px;padding:12px;background:#f8f8f8;border-radius:12px;margin-bottom:8px;border-left:4px solid ${ACC}}
      .ca-ev.past{opacity:.5;border-left-color:${T3}}
      .ca-ev-time{flex-shrink:0;width:56px;font-size:12px;font-weight:700;color:${ACC}}
      .ca-ev.past .ca-ev-time{color:${T3}}
      .ca-ev-body{flex:1;min-width:0}
      .ca-ev-title{font-size:14px;font-weight:600}
      .ca-ev-loc{font-size:11px;color:${T3};margin-top:2px}
      .ca-ev-cal{font-size:10px;color:${T3};margin-top:2px}
      .ca-empty{text-align:center;padding:60px 20px;color:${T3}}
      .ca-empty .icon{font-size:48px;margin-bottom:12px}
      .ca-btn{padding:12px 28px;border-radius:24px;background:${ACC};color:#fff;border:none;font-weight:700;font-size:14px;cursor:pointer}
      .ca-btn:disabled{opacity:.4}
      .ca-btn-row{display:flex;gap:8px;margin:14px;flex-wrap:wrap}
      .ca-btn-o{padding:10px 18px;border-radius:12px;background:${ACCL};color:${ACC};border:1px solid ${ACC}30;font-weight:600;font-size:13px;cursor:pointer;flex:1;text-align:center}
      .ca-sync{margin:14px;padding:14px;border-radius:12px;background:#f8f8f8;border:1px solid ${BD}}
      .ca-sync-btn{width:100%;padding:12px;border-radius:12px;background:${ACC};color:#fff;border:none;font-weight:700;font-size:14px;cursor:pointer;margin-top:8px}
      .ca-sync-preview{font-size:11px;color:${T2};background:#fff;border:1px solid ${BD};border-radius:8px;padding:10px;margin-top:8px;white-space:pre-wrap;line-height:1.5;font-family:monospace;max-height:200px;overflow-y:auto}
      .ca-mask{position:absolute;inset:0;z-index:200;background:rgba(0,0,0,.45);display:flex;align-items:flex-end}
      .ca-set{width:100%;background:#fff;border-radius:16px 16px 0 0;padding:18px;max-height:80%;overflow-y:auto}
      .ca-sl{display:block;font-size:12px;font-weight:600;color:${T2};margin:10px 0 4px}
      .ca-si{width:100%;padding:9px 12px;border-radius:10px;border:1px solid ${BD};font-size:13px;outline:none;background:#FAFAFA;font-family:inherit}
      .ca-sbtn{width:100%;padding:11px 0;border-radius:24px;background:${ACC};color:#fff;border:none;font-weight:700;font-size:14px;margin-top:14px;cursor:pointer}
      .ca-toast{position:absolute;top:60px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.7);color:#fff;padding:8px 18px;border-radius:20px;font-size:13px;z-index:300;pointer-events:none;animation:cf .3s}
      .ca-help{margin:14px;padding:14px;border-radius:12px;background:#FFF8E8;border:1px solid #F0E0B0;font-size:12px;color:#996600;line-height:1.6}
      .ca-help ol{margin:8px 0 0;padding-left:18px}
      .ca-help li{margin-bottom:6px}
      @keyframes cf{from{opacity:0;transform:translateX(-50%) translateY(-8px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}
    `;
    container.appendChild(style);

    function esc(s){return s?String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'):''}
    function toast(m){const t=document.createElement('div');t.className='ca-toast';t.textContent=m;root.appendChild(t);setTimeout(()=>t.remove(),2500)}

    // ── Render ──
    const root=document.createElement('div');root.className='ca';container.appendChild(root);
    function render(){
      let h='';
      h+=`<div class="ca-hdr"><button class="ca-hdr-btn" data-a="exit"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg></button><span style="font-weight:800;font-size:17px">📅 日曆同步</span><button class="ca-hdr-btn" data-a="settings"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="${T2}" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button></div>`;
      h+=`<div class="ca-body">`;

      const g=groupEvents();
      const totalUpcoming=g.today.length+g.tomorrow.length+g.thisWeek.length+g.later.length;

      // Summary card
      if(S.events.length){
        h+=`<div class="ca-summary"><div class="ca-summary-title">${g.today.length?'今天有 '+g.today.length+' 個行程':'今天沒有行程'}</div><div class="ca-summary-sub">${totalUpcoming} 個即將到來的行程${S.lastFetched?' · 上次更新：'+fmtDate(S.lastFetched)+' '+fmtTime(S.lastFetched):''}</div><div class="ca-summary-bg">📅</div></div>`;
      }

      // Action buttons
      h+=`<div class="ca-btn-row"><button class="ca-btn-o" data-a="fetch" ${S.fetching?'disabled':''}>${S.fetching?'⏳ 拉取中...':'🔄 拉取日曆'}</button><button class="ca-btn-o" data-a="sync" style="background:${ACCL}">📤 同步給 ${esc(S.cfg.charName||'角色')}</button></div>`;
      if(S.fetchMsg)h+=`<div style="margin:0 14px 8px;font-size:12px;color:${S.fetchErr?'#CC3333':'#2d8a5f'}">${esc(S.fetchMsg)}</div>`;
      if(S.syncMsg)h+=`<div style="margin:0 14px 8px;font-size:12px;color:${S.syncErr?'#CC3333':'#2d8a5f'}">${esc(S.syncMsg)}</div>`;

      if(!S.cfg.scriptUrl){
        h+=`<div class="ca-help"><strong>📋 首次設定指南</strong><ol><li>打開 <strong>script.google.com</strong> → 新建專案</li><li>貼入我提供的 Google Apps Script 代碼</li><li>修改 CALENDAR_IDS 為你的日曆 ID</li><li>部署 → 新增部署 → 網路應用程式 → 存取權選「任何人」</li><li>複製部署 URL → 貼到下方設定裡</li></ol></div>`;
      }

      if(!S.events.length&&S.cfg.scriptUrl){
        h+=`<div class="ca-empty"><div class="icon">📅</div><p>還沒有事件，點「拉取日曆」試試</p></div>`;
      }

      // Events by section
      if(g.today.length){
        h+=`<div class="ca-section"><div class="ca-section-title">📌 今天</div>`;
        g.today.forEach(ev=>{h+=evHTML(ev,false);});
        h+=`</div>`;
      }
      if(g.tomorrow.length){
        h+=`<div class="ca-section"><div class="ca-section-title">📎 明天</div>`;
        g.tomorrow.forEach(ev=>{h+=evHTML(ev,false);});
        h+=`</div>`;
      }
      if(g.thisWeek.length){
        h+=`<div class="ca-section"><div class="ca-section-title">📆 本週</div>`;
        g.thisWeek.forEach(ev=>{h+=evHTML(ev,false);});
        h+=`</div>`;
      }
      if(g.later.length){
        h+=`<div class="ca-section"><div class="ca-section-title">🗓️ 之後（${g.later.length}）</div>`;
        g.later.slice(0,20).forEach(ev=>{h+=evHTML(ev,false);});
        h+=`</div>`;
      }
      if(g.past.length){
        h+=`<div class="ca-section"><div class="ca-section-title" style="color:${T3}">⏪ 已過（${g.past.length}）</div>`;
        g.past.slice(-5).forEach(ev=>{h+=evHTML(ev,true);});
        h+=`</div>`;
      }

      // Sync preview
      const syncText=buildSyncText();
      if(syncText){
        h+=`<div class="ca-sync"><div style="font-weight:700;font-size:14px;margin-bottom:4px">📤 同步預覽</div><div class="ca-sync-preview">${esc(syncText)}</div><button class="ca-sync-btn" data-a="sync">🔄 同步到聊天記憶</button></div>`;
      }

      h+=`</div>`;
      if(S.showSettings)h+=vSettings();
      root.innerHTML=h;
    }

    function evHTML(ev,past){
      const timeStr=ev.isAllDay?'全天':fmtTime(ev.startTime);
      return `<div class="ca-ev${past?' past':''}"><div class="ca-ev-time">${fmtDate(ev.startTime).slice(0,-1).split('（')[1]||''}<br>${timeStr}</div><div class="ca-ev-body"><div class="ca-ev-title">${esc(ev.title)}</div>${ev.location?`<div class="ca-ev-loc">📍 ${esc(ev.location)}</div>`:''}${ev.calendarName?`<div class="ca-ev-cal">${esc(ev.calendarName)}</div>`:''}</div></div>`;
    }

    function vSettings(){
      const c=S.cfg;
      let h=`<div class="ca-mask"><div class="ca-set"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px"><span style="font-weight:700;font-size:15px">設定</span><button data-a="close-set" style="background:none;border:none;font-size:18px;color:${T3};cursor:pointer">✕</button></div>`;
      h+=`<label class="ca-sl">Google Apps Script URL</label><input class="ca-si" data-f="scriptUrl" value="${esc(c.scriptUrl)}" placeholder="https://script.google.com/macros/s/xxx/exec">`;
      h+=`<label class="ca-sl">同步給誰？</label><select class="ca-si" data-f="charId">${S.charList.map(ch=>`<option value="${esc(ch.id)}" ${ch.id===c.charId?'selected':''}>${esc(ch.name||ch.handle)}</option>`).join('')}</select>`;
      h+=`<label class="ca-sl">寫入哪個對話？</label><select class="ca-si" data-f="convId">${S.convList.map(cv=>{const cid=cv.conversationId||cv.id;return`<option value="${esc(cid)}" ${cid===c.convId?'selected':''}>${esc(cv.name||cv.handle||cid)}</option>`}).join('')}</select>`;
      h+=`<label class="ca-sl">你的名字</label><input class="ca-si" data-f="userName" value="${esc(c.userName)}">`;
      h+=`<button data-a="save-set" class="ca-sbtn">儲存設定</button>`;
      h+=`<button data-a="clear-events" class="ca-sbtn" style="background:#fff;color:#CC3333;border:1px solid #CC3333;margin-top:8px">🗑️ 清除事件資料</button>`;
      h+=`</div></div>`;
      return h;
    }

    // ── Events ──
    function onClick(e){
      const b=e.target.closest('[data-a]');if(!b)return;
      const a=b.dataset.a;
      if(a==='exit')roche.ui?.closeApp?.();
      else if(a==='settings'){S.showSettings=true;render();}
      else if(a==='close-set'){S.showSettings=false;render();}
      else if(a==='fetch'){fetchCalendar();}
      else if(a==='sync'){syncToMemory();}
      else if(a==='save-set'){
        root.querySelectorAll('[data-f]').forEach(el=>{S.cfg[el.dataset.f]=el.value;});
        const ch=S.charList.find(c=>c.id===S.cfg.charId);if(ch)S.cfg.charName=ch.name||ch.handle||'';
        saveCfg();S.showSettings=false;toast('已儲存');render();
      }
      else if(a==='clear-events'){S.events=[];S.lastFetched='';saveEvents();S.showSettings=false;toast('已清除');render();}
    }
    root.addEventListener('click',onClick);
    render();

    // 自動拉取+同步（如果有設定 URL 的話）
    if(S.cfg.autoSync&&S.cfg.scriptUrl){
      setTimeout(async()=>{
        await fetchCalendar();
        if(S.events.length&&S.cfg.convId)await syncToMemory();
      },1500);
    }

    this._el=root;this._st=style;this._fn=onClick;
  },

  async unmount(container){
    if(this._el){this._el.removeEventListener('click',this._fn);this._el.remove();}
    if(this._st)this._st.remove();
    container.replaceChildren();
  }
};
window.RochePlugin.register({id:'roche-calendar-sync',name:'日曆同步',version:'1.0.0',description:'拉取 Google 日曆讓角色知道你的日程',author:'予佟',apps:[app]});
})();
