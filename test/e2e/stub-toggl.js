(function (app, id) {
  var p = app.plugins.plugins[id];
  var d = new Date(); d.setHours(14, 0, 0, 0);
  var base = d.getTime();
  var real0 = Date.now();
  p.service.deps.now = function () { return base + (Date.now() - real0); };
  p.service.deps.client.opts.now = p.service.deps.now;
  var mid = new Date(base); mid.setHours(0, 0, 0, 0);
  var d0 = mid.getTime();
  var at = function (h, m) { return d0 + (h * 60 + m) * 60000; };
  var iso = function (ms) { return new Date(ms).toISOString().replace('.000Z', 'Z'); };
  var projects = [
    { id: 11, workspace_id: 5, name: 'Docs', color: '#06a893', active: true },
    { id: 12, workspace_id: 5, name: 'Code', color: '#c7561e', active: true },
    { id: 13, workspace_id: 5, name: 'Planning', color: '#2da608', active: true }
  ];
  var st = { calls: [], mode: 'ok', remaining: 30, next: 500, entries: [], projects: projects, now: p.service.deps.now };
  var mk = function (o) {
    var pr = projects.filter(function (x) { return x.id === o.p; })[0];
    return { id: o.id, workspace_id: 5, description: o.d, start: iso(o.s), stop: o.e ? iso(o.e) : null, duration: o.e ? Math.round((o.e - o.s) / 1000) : -1, project_id: o.p || null, project_name: pr ? pr.name : null, project_color: pr ? pr.color : null, tags: o.t || [] };
  };
  st.entries = [
    mk({ id: 1, d: 'Write README', s: at(8, 30), e: at(9, 15), p: 11 }),
    mk({ id: 2, d: 'Fix sync bug', s: at(9, 30), e: at(10, 45), p: 12 }),
    mk({ id: 3, d: 'Review notes', s: at(11, 0), e: at(11, 40), p: 11 })
  ];
  st.mk = mk;
  var find = function (n) { return st.entries.filter(function (e) { return e.id === n; })[0]; };
  var num = function (re, path) { var m = re.exec(path); return m ? Number(m[1]) : 0; };
  p.service.deps.client.opts.http = function (r) {
    st.calls.push({ method: r.method, path: r.path, body: r.body ? JSON.parse(r.body) : null, auth: r.headers.Authorization });
    var h = { 'x-toggl-quota-remaining': String(st.remaining), 'x-toggl-quota-resets-in': '1800' };
    if (st.mode === 'offline') return Promise.resolve({ status: 0, json: null, headers: {} });
    if (st.mode === '402') return Promise.resolve({ status: 402, json: 'You have hit your hourly limit', headers: { 'x-toggl-quota-remaining': '0', 'x-toggl-quota-resets-in': '1800' } });
    if (st.mode === '429') return Promise.resolve({ status: 429, json: null, headers: {} });
    st.remaining = Math.max(0, st.remaining - 1);
    var ok = function (j) { return Promise.resolve({ status: 200, json: j, headers: h }); };
    var body = r.body ? JSON.parse(r.body) : {};
    if (r.method === 'GET' && r.path === '/me') return ok({ id: 1, fullname: 'Demo User', default_workspace_id: 5 });
    if (r.method === 'GET' && r.path.indexOf('/me/time_entries/current') === 0) return ok(st.entries.filter(function (e) { return !e.stop; })[0] || null);
    if (r.method === 'GET' && r.path.indexOf('/me/time_entries') === 0) return ok(st.entries);
    if (r.method === 'GET' && r.path === '/me/projects') return ok(projects);
    if (r.method === 'GET' && r.path === '/me/tags') return ok([{ id: 1, name: 'deep work' }, { id: 2, name: 'review' }]);
    if (r.method === 'POST') {
      var e = mk({ id: st.next++, d: body.description, s: Date.parse(body.start), e: body.stop ? Date.parse(body.stop) : 0, p: body.project_id, t: body.tags });
      st.entries.push(e);
      return ok(e);
    }
    if (r.method === 'PATCH') {
      var s = find(num(/time_entries\/(\d+)\/stop/, r.path));
      var now = p.service.deps.now();
      if (s) { s.stop = iso(now); s.duration = Math.round((now - Date.parse(s.start)) / 1000); }
      return ok(s || null);
    }
    if (r.method === 'PUT') {
      var u = find(num(/time_entries\/(\d+)/, r.path));
      if (u) {
        if (body.description !== undefined) u.description = body.description;
        if (body.start) u.start = body.start;
        if (body.stop) u.stop = body.stop;
        if (body.duration !== undefined) u.duration = body.duration;
        if (body.project_id !== undefined) {
          var pr = projects.filter(function (x) { return x.id === body.project_id; })[0];
          u.project_id = body.project_id; u.project_name = pr ? pr.name : null; u.project_color = pr ? pr.color : null;
        }
      }
      return ok(u || null);
    }
    if (r.method === 'DELETE') {
      var gone = num(/time_entries\/(\d+)/, r.path);
      st.entries = st.entries.filter(function (x) { return x.id !== gone; });
      return ok(null);
    }
    return Promise.resolve({ status: 404, json: null, headers: h });
  };
  app.secretStorage.setSecret(p.settings.tokenSecretId, 'stub-token-0000');
  window.__tmtStub = st;
  return 'ok';
})(app, 'toggl-mobile-timer')
