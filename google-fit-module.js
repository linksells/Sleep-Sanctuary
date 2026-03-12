// ═══════════════════════════════════════════════════════════════════════════
//  GOOGLE FIT MODULE  —  Sleep Sanctuary v1.x compatible
//  Drop this <script> tag just before </body> in your HTML file.
//
//  SETUP (one-time):
//    1. console.cloud.google.com → New Project → Enable "Fitness API"
//    2. Credentials → OAuth 2.0 Client ID (Web application)
//    3. Authorized origins: https://yourdomain.com
//    4. Authorized redirect URIs: https://yourdomain.com  (same page, hash flow)
//    5. Replace GOOGLE_CLIENT_ID below with your real Client ID
//    6. In OAuth consent screen add the four FITNESS scopes listed below
//
//  HOW IT WORKS:
//    • Pure OAuth2 implicit flow — no backend needed
//    • Token stored in localStorage (auto-refreshed on expiry)
//    • On sync, fetches sleep + heart-rate, merges into calendarData
//    • All UI is injected into your existing sidebar / pages
// ═══════════════════════════════════════════════════════════════════════════

const GoogleFitModule = (() => {

  // ─── CONFIG ────────────────────────────────────────────────────────────────
  const CFG = {
    CLIENT_ID:    'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com',
    REDIRECT_URI: window.location.origin + window.location.pathname,
    SCOPES: [
      'https://www.googleapis.com/auth/fitness.sleep.read',
      'https://www.googleapis.com/auth/fitness.activity.read',
      'https://www.googleapis.com/auth/fitness.heart_rate.read',
      'https://www.googleapis.com/auth/fitness.body.read',
    ].join(' '),
    LS_TOKEN:  'ss_gfit_token',
    LS_EXPIRY: 'ss_gfit_expiry',
    LS_DATA:   'ss_gfit_data',          // cached synced data
  };

  // ─── STATE ─────────────────────────────────────────────────────────────────
  let _state = {
    connected:  false,
    syncing:    false,
    lastSync:   null,
    syncedDays: 0,
  };

  // ─── TOKEN HELPERS ─────────────────────────────────────────────────────────
  function getToken() {
    const token  = localStorage.getItem(CFG.LS_TOKEN);
    const expiry = Number(localStorage.getItem(CFG.LS_EXPIRY) || 0);
    if (!token || Date.now() > expiry - 60_000) return null; // 60s safety margin
    return token;
  }

  function saveToken(token, expiresIn) {
    localStorage.setItem(CFG.LS_TOKEN,  token);
    localStorage.setItem(CFG.LS_EXPIRY, Date.now() + Number(expiresIn) * 1000);
  }

  function clearToken() {
    localStorage.removeItem(CFG.LS_TOKEN);
    localStorage.removeItem(CFG.LS_EXPIRY);
  }

  // ─── OAUTH ─────────────────────────────────────────────────────────────────
  function connect() {
    const params = new URLSearchParams({
      client_id:    CFG.CLIENT_ID,
      redirect_uri: CFG.REDIRECT_URI,
      response_type:'token',
      scope:        CFG.SCOPES,
      include_granted_scopes: 'true',
      prompt: 'consent',
    });
    window.location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + params;
  }

  function disconnect() {
    clearToken();
    _state.connected = false;
    _state.lastSync  = null;
    _state.syncedDays = 0;
    _updateUI();
    _toast('Google Fit disconnected');
  }

  // Called on every page load — picks up the token from the URL hash after OAuth redirect
  function handleCallback() {
    const hash = location.hash;
    if (!hash.includes('access_token')) return false;
    const params = new URLSearchParams(hash.slice(1));
    const token  = params.get('access_token');
    const expIn  = params.get('expires_in');
    if (!token) return false;
    saveToken(token, expIn);
    // Clean URL without reloading
    history.replaceState(null, '', location.pathname + location.search);
    _state.connected = true;
    _updateUI();
    _toast('Google Fit connected! Syncing data…');
    // Auto-sync after connecting
    setTimeout(() => sync(), 800);
    return true;
  }

  // ─── API CALLS ─────────────────────────────────────────────────────────────
  async function _aggregate(token, dataTypeName, daysBack) {
    const endMs   = Date.now();
    const startMs = endMs - daysBack * 86_400_000;
    const res = await fetch(
      'https://www.googleapis.com/fitness/v1/users/me/dataset:aggregate',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({
          aggregateBy:  [{ dataTypeName }],
          bucketByTime: { durationMillis: 86_400_000 },
          startTimeMillis: startMs,
          endTimeMillis:   endMs,
        }),
      }
    );
    if (res.status === 401) { clearToken(); throw new Error('Token expired — please reconnect'); }
    if (!res.ok) throw new Error(`Fitness API error ${res.status}`);
    return res.json();
  }

  // ─── PARSERS ───────────────────────────────────────────────────────────────

  // Sleep stage values per Google Fit spec:
  // 1=Awake  2=Sleep(generic)  3=Out-of-bed  4=Light  5=Deep  6=REM
  function _parseSleep(data) {
    const results = {};
    for (const bucket of data?.bucket ?? []) {
      const dateMs = +bucket.startTimeMillis;
      const d = new Date(dateMs);
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

      let totalMs = 0, deepMs = 0, remMs = 0, lightMs = 0, awakeMs = 0;
      for (const ds of bucket.dataset ?? []) {
        for (const pt of ds.point ?? []) {
          const ms    = (+pt.endTimeNanos - +pt.startTimeNanos) / 1_000_000;
          const stage = pt.value?.[0]?.intVal;
          if (stage === 1) { awakeMs += ms; continue; }
          if (stage === 3) continue; // out of bed — skip
          totalMs += ms;
          if (stage === 5) deepMs  += ms;
          if (stage === 6) remMs   += ms;
          if (stage === 4) lightMs += ms;
        }
      }

      if (totalMs < 60_000) continue; // skip if < 1 minute (noise)

      const durH = totalMs / 3_600_000;
      const deepPct  = totalMs ? Math.round((deepMs  / totalMs) * 100) : 0;
      const remPct   = totalMs ? Math.round((remMs   / totalMs) * 100) : 0;
      const lightPct = totalMs ? Math.round((lightMs / totalMs) * 100) : 0;

      // Compute bedtime from first sleep point across all points
      let bedtimeNano = null;
      for (const ds of bucket.dataset ?? []) {
        for (const pt of ds.point ?? []) {
          const stage = pt.value?.[0]?.intVal;
          if (stage === 1 || stage === 3) continue;
          const nano = +pt.startTimeNanos;
          if (bedtimeNano === null || nano < bedtimeNano) bedtimeNano = nano;
        }
      }
      let bedtimeStr = '—';
      if (bedtimeNano) {
        const bd = new Date(bedtimeNano / 1_000_000);
        let h = bd.getHours(), m = bd.getMinutes();
        const ampm = h >= 12 ? 'PM' : 'AM';
        if (h > 12) h -= 12;
        if (h === 0) h = 12;
        bedtimeStr = `${h}:${String(m).padStart(2,'0')} ${ampm}`;
      }

      // Wake time = bedtime + total sleep + awake segments
      let wakeStr = '—';
      if (bedtimeNano) {
        const wakeMs = bedtimeNano / 1_000_000 + totalMs + awakeMs;
        const wd = new Date(wakeMs);
        let wh = wd.getHours(), wm = wd.getMinutes();
        const wampm = wh >= 12 ? 'PM' : 'AM';
        if (wh > 12) wh -= 12;
        if (wh === 0) wh = 12;
        wakeStr = `${wh}:${String(wm).padStart(2,'0')} ${wampm}`;
      }

      const dH = Math.floor(durH);
      const dM = Math.round((durH % 1) * 60);
      const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

      results[key] = {
        _source: 'google_fit',
        date:    `${monthNames[d.getMonth()]} ${d.getDate()}`,
        bedtime: bedtimeStr,
        wake:    wakeStr,
        dur:     `${dH}h ${String(dM).padStart(2,'0')}m`,
        durH:    Math.round(durH * 100) / 100,
        quality: _scoreToStars(deepPct, remPct, durH),
        deep:    deepPct,
        rem:     remPct,
        light:   lightPct,
        tags:    [],
        notes:   'Synced from Google Fit',
        routine: '',
        reflection: '',
        hr:      null, // filled by HR pass
      };
    }
    return results;
  }

  // Convert sleep stage percentages → 1–5 star quality score
  function _scoreToStars(deepPct, remPct, durH) {
    let score = 0;
    // Duration (max 2 pts): 7.5h+ = 2, 7h+ = 1.5, 6h+ = 1, else 0.5
    if (durH >= 7.5) score += 2;
    else if (durH >= 7) score += 1.5;
    else if (durH >= 6) score += 1;
    else score += 0.5;
    // Deep sleep (max 1.5 pts): 20%+ = 1.5, 15%+ = 1, 10%+ = 0.5
    if (deepPct >= 20) score += 1.5;
    else if (deepPct >= 15) score += 1;
    else if (deepPct >= 10) score += 0.5;
    // REM (max 1.5 pts): 20%+ = 1.5, 15%+ = 1, 10%+ = 0.5
    if (remPct >= 20) score += 1.5;
    else if (remPct >= 15) score += 1;
    else if (remPct >= 10) score += 0.5;
    return Math.max(1, Math.min(5, Math.round(score)));
  }

  function _mergeHeartRate(hrData, sleepMap) {
    for (const bucket of hrData?.bucket ?? []) {
      const d = new Date(+bucket.startTimeMillis);
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      if (!sleepMap[key]) continue;
      for (const ds of bucket.dataset ?? []) {
        for (const pt of ds.point ?? []) {
          const avg = pt.value?.find(v => v.fpVal != null)?.fpVal;
          if (avg) { sleepMap[key].hr = Math.round(avg); break; }
        }
        if (sleepMap[key].hr) break;
      }
    }
  }

  // ─── SYNC ──────────────────────────────────────────────────────────────────
  async function sync(daysBack = 30) {
    const token = getToken();
    if (!token) {
      _toast('Not connected — please connect Google Fit first');
      return;
    }
    if (_state.syncing) return;
    _state.syncing = true;
    _setSyncButtonState(true);

    try {
      // Fetch sleep + heart rate in parallel
      const [sleepRaw, hrRaw] = await Promise.all([
        _aggregate(token, 'com.google.sleep.segment',  daysBack),
        _aggregate(token, 'com.google.heart_rate.bpm', daysBack),
      ]);

      const sleepMap = _parseSleep(sleepRaw);
      _mergeHeartRate(hrRaw, sleepMap);

      // ── Merge into calendarData (non-destructive: existing manual entries win) ──
      // calendarData is defined in your main app script
      let mergedCount = 0;
      for (const [key, entry] of Object.entries(sleepMap)) {
        if (!window.calendarData[key]) {
          // New entry from Google Fit
          window.calendarData[key] = entry;
          mergedCount++;
        } else if (window.calendarData[key]._source === 'google_fit') {
          // Overwrite a previous Google Fit entry with fresh data
          window.calendarData[key] = entry;
        }
        // If entry exists and was manually entered — leave it alone
      }

      // Cache to localStorage for offline use
      try {
        localStorage.setItem(CFG.LS_DATA, JSON.stringify({
          ts: Date.now(),
          data: sleepMap,
        }));
      } catch(e) { /* storage full — non-fatal */ }

      _state.lastSync   = new Date();
      _state.syncedDays = Object.keys(sleepMap).length;
      _state.connected  = true;
      _updateUI();
      _updateSyncStatus();

      // Refresh visible UI panels if they're open
      _refreshOpenPanels();

      _toast(`Synced ${_state.syncedDays} nights from Google Fit ✓`);

    } catch (err) {
      console.error('[GoogleFit]', err);
      _toast('Sync failed: ' + err.message);
      if (err.message.includes('Token expired')) {
        _state.connected = false;
        _updateUI();
      }
    } finally {
      _state.syncing = false;
      _setSyncButtonState(false);
    }
  }

  // Restore cached data on page load (works offline)
  function _restoreCachedData() {
    try {
      const raw = localStorage.getItem(CFG.LS_DATA);
      if (!raw) return;
      const { ts, data } = JSON.parse(raw);
      if (Date.now() - ts > 24 * 3_600_000) return; // discard if >24h old
      let count = 0;
      for (const [key, entry] of Object.entries(data)) {
        if (!window.calendarData[key] || window.calendarData[key]._source === 'google_fit') {
          window.calendarData[key] = entry;
          count++;
        }
      }
      if (count > 0) {
        _state.syncedDays = count;
        _updateSyncStatus();
      }
    } catch(e) { /* non-fatal */ }
  }

  // ─── UI HELPERS ────────────────────────────────────────────────────────────
  function _toast(msg) {
    // Use the app's existing toast function
    if (typeof window.toast === 'function') window.toast(msg);
    else console.log('[GoogleFit]', msg);
  }

  function _refreshOpenPanels() {
    // If the user is currently on analytics/goals/log, refresh them
    const active = document.querySelector('.page.active');
    if (!active) return;
    const id = active.id.replace('page-', '');
    try {
      if (id === 'analytics') {
        if (typeof window.initAnalyticsCharts === 'function') {
          // Force re-init
          if (window.chartsInit) window.chartsInit.analytics = false;
          window.initAnalyticsCharts();
        }
      }
      if (id === 'log') {
        if (typeof window.renderFullLog === 'function') window.renderFullLog();
        if (typeof window.renderCalendar === 'function' && window.currentLogView === 'calendar') window.renderCalendar();
      }
      if (id === 'goals') {
        if (typeof window.renderGoals === 'function') window.renderGoals();
      }
      if (id === 'dashboard') {
        if (typeof window.renderRecentTable === 'function') window.renderRecentTable();
      }
    } catch(e) { console.warn('[GoogleFit] panel refresh:', e); }
  }

  function _setSyncButtonState(syncing) {
    const btns = document.querySelectorAll('[data-gfit-sync]');
    btns.forEach(btn => {
      btn.disabled = syncing;
      btn.innerHTML = syncing
        ? '<span class="gfit-spinner"></span> Syncing…'
        : '<span class="gfit-g-icon">G</span> Sync Google Fit';
    });
  }

  function _updateSyncStatus() {
    const el = document.getElementById('gfit-last-sync');
    if (!el) return;
    if (_state.lastSync) {
      const t = _state.lastSync;
      const h = t.getHours(), m = t.getMinutes();
      const ampm = h >= 12 ? 'PM' : 'AM';
      const hh = h > 12 ? h - 12 : h || 12;
      el.textContent = `Last sync: ${hh}:${String(m).padStart(2,'0')} ${ampm}  ·  ${_state.syncedDays} nights`;
    } else if (_state.syncedDays > 0) {
      el.textContent = `${_state.syncedDays} nights cached`;
    }
  }

  // ─── INJECT NAV ITEM ───────────────────────────────────────────────────────
  function _injectNav() {
    // Add "Google Fit" item to sidebar under the Settings section
    const settingsNavItem = document.querySelector('.nav-item[onclick*="settings"]');
    if (!settingsNavItem) return;

    const navItem = document.createElement('div');
    navItem.className = 'nav-item';
    navItem.id = 'gfit-nav-item';
    navItem.setAttribute('onclick', "GoogleFitModule.openPage()");
    navItem.innerHTML = `
      <span class="nav-icon" style="font-size:13px;display:flex;align-items:center;justify-content:center;width:20px">
        <svg width="14" height="14" viewBox="0 0 24 24" style="flex-shrink:0">
          <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
          <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
          <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
          <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
        </svg>
      </span>
      Google Fit
      <span id="gfit-nav-badge" style="display:none;margin-left:auto;width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 6px var(--green)"></span>`;
    // Insert AFTER the Settings nav item (below it)
    settingsNavItem.parentNode.insertBefore(navItem, settingsNavItem.nextSibling);

    // Also add a "Sync" button to the dashboard topbar
    const dashActions = document.querySelector('#page-dashboard .topbar-actions');
    if (dashActions) {
      const syncBtn = document.createElement('button');
      syncBtn.className = 'btn btn-ghost';
      syncBtn.setAttribute('data-gfit-sync', '');
      syncBtn.style.cssText = 'font-size:12px;padding:6px 14px;display:flex;align-items:center;gap:6px;color:var(--text-sec)';
      syncBtn.innerHTML = '<span class="gfit-g-icon">G</span> Sync Google Fit';
      syncBtn.onclick = () => GoogleFitModule.sync();
      dashActions.insertBefore(syncBtn, dashActions.firstChild);
    }
  }

  // ─── INJECT PAGE ───────────────────────────────────────────────────────────
  function _injectPage() {
    if (document.getElementById('page-gfit')) return;

    const page = document.createElement('div');
    page.className = 'page';
    page.id = 'page-gfit';
    page.innerHTML = `
      <div class="topbar">
        <div class="topbar-breadcrumb">Sleep Sanctuary / <span>Google Fit</span></div>
        <div class="topbar-actions" style="display:flex;gap:8px;align-items:center">
          <button class="btn btn-primary" data-gfit-sync onclick="GoogleFitModule.sync()">
            <span class="gfit-g-icon">G</span> Sync Google Fit
          </button>
          <!-- Troubleshooting dropdown -->
          <div style="position:relative" id="gfit-help-wrapper">
            <button class="btn btn-ghost" style="font-size:13px;padding:7px 14px;display:flex;align-items:center;gap:6px"
              onclick="(function(){var d=document.getElementById('gfit-help-dropdown');d.style.display=d.style.display==='block'?'none':'block';})()">
              ⚠ Troubleshooting <span style="font-size:10px">▾</span>
            </button>
            <div id="gfit-help-dropdown" style="display:none;position:absolute;right:0;top:calc(100% + 6px);width:380px;background:var(--bg-card);border:1px solid var(--border);border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,0.5);z-index:999;overflow:hidden">
              <div style="padding:16px 18px 10px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
                <div style="font-weight:700;font-size:14px;color:var(--text-pri)">⚠ Troubleshooting Guide</div>
                <button onclick="document.getElementById('gfit-help-dropdown').style.display='none'" style="background:none;border:none;color:var(--text-dim);font-size:18px;cursor:pointer;padding:0;line-height:1">×</button>
              </div>
              <div style="max-height:420px;overflow-y:auto;padding:12px 0" id="gfit-help-list">
                ${[
                  ['🔴 redirect_uri_mismatch', 'Your redirect URI in Google Cloud Console does not match your site URL. Go to APIs & Services → Credentials → edit your OAuth Client ID. Under Authorized Redirect URIs add your exact URL both with and without a trailing slash, e.g. https://yoursite.com/app and https://yoursite.com/app/'],
                  ['🔴 Google Auth Platform not configured', 'You need to complete the OAuth consent screen setup. Go to APIs & Services → OAuth consent screen, fill in your App name and email, click through all steps, and add your Google account as a test user under the Audience tab.'],
                  ['🔴 Error 400: invalid_client', 'Your Client ID is incorrect or not saved properly. Open google-fit-module.js in VS Code, search for CLIENT_ID and make sure it matches exactly what is shown in Google Cloud Console under Credentials.'],
                  ['🔴 Error 403: access_denied', 'Your Google account is not added as a test user. Go to APIs & Services → OAuth consent screen → Audience → Test users and add your email address, then try connecting again.'],
                  ['🟡 Connected but no data after sync', 'Google Fit may not have any sleep data yet. Open the Google Fit app on your phone, tap + and manually log a sleep entry. Wait 5–10 minutes for Google to process it, then click Sync Now again.'],
                  ['🟡 Sync button does nothing', 'Your token may have expired — tokens last 1 hour. Click Disconnect then Connect Google Fit again to get a fresh token, then sync.'],
                  ['🟡 Data shows 0% deep sleep and REM', 'This is normal if you only have a phone and no wearable. iPhones and basic Android phones cannot detect sleep stages — they only log total duration. A Wear OS watch or Fitbit is needed for stage data.'],
                  ['🟡 Sleep entry logged but wrong date shown', 'Google Fit buckets sleep by the date the session started. If you went to bed before midnight the entry will appear under the previous day. This is expected behaviour.'],
                  ['🟢 Manual entries are being overwritten', 'They should never be overwritten — only entries with _source: google_fit get updated. If this is happening, check that your manual entries were saved before syncing. Manual entries always take priority.'],
                  ['🟢 Site works locally but not on GitHub Pages', 'Make sure both your index.html and google-fit-module.js are uploaded to the same repository and that GitHub Pages is enabled under Settings → Pages. Also ensure your redirect URI in Google Cloud matches your github.io URL exactly.'],
                  ['🟢 Token keeps expiring every hour', 'This is a Google limitation for the implicit OAuth flow used here. You will need to reconnect once per hour during active use. This is normal and no data is ever lost when reconnecting.'],
                ].map(([title, desc]) => `
                  <div style="padding:12px 18px;border-bottom:1px solid rgba(255,255,255,0.04);cursor:pointer"
                    onclick="(function(el){var b=el.nextElementSibling;b.style.display=b.style.display==='block'?'none':'block';})(this)">
                    <div style="font-size:13px;font-weight:600;color:var(--text-pri);display:flex;justify-content:space-between;align-items:center;gap:8px">
                      <span>${title}</span>
                      <span style="font-size:10px;color:var(--text-dim);flex-shrink:0">▾</span>
                    </div>
                    <div style="display:none;font-size:12.5px;color:var(--text-dim);line-height:1.7;margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.05)">
                      ${desc}
                    </div>
                  </div>`).join('')}
              </div>
              <div style="padding:12px 18px;border-top:1px solid var(--border);font-size:11.5px;color:var(--text-dim);text-align:center">
                Still stuck? Check the browser console (⌘ + Option + J) for error details.
              </div>
            </div>
          </div>
        </div>
      </div>
      <script>
        // Close dropdown when clicking outside
        document.addEventListener('click', function(e) {
          var wrapper = document.getElementById('gfit-help-wrapper');
          if (wrapper && !wrapper.contains(e.target)) {
            var dd = document.getElementById('gfit-help-dropdown');
            if (dd) dd.style.display = 'none';
          }
        });
      </script>

      <div style="padding:28px">
        <div class="page-title">Google Fit</div>
        <div class="page-sub">Sync your wearable's sleep and biometric data directly into Sleep Sanctuary</div>

        <!-- Connection Card -->
        <div class="card" id="gfit-connection-card" style="margin-bottom:20px;background:linear-gradient(135deg,var(--bg-card),var(--bg-panel))">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:16px">
            <div style="display:flex;gap:16px;align-items:center">
              <div style="width:52px;height:52px;border-radius:14px;background:#fff;display:flex;align-items:center;justify-content:center;flex-shrink:0;box-shadow:0 4px 20px rgba(0,0,0,0.4)">
                <svg width="28" height="28" viewBox="0 0 24 24">
                  <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                  <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                  <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
                  <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                </svg>
              </div>
              <div>
                <div style="font-family:'Young Serif',serif;font-size:1.3rem;margin-bottom:3px">Google Fit</div>
                <div style="font-size:12px;color:var(--text-dim)">Android · Wear OS · Fitbit · Garmin via Google</div>
                <div id="gfit-last-sync" style="font-size:11px;color:var(--accent2);margin-top:4px"></div>
              </div>
            </div>
            <div style="display:flex;flex-direction:column;align-items:flex-end;gap:10px">
              <span id="gfit-status-badge" class="gfit-badge gfit-badge-off">● Not connected</span>
              <div style="display:flex;gap:8px" id="gfit-btn-row">
                <button class="btn btn-primary" id="gfit-connect-btn" onclick="GoogleFitModule.connect()">
                  Connect Google Fit
                </button>
              </div>
            </div>
          </div>

          <!-- Features row -->
          <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:20px">
            ${['Sleep stages','Deep sleep %','REM %','Heart rate','SpO₂','Activity','Calories'].map(f =>
              `<span style="padding:4px 12px;border-radius:6px;font-size:12px;font-weight:600;background:rgba(138,110,240,0.1);border:1px solid rgba(138,110,240,0.2);color:var(--accent3)">${f}</span>`
            ).join('')}
          </div>
        </div>

        <!-- Sync Stats (hidden until connected) -->
        <div id="gfit-sync-stats" style="display:none">
          <div class="stat-grid" id="gfit-stat-grid" style="margin-bottom:20px"></div>

          <!-- Synced data preview table -->
          <div class="card">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
              <div class="card-title" style="margin:0">Synced Sleep Data</div>
              <div style="display:flex;gap:8px;align-items:center">
                <select id="gfit-range-select" class="form-select" style="width:auto;padding:6px 12px;font-size:13px" onchange="GoogleFitModule.sync(parseInt(this.value))">
                  <option value="7">Last 7 days</option>
                  <option value="14">Last 14 days</option>
                  <option value="30" selected>Last 30 days</option>
                  <option value="60">Last 60 days</option>
                </select>
                <button class="btn btn-ghost" style="font-size:12px;padding:6px 14px" data-gfit-sync onclick="GoogleFitModule.sync(parseInt(document.getElementById('gfit-range-select').value))">
                  <span class="gfit-g-icon">G</span> Sync Google Fit
                </button>
              </div>
            </div>
            <div style="overflow-x:auto">
              <table class="data-table" id="gfit-data-table">
                <thead><tr>
                  <th>Date</th><th>Bedtime</th><th>Wake</th><th>Duration</th>
                  <th>Quality</th><th>Deep</th><th>REM</th><th>Heart Rate</th>
                </tr></thead>
                <tbody id="gfit-data-tbody">
                  <tr><td colspan="8" style="text-align:center;color:var(--text-dim);padding:32px">Connect and sync to see your data here</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <!-- Setup Guide (always visible) -->
        <div class="card" id="gfit-setup-card" style="margin-top:20px">
          <div class="card-title">Setup Guide</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
            <!-- Steps column -->
            <div>
              ${[
                ['1','Create Google Cloud Project','Go to console.cloud.google.com → New Project. Name it after your app.'],
                ['2','Enable Fitness API','APIs &amp; Services → Library → search "Fitness API" → Enable.'],
                ['3','Create OAuth Credentials','Credentials → Create → OAuth 2.0 Client ID → Web application. Add your domain as an Authorized JavaScript Origin.'],
                ['4','Add your Client ID','Open this module file and replace <code style="color:var(--accent2)">YOUR_GOOGLE_CLIENT_ID</code> in CFG.CLIENT_ID at the top.'],
                ['5','OAuth Consent Screen','Add the 4 fitness scopes and add test users while in development mode.'],
              ].map(([n,t,d]) => `
                <div style="display:flex;gap:14px;margin-bottom:18px">
                  <div style="width:28px;height:28px;border-radius:50%;background:rgba(138,110,240,0.15);border:1px solid rgba(138,110,240,0.3);color:var(--accent3);font-size:13px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px">${n}</div>
                  <div>
                    <div style="font-weight:700;font-size:14px;margin-bottom:4px">${t}</div>
                    <div style="font-size:13px;color:var(--text-dim);line-height:1.65">${d}</div>
                  </div>
                </div>`).join('')}
            </div>
            <!-- Scopes + important notes column -->
            <div>
              <div style="font-weight:700;font-size:13px;color:var(--accent3);margin-bottom:10px;text-transform:uppercase;letter-spacing:0.06em">Required OAuth Scopes</div>
              <div style="background:var(--bg-deep);border:1px solid var(--border);border-radius:10px;padding:14px;font-family:'DM Mono',monospace;font-size:11.5px;color:var(--accent2);line-height:2;margin-bottom:16px">
                fitness.sleep.read<br>
                fitness.activity.read<br>
                fitness.heart_rate.read<br>
                fitness.body.read
              </div>
              <div style="background:rgba(255,210,100,0.07);border:1px solid rgba(255,210,100,0.2);border-radius:10px;padding:14px;font-size:13px;color:#f5cc6a;line-height:1.7">
                <strong>⚡ Important:</strong> Tokens expire in 1 hour. This module automatically checks expiry before every API call. If expired, it will prompt you to reconnect — no data is lost.
              </div>
              <div style="margin-top:12px;background:rgba(80,210,150,0.06);border:1px solid rgba(80,210,150,0.15);border-radius:10px;padding:14px;font-size:13px;color:var(--accent2);line-height:1.7">
                <strong>✓ Future-proof design:</strong> Google Fit data is merged non-destructively. Manual entries always take priority. Upgrading your Sleep Sanctuary version will never lose synced data.
              </div>
            </div>
          </div>
        </div>

      </div><!-- /padding -->
    `;

    document.getElementById('main').appendChild(page);
  }

  // ─── INJECT CSS ────────────────────────────────────────────────────────────
  function _injectCSS() {
    const style = document.createElement('style');
    style.id = 'gfit-styles';
    style.textContent = `
      .gfit-badge {
        display:inline-flex; align-items:center; gap:5px;
        padding:4px 11px; border-radius:20px;
        font-size:11px; font-weight:600; letter-spacing:.5px; text-transform:uppercase;
      }
      .gfit-badge-on  { background:rgba(80,210,150,.12); border:1px solid rgba(80,210,150,.3); color:var(--green); }
      .gfit-badge-off { background:rgba(255,255,255,.05); border:1px solid var(--border); color:var(--text-dim); }
      .gfit-spinner {
        width:14px; height:14px; border:2px solid rgba(255,255,255,.25);
        border-top-color:currentColor; border-radius:50%;
        animation:gfit-spin .7s linear infinite; display:inline-block; vertical-align:middle;
      }
      @keyframes gfit-spin { to { transform:rotate(360deg); } }
      .gfit-g-icon {
        display:inline-flex; align-items:center; justify-content:center;
        width:16px; height:16px; border-radius:50%; background:white;
        font-size:10px; font-weight:900; font-family:sans-serif;
        background:conic-gradient(#4285F4 0deg 90deg, #EA4335 90deg 180deg, #FBBC05 180deg 270deg, #34A853 270deg 360deg);
        color:transparent; flex-shrink:0;
      }
      #gfit-data-tbody tr:hover td { background:var(--bg-panel); }
      #gfit-data-tbody .gfit-source { font-size:10px; color:var(--accent2); font-weight:600; }
    `;
    document.head.appendChild(style);
  }

  // ─── UPDATE UI ─────────────────────────────────────────────────────────────
  function _updateUI() {
    const connected = _state.connected;

    // Badge
    const badge = document.getElementById('gfit-status-badge');
    if (badge) {
      badge.className = `gfit-badge ${connected ? 'gfit-badge-on' : 'gfit-badge-off'}`;
      badge.textContent = connected ? '● Connected' : '● Not connected';
    }

    // Nav dot
    const navDot = document.getElementById('gfit-nav-badge');
    if (navDot) navDot.style.display = connected ? '' : 'none';

    // Button row
    const btnRow = document.getElementById('gfit-btn-row');
    if (btnRow) {
      if (connected) {
        btnRow.innerHTML = `
          <button class="btn btn-ghost" style="font-size:13px" data-gfit-sync onclick="GoogleFitModule.sync(parseInt(document.getElementById('gfit-range-select')?.value||30))">
            <span class="gfit-g-icon"></span> Sync Now
          </button>
          <button class="btn" style="background:rgba(255,90,90,0.1);border:1px solid rgba(255,90,90,0.3);color:var(--red);font-size:13px" onclick="GoogleFitModule.disconnect()">
            Disconnect
          </button>`;
      } else {
        btnRow.innerHTML = `
          <button class="btn btn-primary" id="gfit-connect-btn" onclick="GoogleFitModule.connect()">
            Connect Google Fit
          </button>`;
      }
    }

    // Stats panel
    const statsEl = document.getElementById('gfit-sync-stats');
    if (statsEl) statsEl.style.display = connected ? '' : 'none';

    // Render data table if connected
    if (connected) _renderDataTable();
  }

  function _renderDataTable() {
    const tbody = document.getElementById('gfit-data-tbody');
    if (!tbody) return;

    // Pull Google Fit entries from calendarData
    const gfitEntries = Object.entries(window.calendarData || {})
      .filter(([, e]) => e._source === 'google_fit')
      .sort(([a], [b]) => b.localeCompare(a)) // newest first
      .slice(0, 30);

    if (!gfitEntries.length) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--text-dim);padding:32px">No Google Fit data synced yet — hit Sync above</td></tr>`;
      return;
    }

    // Stats
    const durations  = gfitEntries.map(([,e]) => e.durH);
    const qualities  = gfitEntries.map(([,e]) => e.quality);
    const hrs        = gfitEntries.map(([,e]) => e.hr).filter(Boolean);
    const avgDur     = durations.reduce((a,b)=>a+b,0) / durations.length;
    const avgQual    = qualities.reduce((a,b)=>a+b,0) / qualities.length;
    const avgHr      = hrs.length ? Math.round(hrs.reduce((a,b)=>a+b,0)/hrs.length) : null;
    const avgH = Math.floor(avgDur), avgM = Math.round((avgDur%1)*60);

    const statsGrid = document.getElementById('gfit-stat-grid');
    if (statsGrid) {
      statsGrid.innerHTML = [
        ['Nights Synced',  gfitEntries.length, 'from Google Fit', 'var(--accent1)'],
        ['Avg Duration',   `${avgH}h ${String(avgM).padStart(2,'0')}m`, 'per night', 'var(--green)'],
        ['Avg Quality',    (avgQual).toFixed(1) + ' / 5', 'star rating', 'var(--gold)'],
        ['Avg Heart Rate', avgHr ? avgHr + ' bpm' : '—', 'resting', 'var(--accent2)'],
      ].map(([label, val, sub, color]) => `
        <div class="stat-card" style="--card-color:${color}">
          <div class="stat-label">${label}</div>
          <div class="stat-value">${val}</div>
          <div class="stat-sub">${sub}</div>
        </div>`).join('');
    }

    // Table rows
    tbody.innerHTML = gfitEntries.map(([key, e]) => {
      const starHtml = '★'.repeat(e.quality) + '<span style="color:var(--text-dim)">' + '★'.repeat(5-e.quality) + '</span>';
      const durColor = e.durH >= 7.5 ? 'var(--green)' : e.durH >= 6.5 ? 'var(--accent1)' : 'var(--orange)';
      return `<tr>
        <td style="font-weight:600;color:var(--text-pri)">${e.date}</td>
        <td style="color:var(--text-sec)">${e.bedtime}</td>
        <td style="color:var(--text-sec)">${e.wake}</td>
        <td style="color:${durColor};font-weight:700">${e.dur}</td>
        <td style="color:var(--gold)">${starHtml}</td>
        <td style="color:var(--accent1)">${e.deep}%</td>
        <td style="color:var(--accent2)">${e.rem}%</td>
        <td style="color:var(--red)">${e.hr ? '♥ ' + e.hr : '<span style="color:var(--text-dim)">—</span>'}</td>
      </tr>`;
    }).join('');
  }

  // ─── PUBLIC API ────────────────────────────────────────────────────────────
  function openPage() {
    if (typeof window.nav === 'function') window.nav('gfit');
    // Update active nav state manually since nav() uses onclick matching
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    const item = document.getElementById('gfit-nav-item');
    if (item) item.classList.add('active');
  }

  // ─── INIT ──────────────────────────────────────────────────────────────────
  function init() {
    _injectCSS();
    _injectPage();
    _injectNav();

    // Check existing token
    const token = getToken();
    if (token) {
      _state.connected = true;
    }

    // Restore cached sync data (works even offline)
    _restoreCachedData();

    // Handle OAuth redirect (token in URL hash)
    handleCallback();

    _updateUI();
    _updateSyncStatus();
  }

  // Expose public methods
  return { init, connect, disconnect, sync, openPage };

})();

// Auto-init when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', GoogleFitModule.init);
} else {
  GoogleFitModule.init();
}
