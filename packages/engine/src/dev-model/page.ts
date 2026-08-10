// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The dev visual model page served at `GET /dev/model`: a single
 * self-contained HTML document — inline CSS, the vendored cytoscape dist
 * (see ./vendor/README.md), and the inline app script below. No build step,
 * no CDN, no external request of any kind.
 *
 * The page polls `GET /api/dev/model?userId=…` every second and diffs the
 * snapshot client-side: new records fade in and flash, state changes recolor
 * (pending yellow / allow green / deny red / terminal gray — the 0025 color
 * semantics), and a new audit entry pulses the wire path from its origin
 * surface. The most recent call then stays lit (a steady 'latest' highlight on
 * the entry and its wire path) until the next call lands, when the highlight
 * moves rather than fading. Two dotted compute-environment bands sit behind the
 * graph — client (the CLI / MCP surfaces) and server (the per-user Durable
 * Object) — drawn as compound parents so the boundary tracks nodes as they are
 * dragged. The engine reads as the governance gate: a caption names its
 * pipeline (permission · spend · rate · audit → allow / hold / deny), and
 * labeled governance-flow edges fan out from it (checks policy · executes ·
 * records · holds) instead of the old faint has-a lines. Below the state map,
 * an 'action flow' strip draws the governance pipeline as a fixed DAG — a
 * trunk (request → classify → gate → audit) fanning into deny · hold · allow,
 * with hold → confirm → grant rejoining execute. Driven by the same snapshot,
 * each tick lights the path the most recent call took (allow green / hold
 * amber / deny red) and dims the rest. Clicking a node or join edge
 * opens the sanitized record in the side panel; clicking a wire-hop edge shows
 * that route's query/request/response JSON Schema from `GET /api/dev/contracts`.
 *
 * Trust rule, mirrored from the CLI: every value that can carry
 * externally-authored bytes (nouns, commission goals, held-call params) is
 * written to the DOM via `textContent` only — never markup — and labeled
 * untrusted in the detail panel.
 *
 * Authoring constraint: the app script and CSS live inside this module's
 * template literals, so they deliberately avoid backtick and dollar-brace
 * sequences.
 */
import cytoscapeSource from "./vendor/cytoscape-3.34.0.min.js.txt";

const PAGE_CSS = `
  * { box-sizing: border-box; margin: 0; }
  html, body { height: 100%; }
  body {
    font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
    background: #14161a; color: #d6d8de; display: flex; flex-direction: column;
  }
  header {
    display: flex; align-items: baseline; gap: 14px;
    padding: 8px 14px; border-bottom: 1px solid #2a2e36; flex: none;
  }
  header h1 { font-size: 14px; color: #8fd3c7; font-weight: 600; }
  #who { color: #9aa0ad; }
  #dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%;
         background: #666; margin-right: 5px; }
  #dot.ok { background: #7bc86c; } #dot.bad { background: #e06c60; }
  #counts { margin-left: auto; color: #9aa0ad; font-size: 12px; }
  main { display: flex; flex: 1; min-height: 0; }
  #views { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  #cy { flex: 1; min-height: 0; }
  #panel {
    width: 340px; flex: none; border-left: 1px solid #2a2e36; padding: 12px;
    overflow-y: auto; background: #181b20;
  }
  #panel h2 { font-size: 13px; color: #8fd3c7; margin-bottom: 8px;
              word-break: break-all; }
  #panel .hint { color: #9aa0ad; font-size: 12px; }
  #panel dl { display: grid; grid-template-columns: max-content 1fr;
              gap: 3px 10px; font-size: 12px; }
  #panel dt { color: #9aa0ad; white-space: nowrap; }
  #panel dd { word-break: break-all; }
  #panel dd.untrusted { color: #d8b46a; }
  #panel pre {
    margin-top: 8px; padding: 8px; background: #14161a; border: 1px solid #2a2e36;
    border-radius: 4px; font-size: 11px; overflow-x: auto; white-space: pre;
  }
  #panel .legend { margin-top: 14px; font-size: 12px; color: #9aa0ad; }
  #panel .legend span { display: inline-block; width: 9px; height: 9px;
                        border-radius: 2px; margin-right: 6px; }
  #flowrow { height: 210px; flex: none; border-top: 1px solid #2a2e36;
             display: flex; flex-direction: column; background: #151a1f; }
  #flowrow .col-h { padding: 5px 12px; font-size: 11px; color: #8fd3c7;
                    border-bottom: 1px solid #2a2e36; flex: none; }
  #flowrow .col-h small { color: #7f8896; }
  #cy2 { flex: 1; min-height: 0; }
`;

/**
 * The in-browser application. Kept framework-free and backtick-free (see the
 * module doc); everything user-influenced reaches the DOM through
 * textContent.
 */
const APP_JS = `
(function () {
  'use strict';
  var qs = new URLSearchParams(location.search);
  var USER = qs.get('userId') || 'cli-user';
  document.getElementById('who').textContent = 'userId: ' + USER;

  // 0025 state colors: color reports state, it never nudges.
  var C = {
    pending: '#e5c07b', allow: '#7bc86c', deny: '#e06c60', dim: '#5c6370',
    session: '#61afef', service: '#8fd3c7', commission: '#c678dd',
    chrome: '#3a3f4b', label: '#d6d8de', box: '#22262e'
  };
  var COMMISSION_COLOR = {
    running: C.session, awaiting_confirmation: C.pending, completed: C.allow,
    failed: C.deny, denied: C.deny, expired: C.dim
  };

  var WIRES = [
    { id: 'w-chat', s: 'surf-human', r: '/api/chat', m: 'POST' },
    { id: 'w-resolve', s: 'surf-human', r: '/api/resolve', m: 'POST' },
    { id: 'w-status', s: 'surf-human', r: '/api/status', m: 'GET' },
    { id: 'w-sstart', s: 'surf-human', r: '/api/session/start', m: 'POST' },
    { id: 'w-squit', s: 'surf-human', r: '/api/session/quit', m: 'POST' },
    { id: 'w-kill', s: 'surf-human', r: '/api/kill', m: 'POST' },
    { id: 'w-connect', s: 'surf-human', r: '/connect/{service}', m: 'POST' },
    { id: 'w-mcp', s: 'surf-mcp', r: '/mcp', m: 'MCP' }
  ];

  // Compute-environment bands. Each is a compound parent whose bounding box is
  // DERIVED from its children, so the dotted boundary tracks nodes as they are
  // dragged — no recompute code. env-client wraps the two upstream surfaces;
  // env-server wraps the engine and every governed-state box (nested compounds:
  // env-server > box-* > rows). The wires visibly cross the client→server line.
  var staticEls = [
    { data: { id: 'env-client', kind: 'env', label: 'client · your machine',
      detail: { environment: 'client', runs: 'your machine — CLI / MCP client',
                note: 'untrusted input originates here' } } },
    { data: { id: 'env-server', kind: 'env',
      label: 'server · Cloudflare Durable Object (per user)',
      detail: { environment: 'server',
                runs: 'Cloudflare Durable Object, one per user',
                holds: 'governance state, credentials, audit chain' } } },
    { data: { id: 'surf-human', label: 'Human · CLI', kind: 'surface',
      parent: 'env-client' }, position: { x: 110, y: 170 } },
    { data: { id: 'surf-mcp', label: 'MCP client', kind: 'surface',
      parent: 'env-client' }, position: { x: 110, y: 430 } },
    { data: { id: 'engine', label: 'Habenula engine', kind: 'engine',
      parent: 'env-server',
      detail: { role: 'engine (per-user Durable Object)',
                note: 'owns the governed state shown here; the action-flow ' +
                      'panel on the right shows how a call moves through it' } },
      position: { x: 400, y: 300 } },
    // Childless compound parents have no derived bounding box, which breaks
    // the initial fit — give them explicit seed positions (ignored once
    // children exist: a parent's position derives from its children).
    { data: { id: 'box-policy', label: 'policy entries', kind: 'box',
      parent: 'env-server' }, position: { x: 710, y: 430 } },
    { data: { id: 'box-comm', label: 'commission runs', kind: 'box',
      parent: 'env-server' }, position: { x: 1080, y: 110 } },
    { data: { id: 'box-svc', label: 'connected services', kind: 'box',
      parent: 'env-server' }, position: { x: 1080, y: 350 } },
    { data: { id: 'box-audit', label: 'audit chain (recent)', kind: 'box',
      parent: 'env-server' }, position: { x: 1390, y: 110 } }
  ];
  WIRES.forEach(function (w) {
    staticEls.push({ data: {
      id: w.id, source: w.s, target: 'engine', kind: 'wire',
      label: w.m + ' ' + w.r, route: w.r
    } });
  });
  // Plain has-a edges: the engine owns these state tables. The action pathway
  // (what the gate DOES with a call) lives in the flow-DAG panel, not here.
  ['box-policy', 'box-comm', 'box-svc', 'box-audit'].forEach(function (b) {
    staticEls.push({ data: { id: 'e-' + b, source: 'engine', target: b,
                             kind: 'infra' } });
  });

  var cy = cytoscape({
    container: document.getElementById('cy'),
    elements: staticEls,
    layout: { name: 'preset' },
    style: [
      // Explicit dimensions everywhere: the 'label' auto-size value is
      // deprecated in cytoscape 3.34 and resolves to zero for elements added
      // at init (labels unmeasured), which rendered the static skeleton
      // invisible. Fixed sizes also read cleaner as a schematic.
      { selector: 'node', style: {
        'background-color': C.chrome, 'border-width': 1, 'border-color': '#4a5060',
        shape: 'round-rectangle', width: 175, height: 26,
        label: 'data(label)', color: C.label,
        'font-family': 'ui-monospace, Menlo, monospace', 'font-size': 11,
        'text-valign': 'center', 'text-halign': 'center', 'text-wrap': 'ellipsis',
        'text-max-width': '165px'
      } },
      { selector: 'node[kind = "surface"], node[kind = "engine"]', style: {
        'background-color': '#262b34', 'border-color': C.service,
        'font-size': 12, width: 140, height: 44
      } },
      // The gate is the control point — a heavier accent border and richer fill
      // so the eye reads it as where everything converges, not just another box.
      { selector: 'node[kind = "engine"]', style: {
        'background-color': '#22343a', 'border-color': C.service,
        'border-width': 2.5, width: 150, height: 46
      } },
      { selector: ':parent', style: {
        'background-color': C.box, 'background-opacity': 0.35,
        'border-color': '#3a3f4b', label: 'data(label)', 'text-valign': 'top',
        'text-halign': 'center', color: '#9aa0ad', 'font-size': 10, padding: '14px'
      } },
      // Compute-environment band: a dotted, near-transparent enclosure sitting
      // behind its member boxes. Wider padding than a box so the band border
      // and its top label clear the nested box borders/labels.
      { selector: 'node[kind = "env"]', style: {
        'background-color': C.service, 'background-opacity': 0.04,
        'border-color': '#4a5060', 'border-width': 1, 'border-style': 'dotted',
        shape: 'round-rectangle', padding: '30px', label: 'data(label)',
        'text-valign': 'top', 'text-halign': 'center', 'text-margin-y': -2,
        color: '#7f8896', 'font-size': 11,
        // Override the base node ellipsis clamp (165px) so the band's full
        // label shows rather than truncating to 'Cloudflare Dur…'.
        'text-wrap': 'none', 'text-max-width': '600px'
      } },
      { selector: 'node[stateColor]', style: {
        'border-color': 'data(stateColor)', 'border-width': 2
      } },
      { selector: 'edge', style: {
        width: 1.5, 'line-color': '#3a3f4b', 'target-arrow-shape': 'triangle',
        'target-arrow-color': '#3a3f4b', 'curve-style': 'bezier',
        'arrow-scale': 0.7
      } },
      { selector: 'edge[label]', style: {
        label: 'data(label)', color: '#9aa0ad', 'font-size': 9,
        'text-rotation': 'autorotate', 'text-background-color': '#14161a',
        'text-background-opacity': 0.85, 'text-background-padding': '2px'
      } },
      { selector: 'edge[kind = "wire"]', style: {
        'line-color': '#4a5060', 'target-arrow-color': '#4a5060'
      } },
      { selector: 'edge[kind = "infra"]', style: {
        'line-style': 'dashed', width: 1, 'target-arrow-shape': 'none',
        'line-color': '#2e333c'
      } },
      { selector: 'edge[kind = "join"]', style: {
        'line-color': '#5c6370', 'target-arrow-color': '#5c6370',
        'line-style': 'dotted'
      } },
      { selector: 'edge[kind = "chain"]', style: {
        'line-color': '#3f4550', 'target-arrow-shape': 'none', width: 1
      } },
      { selector: 'node[kind = "more"]', style: {
        'background-color': 'rgba(0,0,0,0)', 'border-style': 'dashed',
        'border-color': '#4a5060', color: '#9aa0ad', height: 20
      } },
      { selector: '.flash', style: {
        'border-color': '#ffffff', 'border-width': 3
      } },
      { selector: 'edge.pulse', style: {
        'line-color': C.pending, 'target-arrow-color': C.pending, width: 3
      } },
      // Persistent 'latest call' highlight: the most recent audit entry and its
      // wire path stay lit until the next call lands. Calmer than the arrival
      // pulse (a steady overlay on the node, a thinner warm wire) so a path
      // that is permanently on does not read as an active flash.
      { selector: 'node.latest', style: {
        'overlay-color': C.pending, 'overlay-opacity': 0.2, 'overlay-padding': 5
      } },
      { selector: 'edge.latest', style: {
        'line-color': C.pending, 'target-arrow-color': C.pending, width: 2.5
      } },
      // Smooth decay for the pulse so the lit path fades rather than snapping
      // back when the class drops.
      { selector: 'edge[kind = "wire"], edge[kind = "infra"]', style: {
        'transition-property': 'line-color, width',
        'transition-duration': 400
      } },
      { selector: ':selected', style: {
        'overlay-color': '#8fd3c7', 'overlay-opacity': 0.15, 'overlay-padding': 4
      } }
    ]
  });

  // Deliberate dev hook: the whole page is a dev tool, and a reachable cy
  // instance makes the graph pokeable from the browser console.
  window.cy = cy;

  // ===== flow DAG (right column) =========================================
  // The governance pipeline as a fixed directed graph: a vertical trunk
  // (request → classify → gate → audit) fanning into the three gate outcomes
  // (deny · hold · allow), with hold → confirm → grant rejoining execute. It is
  // driven by the SAME snapshot as the state map: each tick, the path the most
  // recent call took lights up (allow green / deny red / hold amber) and the
  // rest dims. State on the left, process on the right, one dataset.
  function dnode(id, label, desc, x, y) {
    return { data: { id: id, label: label, desc: desc }, position: { x: x, y: y } };
  }
  function dedge(id, s, t) { return { data: { id: id, source: s, target: t } }; }
  var dagEls = [
    dnode('d-request', 'request', 'A tool call arrives from the CLI or an MCP commission.', 60, 80),
    dnode('d-classify', 'classify', 'Mapped to an abstract service · verb · noun via the tool registry.', 185, 80),
    dnode('d-gate', 'gate\\npermission · spend · rate', 'The governed checks run in order; the first failure decides the outcome.', 315, 80),
    dnode('d-audit', 'audit (record)', 'The decision is written to the hash-chained audit log before anything runs.', 450, 80),
    dnode('d-allow', 'allow', 'A covering grant already exists — cleared to run.', 590, 25),
    dnode('d-hold', 'hold', 'Parked as a held call, awaiting your confirmation.', 590, 80),
    dnode('d-deny', 'deny', 'No covering grant and not offered for confirmation — blocked, and recorded.', 590, 135),
    dnode('d-confirm', 'confirm', 'You resolve the held call: deny / for this task / for this session.', 720, 80),
    dnode('d-grant', 'grant', 'An approval writes a grant into policy for the task or the session.', 850, 80),
    dnode('d-execute', 'execute', 'The call runs against the connected-service credential.', 985, 45),
    dedge('fe1', 'd-request', 'd-classify'),
    dedge('fe2', 'd-classify', 'd-gate'),
    dedge('fe3', 'd-gate', 'd-audit'),
    dedge('fe-deny', 'd-audit', 'd-deny'),
    dedge('fe-hold', 'd-audit', 'd-hold'),
    dedge('fe-allow', 'd-audit', 'd-allow'),
    dedge('fe-conf', 'd-hold', 'd-confirm'),
    dedge('fe-grant', 'd-confirm', 'd-grant'),
    dedge('fe-gx', 'd-grant', 'd-execute'),
    dedge('fe-ax', 'd-allow', 'd-execute')
  ];
  var cy2 = cytoscape({
    container: document.getElementById('cy2'),
    elements: dagEls,
    layout: { name: 'preset', fit: true, padding: 20 },
    userZoomingEnabled: false, userPanningEnabled: false,
    boxSelectionEnabled: false, autoungrabify: true,
    style: [
      { selector: 'node', style: {
        'background-color': '#20242c', 'border-width': 1.5, 'border-color': '#3a4150',
        shape: 'round-rectangle', width: 82, height: 30,
        label: 'data(label)', color: '#9aa0ad', 'text-wrap': 'wrap',
        'text-max-width': '80px', 'text-valign': 'center', 'text-halign': 'center',
        'font-family': 'ui-monospace, Menlo, monospace', 'font-size': 9,
        'transition-property': 'border-color, border-width, color, opacity',
        'transition-duration': 300
      } },
      { selector: 'edge', style: {
        width: 1.3, 'line-color': '#333a44', 'target-arrow-shape': 'triangle',
        'target-arrow-color': '#333a44', 'curve-style': 'bezier', 'arrow-scale': 0.7,
        'transition-property': 'line-color, width, opacity', 'transition-duration': 300
      } },
      { selector: '.dim', style: { opacity: 0.5 } },
      { selector: 'node.on-allow', style: { 'border-color': C.allow, 'border-width': 2.5, color: C.label } },
      { selector: 'edge.on-allow', style: { 'line-color': C.allow, 'target-arrow-color': C.allow, width: 2.5 } },
      { selector: 'node.on-deny', style: { 'border-color': C.deny, 'border-width': 2.5, color: C.label } },
      { selector: 'edge.on-deny', style: { 'line-color': C.deny, 'target-arrow-color': C.deny, width: 2.5 } },
      { selector: 'node.on-hold', style: { 'border-color': C.pending, 'border-width': 2.5, color: C.label } },
      { selector: 'edge.on-hold', style: { 'line-color': C.pending, 'target-arrow-color': C.pending, width: 2.5 } }
    ]
  });
  window.cy2 = cy2;
  cy2.on('tap', function (evt) {
    if (evt.target === cy2) { showHome(); return; }
    var d = evt.target.data();
    if (d.desc) showDetail(d.label.replace('\\n', ' '), { stage: d.label.replace('\\n', ' '), what: d.desc }, null);
  });

  // Lifecycle rows record something that happened to the SYSTEM, not a
  // governed tool call: synthetic service/verb outside the tool registry, and
  // decision/outcome carrying fixed placeholders with the real disposition in
  // error_message. Matched on tool_name because the row has no column that
  // says so. Keep this list and @habenula-ai/audit's LIFECYCLE_TOOLS in step until the
  // record gains an explicit discriminator — the engine writers are
  // createSessionInTxn, writeSessionEnd, and writeTaskCancelAudit.
  var LIFECYCLE_TOOLS = ['session.start', 'session.end', 'task.cancel'];
  function isLifecycle(au) { return LIFECYCLE_TOOLS.indexOf(au.toolName) !== -1; }

  // The element ids on each path segment. The lit path = trunk + one outcome.
  var DAG = {
    trunk: ['d-request', 'd-classify', 'd-gate', 'd-audit', 'fe1', 'fe2', 'fe3'],
    allow: ['d-allow', 'd-execute', 'fe-allow', 'fe-ax'],
    deny: ['d-deny', 'fe-deny'],
    hold: ['d-hold', 'fe-hold']
  };
  function litFor(snap) {
    // Any held call is the live 'hold' outcome regardless of the audit top.
    if (snap.held.length) return { cls: 'on-hold', ids: DAG.trunk.concat(DAG.hold) };
    // Otherwise the most recent NON-lifecycle audit entry decides what shows.
    var recent = snap.audit.recent || [];
    for (var i = 0; i < recent.length; i++) {
      var au = recent[i];
      if (isLifecycle(au)) continue;
      if (au.decision === 'allow') return { cls: 'on-allow', ids: DAG.trunk.concat(DAG.allow) };
      if (au.decision === 'deny') return { cls: 'on-deny', ids: DAG.trunk.concat(DAG.deny) };
      return { cls: 'on-hold', ids: DAG.trunk.concat(DAG.hold) };
    }
    return null; // no real call yet — leave the DAG at rest (all dim)
  }
  function updateFlowDag(snap) {
    var lit = litFor(snap);
    cy2.batch(function () {
      cy2.elements().removeClass('on-allow on-deny on-hold dim');
      cy2.elements().addClass('dim');
      if (!lit) return;
      var set = cy2.collection();
      lit.ids.forEach(function (id) { set = set.union(cy2.$id(id)); });
      set.removeClass('dim').addClass(lit.cls);
    });
  }

  var CONTRACTS = {};
  fetch('/api/dev/contracts').then(function (r) { return r.json(); })
    .then(function (body) {
      (body.routes || []).forEach(function (rc) { CONTRACTS[rc.route] = rc; });
    })
    .catch(function () { /* panel falls back to a hint */ });

  // ----- detail panel (textContent only — untrusted-safe by construction) --
  var panel = document.getElementById('panel');
  var UNTRUSTED = { noun: 1, goal: 1, params: 1, data: 1,
                    parametersMetadata: 1, errorMessage: 1 };
  function showDetail(title, obj, schemaRoute) {
    panel.replaceChildren();
    var h = document.createElement('h2');
    h.textContent = title;
    panel.appendChild(h);
    if (obj) {
      var dl = document.createElement('dl');
      Object.keys(obj).forEach(function (k) {
        if (obj[k] === undefined) return;
        var dt = document.createElement('dt');
        dt.textContent = UNTRUSTED[k] ? k + ' ⚠' : k;
        var dd = document.createElement('dd');
        if (UNTRUSTED[k]) dd.className = 'untrusted';
        var v = obj[k];
        dd.textContent = v === null ? 'null'
          : typeof v === 'object' ? JSON.stringify(v) : String(v);
        dl.appendChild(dt); dl.appendChild(dd);
      });
      panel.appendChild(dl);
    }
    if (schemaRoute) {
      var rc = CONTRACTS[schemaRoute];
      var pre = document.createElement('pre');
      pre.textContent = rc
        ? JSON.stringify(
            { query: rc.query, request: rc.request, response: rc.response },
            null,
            2,
          )
        : (schemaRoute === '/mcp'
          ? 'MCP surface (Streamable HTTP) — not a Zod-contract route.\\n' +
            'Verbs: habenula_commission, habenula_status, habenula_result.\\n' +
            'Resource: habenula://capabilities.'
          : 'No contract descriptor for ' + schemaRoute);
      panel.appendChild(pre);
    }
    var note = document.createElement('p');
    note.className = 'hint';
    note.style.marginTop = '10px';
    note.textContent = '⚠ = externally-influenced value (rendered as text, never markup)';
    panel.appendChild(note);
  }
  function showHome() {
    panel.replaceChildren();
    var h = document.createElement('h2');
    h.textContent = 'Habenula visual model';
    panel.appendChild(h);
    var p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'Left: the live governed state (this DO). Right: the action ' +
      'flow — how the latest call moved through the gate. The graph re-reads the ' +
      'engine each second; drive the CLI or an MCP commission and watch both move. ' +
      'Click any record for its sanitized fields.';
    panel.appendChild(p);
    var lg = document.createElement('div');
    lg.className = 'legend';
    [['pending / awaiting', C.pending], ['allow / completed', C.allow],
     ['deny / failed', C.deny], ['session', C.session],
     ['commission', C.commission], ['expired / floor', C.dim]
    ].forEach(function (row) {
      var d = document.createElement('div');
      var sw = document.createElement('span');
      sw.style.background = row[1];
      d.appendChild(sw);
      d.appendChild(document.createTextNode(row[0]));
      lg.appendChild(d);
    });
    panel.appendChild(lg);
  }
  showHome();

  cy.on('tap', function (evt) {
    if (evt.target === cy) { showHome(); return; }
    var d = evt.target.data();
    if (d.kind === 'wire') { showDetail(d.label, null, d.route); return; }
    if (d.detail) { showDetail(d.title || d.label, d.detail, null); return; }
    showDetail(d.label || d.id, null, null);
  });

  // ----- snapshot → desired dynamic elements ------------------------------
  function trunc(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }
  // Per-box display windows: the canvas has no scroll regions, so each box
  // caps at a fixed window and a '+ N more…' row opens the full list in the
  // (scrollable) side panel. Newest first everywhere.
  var SHOW = { comm: 3, audit: 8, policy: 8, svc: 6 };

  function buildDesired(snap) {
    var els = {};
    function add(id, data, pos) {
      data.id = id;
      els[id] = { data: data, position: pos };
    }
    // One '+ N more…' row per overflowing box. Its 'detail' is the full-list
    // summary the side panel renders (textContent only, like everything).
    function addMore(boxId, hiddenCount, detail, pos) {
      add('more-' + boxId, {
        parent: boxId, kind: 'more',
        label: '+ ' + hiddenCount + ' more…',
        title: 'not drawn — click rows are in this panel',
        detail: detail
      }, pos);
    }
    var sess = snap.session;
    if (sess) {
      add('sess-' + sess.sessionId, {
        label: 'session ' + trunc(sess.sessionId, 10),
        stateColor: C.session, title: 'session_state row',
        detail: { sessionId: sess.sessionId, startedAt: sess.startedAt,
                  expiry: sess.expiry }
      }, { x: 690, y: 90 });
    }
    // One node per pending held call (oldest first), stacked below the
    // session node — several tasks can each park one.
    snap.held.forEach(function (held, i) {
      add('held-' + held.heldCallId, {
        label: '⏸ held: ' + held.service + ' · ' + held.verb,
        stateColor: C.pending, title: 'held_tool_calls row (awaiting approval)',
        detail: { heldCallId: held.heldCallId, service: held.service,
                  verb: held.verb, noun: held.noun,
                  params: held.params, origin: held.origin,
                  goal: held.goal, sessionId: held.sessionId,
                  heldAt: held.heldAt, runId: held.runId }
      }, { x: 690, y: 230 + i * 62 });
      if (sess) {
        add('j-held-sess-' + held.heldCallId, { source: 'held-' + held.heldCallId,
          target: 'sess-' + sess.sessionId, kind: 'join', label: 'session_id' });
      }
    });
    var peOverflow = snap.policyEntries.slice(SHOW.policy);
    if (peOverflow.length) {
      var peDetail = {};
      peOverflow.forEach(function (pe, i) {
        peDetail[SHOW.policy + i + 1] = pe.decision + ' (' + pe.source + '): ' +
          pe.service + '·' + pe.verb + '·' + pe.noun;
      });
      addMore('box-policy', peOverflow.length, peDetail,
        { x: 620 + (SHOW.policy % 2) * 190, y: 400 + Math.floor(SHOW.policy / 2) * 62 });
    }
    snap.policyEntries.slice(0, SHOW.policy).forEach(function (pe, i) {
      add('pe-' + pe.id, {
        parent: 'box-policy',
        label: pe.decision + ': ' + trunc(pe.service + '·' + pe.verb + '·' + pe.noun, 26),
        stateColor: pe.source === 'standing'
          ? C.dim : (pe.decision === 'allow' ? C.allow : C.deny),
        title: 'policy_entries row (' + pe.source + ')',
        detail: { id: pe.id, source: pe.source, service: pe.service,
                  verb: pe.verb, noun: pe.noun, decision: pe.decision,
                  priority: pe.priority, createdAt: pe.createdAt,
                  expiresAt: pe.expiresAt, sessionId: pe.sessionId }
      }, { x: 620 + (i % 2) * 190, y: 400 + Math.floor(i / 2) * 62 });
      if (pe.sessionId && sess && pe.sessionId === sess.sessionId) {
        add('j-pe-' + pe.id, { source: 'pe-' + pe.id,
          target: 'sess-' + sess.sessionId, kind: 'join', label: 'session_id' });
      }
    });
    if (snap.commissions.total > SHOW.comm) {
      var cmDetail = {};
      snap.commissions.recent.slice(SHOW.comm).forEach(function (cm, i) {
        cmDetail[SHOW.comm + i + 1] = '[' + cm.status + '] ' + trunc(cm.goal, 42) +
          ' · ' + cm.updatedAt;
      });
      if (snap.commissions.total > snap.commissions.recent.length) {
        cmDetail.note = 'snapshot window holds the newest ' +
          snap.commissions.recent.length + ' of ' + snap.commissions.total;
      }
      addMore('box-comm', snap.commissions.total - SHOW.comm, cmDetail,
        { x: 1080, y: 90 + SHOW.comm * 56 });
    }
    snap.commissions.recent.slice(0, SHOW.comm).forEach(function (cm, i) {
      add('cm-' + cm.id, {
        parent: 'box-comm',
        label: '↑ ' + trunc(cm.goal, 24) + ' [' + cm.status + ']',
        stateColor: COMMISSION_COLOR[cm.status] || C.commission,
        title: 'commission_runs row',
        detail: { id: cm.id, origin: cm.origin, goal: cm.goal, data: cm.data,
                  status: cm.status, sessionId: cm.sessionId,
                  createdAt: cm.createdAt, updatedAt: cm.updatedAt }
      }, { x: 1080, y: 90 + i * 56 });
      if (held && held.runId === cm.id) {
        add('j-cm-held', { source: 'cm-' + cm.id,
          target: 'held-' + held.heldCallId, kind: 'join', label: 'run_id' });
      }
    });
    var svOverflow = snap.connectedServices.slice(SHOW.svc);
    if (svOverflow.length) {
      var svDetail = {};
      svOverflow.forEach(function (sv, i) {
        svDetail[SHOW.svc + i + 1] = sv.service + (sv.hasCredential ? ' (credential)' : '');
      });
      addMore('box-svc', svOverflow.length, svDetail,
        { x: 1080, y: 330 + SHOW.svc * 62 });
    }
    snap.connectedServices.slice(0, SHOW.svc).forEach(function (sv, i) {
      add('sv-' + sv.service, {
        parent: 'box-svc',
        label: sv.service + (sv.hasCredential ? ' 🔑' : ''),
        stateColor: C.service, title: 'connected_services row',
        detail: { service: sv.service, connectedAt: sv.connectedAt,
                  hasCredential: sv.hasCredential }
      }, { x: 1080, y: 330 + i * 62 });
    });
    if (snap.audit.total > SHOW.audit) {
      var auDetail = {};
      snap.audit.recent.slice(SHOW.audit).forEach(function (au, i) {
        auDetail[SHOW.audit + i + 1] = '#' + au.sequenceNum + ' ' + au.decision +
          ' ' + au.service + '·' + au.verb + ' → ' + au.outcome + ' · ' + au.timestamp;
      });
      if (snap.audit.total > snap.audit.recent.length) {
        auDetail.note = 'snapshot window holds the newest ' +
          snap.audit.recent.length + ' of ' + snap.audit.total +
          ' — full history via habenula log';
      }
      addMore('box-audit', snap.audit.total - SHOW.audit, auDetail,
        { x: 1390, y: 90 + SHOW.audit * 56 });
    }
    // Closer counts run over the SHIPPED window (snap.audit.recent), not the
    // drawn slice: a second closer the page did not draw is still evidence of
    // a conflict — the label is about the decision, not about what fits. Two
    // closers naming one referent is a real conflict however narrow the
    // window is, which is why this label needs no hedge. The mirror case (an
    // unresolved decision) gets NO label here: absence of a closer inside a
    // window is not evidence of absence in the chain, and this page has no
    // carry to give it — 'habenula log verify' is the authoritative surface.
    var closerCount = {};
    snap.audit.recent.forEach(function (au) {
      if (au.decisionEntryId) {
        closerCount[au.decisionEntryId] = (closerCount[au.decisionEntryId] || 0) + 1;
      }
    });
    var recent = snap.audit.recent.slice(0, SHOW.audit);
    recent.forEach(function (au, i) {
      // Lifecycle rows (see LIFECYCLE_TOOLS) carry FIXED PLACEHOLDERS in
      // decision/outcome — the columns are verdict-only by spec — with the
      // real disposition in error_message. session.end stamps deny/timeout, so
      // painting the placeholder verdict would misread an ordinary end as a
      // failed one; task.cancel's error_message is descriptive prose, not a
      // failure. Render them neutrally, labeled by their reason.
      var lifecycle = isLifecycle(au);
      // A decision (referent-free, non-lifecycle) carrying two or more
      // closers in the shipped window is conflicted — the spec's one label
      // for this page, "and no more than that".
      var conflicted = !lifecycle && !au.decisionEntryId &&
        (closerCount[au.id] || 0) >= 2;
      add('au-' + au.id, {
        parent: 'box-audit',
        label: lifecycle
          ? au.toolName + (au.errorMessage ? ' (' + trunc(au.errorMessage, 12) + ')' : '')
          : au.decision + ' ' + trunc(au.service + '·' + au.verb, 20) +
            (conflicted ? ' ⚠ conflicted' : ''),
        stateColor: lifecycle ? C.session
          : au.decision === 'allow' ? C.allow
          : au.decision === 'deny' ? C.deny : C.pending,
        title: lifecycle
          ? 'audit_log entry #' + au.sequenceNum + ' (lifecycle event — decision/outcome are fixed placeholders)'
          : 'audit_log entry #' + au.sequenceNum,
        detail: { reason: lifecycle ? au.errorMessage : undefined,
                  id: au.id, timestamp: au.timestamp, toolName: au.toolName,
                  service: au.service, verb: au.verb, noun: au.noun,
                  decision: au.decision, outcome: au.outcome, origin: au.origin,
                  parametersMetadata: au.parametersMetadata,
                  errorMessage: au.errorMessage,
                  decisionEntryId: au.decisionEntryId,
                  latencyMs: au.latencyMs, costUsd: au.costUsd,
                  sequenceNum: au.sequenceNum, epochId: au.epochId,
                  hash: au.hash, prevHash: au.prevHash }
      }, { x: 1390, y: 90 + i * 56 });
      if (i + 1 < recent.length) {
        add('ch-' + au.id, { source: 'au-' + au.id,
          target: 'au-' + recent[i + 1].id, kind: 'chain', label: '' });
      }
      if (au.decisionEntryId) {
        // 'au-': the referent is an AUDIT row (the decision entry), not a
        // policy entry — the old 'pe-' target never materialized, so the
        // edge-pruning pass below dropped this edge on every tick. The fix
        // does NOT mean the edge always renders: it still draws only when
        // the closer AND its decision are both inside the drawn slice.
        add('j-au-' + au.id, { source: 'au-' + au.id,
          target: 'au-' + au.decisionEntryId, kind: 'join', label: 'decided by' });
      }
    });
    // An edge whose endpoint didn't materialize this tick must not be added.
    Object.keys(els).forEach(function (id) {
      var d = els[id].data;
      if (d.source && (!els[d.source] && cy.$id(d.source).empty()) ||
          d.target && (!els[d.target] && cy.$id(d.target).empty())) {
        delete els[id];
      }
    });
    return els;
  }

  // ----- poll + diff -------------------------------------------------------
  var known = {};   // id → JSON fingerprint
  var initialized = false; // first tick renders silently, no flash/pulse
  var lastAuditTop = null;
  function applySnapshot(snap) {
    var desired = buildDesired(snap);
    Object.keys(known).forEach(function (id) {
      if (!desired[id]) { cy.$id(id).remove(); delete known[id]; }
    });
    // Nodes first, then edges: an edge added before its endpoint node exists
    // makes cytoscape throw (the audit chain edge points at the NEXT entry).
    var ids = Object.keys(desired).sort(function (a, b) {
      var ae = desired[a].data.source ? 1 : 0;
      var be = desired[b].data.source ? 1 : 0;
      return ae - be;
    });
    ids.forEach(function (id) {
      var el = desired[id];
      var fp = JSON.stringify(el.data);
      var existing = cy.$id(id);
      if (existing.empty()) {
        var added = cy.add(el.position
          ? { data: el.data, position: el.position } : { data: el.data });
        if (initialized) flash(added);
      } else if (known[id] !== fp) {
        existing.data(el.data);
        flash(existing);
      }
      if (el.position && !cy.$id(id).empty()) {
        cy.$id(id).position(el.position);
      }
      known[id] = fp;
    });
    var top = snap.audit.recent[0];
    if (top && top.id !== lastAuditTop) {
      // The latest call stays lit indefinitely; when a newer one lands the
      // highlight MOVES to it rather than fading. markLatest runs on the first
      // (silent) render too, so an existing latest call loads already lit; the
      // bright arrival pulse is reserved for calls that land while watching.
      markLatest(top);
      if (initialized) pulseFor(top);
    }
    if (top) lastAuditTop = top.id;
    updateFlowDag(snap);
    initialized = true;
    var c = snap.tableCounts;
    document.getElementById('counts').textContent =
      'audit ' + snap.audit.total + ' · policy ' + c.policyEntries +
      ' · held ' + c.heldToolCalls + ' · commissions ' + snap.commissions.total +
      ' · services ' + c.connectedServices + ' · sessions ' + c.sessionState +
      ' · spends ' + c.spendLedger;
  }
  function flash(els) {
    els.addClass('flash');
    setTimeout(function () { els.removeClass('flash'); }, 900);
  }
  // The origin→engine→audit wire path for one audit entry, used by both the
  // transient arrival pulse and the persistent latest highlight.
  function wirePath(entry) {
    var surface = entry.origin === 'mcp_commission' ? 'w-mcp' : 'w-chat';
    return cy.$id(surface).union(cy.$id('e-box-audit'));
  }
  var latest = cy.collection(); // the currently-lit 'latest call' elements
  function markLatest(entry) {
    latest.removeClass('latest');
    latest = wirePath(entry).union(cy.$id('au-' + entry.id));
    latest.addClass('latest');
  }
  function pulseFor(entry) {
    var path = wirePath(entry);
    path.addClass('pulse');
    setTimeout(function () { path.removeClass('pulse'); }, 3500);
  }

  var dot = document.getElementById('dot');
  var upd = document.getElementById('upd');
  function tick() {
    fetch('/api/dev/model?userId=' + encodeURIComponent(USER))
      .then(function (r) {
        if (!r.ok) throw new Error('http ' + r.status);
        return r.json();
      })
      .catch(function (e) {
        dot.className = 'bad';
        upd.textContent = 'engine unreachable — retrying';
        throw e;
      })
      .then(function (snap) {
        // Distinct from the fetch path: an exception HERE is a page bug, not
        // a connectivity problem, and must say so.
        try {
          applySnapshot(snap);
          dot.className = 'ok';
          upd.textContent = 'live · ' + new Date().toLocaleTimeString();
        } catch (e) {
          dot.className = 'bad';
          upd.textContent = 'render error: ' + e.message;
          console.error('visual model render error', e);
        }
      })
      .catch(function () { /* fetch path already reported */ });
  }
  tick();
  setInterval(tick, 1000);
})();
`;

/**
 * The Habenula favicon, embedded as a data URI so the page stays free of
 * external requests. Bytes are the 32×32 brand favicon PNG (713 B) from the
 * internal brand asset set — re-encode from there if the brand asset changes.
 */
const FAVICON_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAABmJLR0QA/wD/AP+gvaeTAAACfklEQVRYhe2WT0hUURTGv+85b940RFEiOeMIWYmVgToEbfrDZG6LqBZtw0XLkCKRINrVoqBId22iXEXQKglXERSVo9aiqEXIOA4aaQap897MPS0ca/686b03jiv9dvee757vx4EDF9jQehe9mD/IxDZl+U4LJAagBUBtrs00wDFNyfOgsfCimc3pqgLkgm8I0A1gk4N9hpCbuj7f38pWc9UA49bkcSUcBLDDDWxe4xFR6nxHoPFrxQCj6clzIAcB+LyE5+m7QLqi/sh4OYNWrhC3Usf+hcvdrHCfprAXZB8Ax9HmVKcJh97KTH05g+0E3siPLYaZ/gxKSAS3okZDb359zExeEOCBSwgAGO7wN3TZFWwnYJiLV0EJAQAy2XvF9Tk9/BDALw8AJ+JLyZOuAN7LVBDkxZWzClq/iz0xMgNg0QMAqEmPKwA9LZ0Atv81WMapYs+4mTgEj1sB8MhHmS55UwKgiKMFz8A7cWuyc+UcT6f2K2iPvIUvZ1lm9nDxZcl6iYYWSsFVLYXDo2byGwALULsB1FQAAGpocQSgYGuZ902VhBZK9OIbuy1wu+OeRVWaZwPAqbUCEDLhCCDAyFoBUPjaEUBTamiZo+qaafPXf3IEaA9EvgDystrpQrlPUjkCAACpXUNVp8B5wyf9dhVbgHY9/ArAQLXiRVR3KxtnXQMAwE89fAnA8GrDCd6OGpEn5eplAWJkJq0HzoB4VmG2CHG9TQ9d+T+gYxfhWCbVC5E+AJtdhk9Q2NNuhJ86GV3/iuOSqqOpLoNyFuAuW1ZgVKM8nvNZAzE2Lbnp6+lbvqKRpcQejTUHhFJLSFYUZ5VhvTvInalK+m1ofesP34/W0Hx4T/oAAAAASUVORK5CYII=";

export function renderModelPage(): string {
  return (
    "<!doctype html>\n<html><head><meta charset=\"utf-8\">" +
    "<title>Habenula · visual model</title>" +
    "<link rel=\"icon\" type=\"image/png\" href=\"" + FAVICON_DATA_URI + "\">" +
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
    "<style>" + PAGE_CSS + "</style></head><body>" +
    "<header><h1>habenula · visual model</h1><span id=\"who\"></span>" +
    "<span><span id=\"dot\"></span><span id=\"upd\">connecting…</span></span>" +
    "<span id=\"counts\"></span></header>" +
    "<main><div id=\"views\"><div id=\"cy\"></div>" +
    "<div id=\"flowrow\"><div class=\"col-h\">action flow " +
    "<small>· how the latest call moved through the gate</small></div>" +
    "<div id=\"cy2\"></div></div></div>" +
    "<aside id=\"panel\"></aside></main>" +
    "<script>" + cytoscapeSource + "</script>" +
    "<script>" + APP_JS + "</script>" +
    "</body></html>"
  );
}
