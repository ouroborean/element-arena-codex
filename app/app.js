/* Element Arena Codex — vanilla JS, no dependencies.
   Data source: window.GAME_DB (embedded by build_data.py) with a fetch() fallback
   so it works both by double-click (file://) and when served over HTTP. */
(function () {
  "use strict";

  var DB = null;
  var ASSETS = null; // Set of repo-relative png paths that exist on disk

  // ---- Indices (built once) ----
  var IDX = {
    elById: {}, elByName: {},
    baseEls: [], fusionEls: [], generic: null,
    recipe: {},            // "a-b" (a<=b) -> result element id
    resultFrom: {},        // fusion-element-id -> [{a,b}] component pairs
    charById: {}, roster: [],
    skillsByOwner: {}, skillById: {},
    augByOwner: {}, masteryByOwner: {},
    minionByOwner: {}, minionById: {}, minions: [],
    charByElement: {},     // base element id -> [chars]
  };

  var el = {
    view: document.getElementById("view"),
    nav: document.getElementById("mainnav"),
    search: document.getElementById("globalSearch"),
    searchResults: document.getElementById("searchResults"),
    footStats: document.getElementById("footStats"),
  };

  // ---------- utilities ----------
  function h(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (k === "class") e.className = attrs[k];
        else if (k === "html") e.innerHTML = attrs[k];
        else if (k === "text") e.textContent = attrs[k];
        else if (k === "style") e.setAttribute("style", attrs[k]);
        else if (k.slice(0, 2) === "on" && typeof attrs[k] === "function") e.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] != null && attrs[k] !== false) e.setAttribute(k, attrs[k]);
      }
    }
    if (children != null) append(e, children);
    return e;
  }
  function append(parent, c) {
    if (c == null) return;
    if (Array.isArray(c)) { c.forEach(function (x) { append(parent, x); }); return; }
    if (typeof c === "string" || typeof c === "number") { parent.appendChild(document.createTextNode(String(c))); return; }
    parent.appendChild(c);
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function esc(s) { return String(s == null ? "" : s); }
  function titleCase(s) { return String(s || "").replace(/(^|[\s-])([a-z])/g, function (_, a, b) { return a + b.toUpperCase(); }); }

  function assetExists(path) { return ASSETS ? ASSETS.has(path) : true; }
  // <img> that hides itself (and optional wrapper) if the file can't load.
  function img(src, cls, alt) {
    var i = h("img", { class: cls || "", alt: alt || "", loading: "lazy" });
    i.addEventListener("error", function () { i.style.visibility = "hidden"; });
    if (src) i.src = src; else i.style.visibility = "hidden";
    return i;
  }

  // ---------- element colors ----------
  function hexToRgb(hx) {
    if (!hx) return [120, 128, 145];
    hx = hx.replace("#", "");
    return [parseInt(hx.slice(0, 2), 16), parseInt(hx.slice(2, 4), 16), parseInt(hx.slice(4, 6), 16)];
  }
  function rgbToHex(r) { return "#" + r.map(function (v) { return ("0" + Math.round(v).toString(16)).slice(-2); }).join(""); }
  function mix(a, b) { var x = hexToRgb(a), y = hexToRgb(b); return rgbToHex([(x[0] + y[0]) / 2, (x[1] + y[1]) / 2, (x[2] + y[2]) / 2]); }

  // Representative solid color for any element (base = its color, fusion = mix of components, generic = gold).
  function elColor(elm) {
    if (!elm) return "#788091";
    if (elm.is_generic) return "#c9a24a";
    if (elm.color) return elm.color;
    if (elm.components && elm.components.length) {
      var c = elm.components[0];
      return mix(baseColorId(c.a), baseColorId(c.b));
    }
    return "#788091";
  }
  function baseColorId(id) { var e = IDX.elById[id]; return (e && e.color) || "#788091"; }
  function elGradient(elm) {
    if (elm && elm.components && elm.components.length) {
      var c = elm.components[0];
      return "linear-gradient(90deg," + baseColorId(c.a) + "," + baseColorId(c.b) + ")";
    }
    return elColor(elm);
  }

  function resolveEl(ref) {
    if (!ref) return null;
    if (ref.id != null && IDX.elById[ref.id]) return IDX.elById[ref.id];
    if (ref.name && IDX.elByName[ref.name]) return IDX.elByName[ref.name];
    return ref;
  }

  // Element chip (clickable → element page)
  function elChip(ref, opts) {
    opts = opts || {};
    var e = resolveEl(ref);
    if (!e) return h("span", { class: "chip" }, "—");
    var color = elColor(e);
    var chip = h("span", {
      class: "chip el" + (opts.sm ? " sm" : ""),
      style: "border-color:" + color + "55;background:" + color + "1f",
      title: (e.is_fusion ? "Fusion element" : e.is_base ? "Base element" : "Element"),
    }, [
      h("span", { class: "dot", style: "background:" + (e.is_fusion ? "transparent" : color) + ";" + (e.is_fusion ? "background:" + elGradient(e) : "") }),
      e.display_name,
    ]);
    if (opts.link !== false) {
      chip.style.cursor = "pointer";
      chip.addEventListener("click", function (ev) { ev.stopPropagation(); go("#/element/" + e.name); });
    }
    return chip;
  }

  // ---------- build indices ----------
  function buildIndices() {
    DB.elements.forEach(function (e) {
      IDX.elById[e.id] = e; IDX.elByName[e.name] = e;
      if (e.is_generic) IDX.generic = e;
      else if (e.is_base) IDX.baseEls.push(e);
      else if (e.is_fusion) { IDX.fusionEls.push(e); IDX.resultFrom[e.id] = e.components || []; }
    });
    IDX.baseEls.sort(function (a, b) { return a.id - b.id; });

    DB.fusion_recipes.forEach(function (r) {
      var a = Math.min(r.a, r.b), b = Math.max(r.a, r.b);
      IDX.recipe[a + "-" + b] = r.result;
    });

    DB.characters.forEach(function (c) {
      IDX.charById[c.id] = c;
      if (c.in_roster) IDX.roster.push(c);
      var eid = c.element && c.element.id;
      (IDX.charByElement[eid] = IDX.charByElement[eid] || []).push(c);
    });
    IDX.roster.sort(function (a, b) { return (a.roster_index || 0) - (b.roster_index || 0); });

    DB.skills.forEach(function (s) {
      IDX.skillById[s.id] = s;
      (IDX.skillsByOwner[s.owner] = IDX.skillsByOwner[s.owner] || []).push(s);
    });
    DB.augments.forEach(function (a) { (IDX.augByOwner[a.owner] = IDX.augByOwner[a.owner] || []).push(a); });
    DB.masteries.forEach(function (m) { (IDX.masteryByOwner[m.owner] = IDX.masteryByOwner[m.owner] || []).push(m); });
    DB.minions.forEach(function (m) {
      IDX.minions.push(m); IDX.minionById[m.id] = m;
      (IDX.minionByOwner[m.owner] = IDX.minionByOwner[m.owner] || []).push(m);
    });
  }

  function fusionResultElement(baseA, baseB) {
    var a = Math.min(baseA, baseB), b = Math.max(baseA, baseB);
    var rid = IDX.recipe[a + "-" + b];
    return rid != null ? IDX.elById[rid] : null;
  }

  // ---------- asset path helpers ----------
  function charStem(c) {
    // From "assets/characters/gaia/gaiaprof.png" -> "assets/characters/gaia/gaia"
    if (c.image && /prof\.png$/.test(c.image)) return c.image.replace(/prof\.png$/, "");
    if (c.image) return c.image.replace(/\.png$/, "");
    return "assets/characters/" + c.path_name + "/" + c.path_name;
  }
  function charPortrait(c) {
    var stem = charStem(c);
    var p = stem + "_portrait.png";
    if (assetExists(p)) return p;
    if (assetExists(c.image)) return c.image;
    return c.image;
  }
  function fusionFormArt(c, elemName) {
    var stem = charStem(c);
    var prof = stem + elemName + "prof.png";
    var portrait = stem + elemName + "_portrait.png";
    return { prof: assetExists(prof) ? prof : null, portrait: assetExists(portrait) ? portrait : null };
  }

  // ---------- reusable components ----------
  function costPips(cost, elmColor) {
    var pips = [];
    var g = (cost && cost.generic) || 0, s = (cost && cost.specific) || 0;
    for (var i = 0; i < g; i++) pips.push(h("span", { class: "pip generic", title: "Generic energy (any element)" }));
    for (var j = 0; j < s; j++) pips.push(h("span", { class: "pip specific", style: "--el:" + (elmColor || "var(--accent)"), title: "Specific energy (this element)" }));
    if (!pips.length) pips.push(h("span", { class: "meta-pill", text: "Free" }));
    return h("span", { class: "cost-pips", title: "Energy cost" }, pips);
  }

  function classChips(s) {
    return (s.classes_active || []).filter(function (c) { return c !== "Passive"; }).map(function (c) {
      return h("span", { class: "class-chip class-" + c }, c);
    });
  }

  function skillCard(s, opts) {
    opts = opts || {};
    var e = resolveEl(s.element);
    var color = elColor(e);
    var meta = [];
    if (!s.is_passive) meta.push(costPips(s.cost, color));
    if (s.cooldown) meta.push(h("span", { class: "meta-pill cd", title: "Cooldown" }, "CD " + s.cooldown));
    if (s.is_passive) meta.push(h("span", { class: "passive-flag" }, "PASSIVE"));
    if (s.targeting_type) meta.push(h("span", { class: "meta-pill", title: "Targeting" + (s.targeting_type.defaulted ? " (engine default)" : "") }, "▶ " + s.targeting_type.name));
    if (s.hidden) meta.push(h("span", { class: "meta-pill", title: "Hidden skill" }, "hidden"));
    meta = meta.concat(classChips(s));

    var slotLabel = "";
    var cl = s.classification || {};
    if (cl.kind === "base") slotLabel = "base ·" + (cl.slot === 0 ? " passive" : " slot " + cl.slot);
    else if (cl.kind === "fusion") slotLabel = "fusion · " + cl.fusion_element + (cl.slot === 0 ? " passive" : " active");
    else if (cl.kind === "variant") slotLabel = "variant " + cl.variant + " · slot " + cl.slot;
    else if (cl.kind === "minion") slotLabel = "minion skill";

    var card = h("div", { class: "skill-card" + (opts.click !== false ? " click" : ""), style: "--el:" + color }, [
      img(assetExists(s.image) ? s.image : null, "skill-icon", s.name),
      h("div", { class: "skill-main" }, [
        h("div", { class: "skill-head" }, [
          h("span", { class: "skill-name" }, s.name),
          elChip(e, { sm: true }),
          h("span", { class: "skill-slot" }, slotLabel),
        ]),
        h("div", { class: "skill-desc" }, s.description || h("em", { style: "color:var(--text-faint)" }, "No description.")),
        h("div", { class: "skill-meta" }, meta),
      ]),
    ]);
    if (opts.click !== false) card.addEventListener("click", function () { go("#/skill/" + encodeURIComponent(s.id)); });
    return card;
  }

  // ---------- ROUTER ----------
  var routes = {
    roster: viewRoster,
    char: viewChar,
    fusions: viewFusionLab,
    fusion: viewFusionForm,   // #/fusion/<char>/<elementName>
    skill: viewSkill,
    skills: viewSkills,
    elements: viewElements,
    element: viewElement,
    minions: viewMinions,
    minion: viewMinion,
    about: viewAbout,
  };

  function parseHash() {
    var raw = (location.hash || "#/roster").replace(/^#\/?/, "");
    var parts = raw.split("/").filter(Boolean).map(decodeURIComponent);
    return { route: parts[0] || "roster", args: parts.slice(1) };
  }
  function go(hash) { if (location.hash === hash) render(); else location.hash = hash; }

  function render() {
    var p = parseHash();
    var fn = routes[p.route] || viewRoster;
    clear(el.view);
    window.scrollTo(0, 0);
    try { fn(p.args); } catch (err) {
      el.view.appendChild(h("div", { class: "empty-note" }, "Error rendering view: " + err.message));
      console.error(err);
    }
    // nav highlight
    var group = ({ char: "roster", fusion: "fusions", skill: "skills", element: "elements", minion: "minions" })[p.route] || p.route;
    Array.prototype.forEach.call(el.nav.querySelectorAll("a"), function (a) {
      a.classList.toggle("active", a.getAttribute("data-route") === group);
    });
  }

  function pageHead(title, sub) {
    return h("div", { class: "page-head" }, [h("h1", null, title), sub ? h("div", { class: "sub" }, sub) : null]);
  }
  function backLink(text, hash) {
    return h("div", { class: "backlink", onclick: function () { go(hash); } }, ["← ", text]);
  }

  // ---------- VIEW: Roster ----------
  var rosterState = { q: "", element: "", filter: "all", sort: "roster" };
  function viewRoster() {
    el.view.appendChild(pageHead("Roster", DB.characters.length + " heroes · base HP 100 each · draft any 3 to form a team"));

    var elementOptions = [h("option", { value: "" }, "All elements")].concat(
      IDX.baseEls.concat(IDX.fusionEls).filter(function (e) {
        return DB.characters.some(function (c) { return c.element && c.element.id === e.id; });
      }).map(function (e) { return h("option", { value: e.name }, e.display_name); })
    );

    var elSel = h("select", { onchange: function () { rosterState.element = this.value; draw(); } }, elementOptions);
    elSel.value = rosterState.element;
    var search = h("input", { type: "search", placeholder: "Filter heroes…", value: rosterState.q,
      oninput: function () { rosterState.q = this.value; draw(); } });

    function segBtn(key, label) {
      return h("button", { class: rosterState.filter === key ? "active" : "", onclick: function () { rosterState.filter = key; draw(); redrawSeg(); } }, label);
    }
    var seg = h("div", { class: "seg" });
    function redrawSeg() {
      clear(seg);
      append(seg, [segBtn("all", "All"), segBtn("fuse", "Fuseable"), segBtn("fused", "Starts fused"), segBtn("bot", "Bots")]);
    }
    redrawSeg();

    var countEl = h("span", { class: "count" });
    el.view.appendChild(h("div", { class: "filter-bar" }, [search, elSel, seg, countEl]));
    var grid = h("div", { class: "roster-grid" });
    el.view.appendChild(grid);

    function draw() {
      var q = rosterState.q.trim().toLowerCase();
      var list = DB.characters.filter(function (c) {
        if (rosterState.element && !(c.element && c.element.name === rosterState.element)) return false;
        if (rosterState.filter === "fuse" && !c.can_fuse) return false;
        if (rosterState.filter === "fused" && !c.starts_fused) return false;
        if (rosterState.filter === "bot" && !c.is_bot) return false;
        if (q) {
          var hay = (c.character_name + " " + c.id + " " + (c.short_name || "") + " " + c.element.name).toLowerCase();
          if (hay.indexOf(q) < 0) return false;
        }
        return true;
      });
      list.sort(function (a, b) {
        if (a.in_roster !== b.in_roster) return a.in_roster ? -1 : 1;
        return (a.roster_index != null ? a.roster_index : 99) - (b.roster_index != null ? b.roster_index : 99);
      });
      countEl.textContent = list.length + " shown";
      clear(grid);
      list.forEach(function (c) { grid.appendChild(heroCard(c)); });
      if (!list.length) grid.appendChild(h("div", { class: "empty-note" }, "No heroes match."));
    }
    draw();
  }

  function heroCard(c) {
    var color = elColor(resolveEl(c.element));
    var tags = [];
    if (c.starts_fused) tags.push(h("span", { class: "tag fused" }, "Fused"));
    else if (c.can_fuse) tags.push(h("span", { class: "tag fuse" }, "Fuseable"));
    else tags.push(h("span", { class: "tag nofuse" }, "No fusion"));
    if (!c.in_roster) tags.push(h("span", { class: "tag nofuse" }, "Off-roster"));

    return h("div", { class: "hero-card", onclick: function () { go("#/char/" + c.id); } }, [
      h("div", { class: "el-strip", style: "background:" + elGradient(resolveEl(c.element)) }),
      img(charPortrait(c), "portrait", c.character_name),
      h("div", { class: "body" }, [
        h("div", { class: "hname" }, c.short_name || c.character_name),
        h("div", { class: "hsub" }, c.short_name ? c.character_name : " "),
        h("div", { class: "row" }, [elChip(c.element, { sm: true, link: false }), tags]),
      ]),
    ]);
  }

  // ---------- VIEW: Character ----------
  function viewChar(args) {
    var c = IDX.charById[args[0]];
    if (!c) { el.view.appendChild(h("div", { class: "empty-note" }, "Unknown character.")); return; }
    var color = elColor(resolveEl(c.element));

    el.view.appendChild(backLink("All heroes", "#/roster"));

    var flags = [];
    if (c.starts_fused) flags.push(h("span", { class: "tag fused" }, "Starts fused"));
    else if (c.can_fuse) flags.push(h("span", { class: "tag fuse" }, "Fuseable"));
    else flags.push(h("span", { class: "tag nofuse" }, "No fusion"));
    if (c.can_augment) flags.push(h("span", { class: "tag bot" }, "Augments"));
    if (c.is_bot) flags.push(h("span", { class: "tag nofuse" }, "Bot AI"));
    if (!c.in_roster) flags.push(h("span", { class: "tag nofuse" }, "Off-roster"));

    var titles = c.titles || {};
    var titleStr = ["minor", "middle", "major"].map(function (k) {
      return (titles[k] || []).join(" / ");
    }).filter(Boolean).join("  ·  ");

    var hero = h("div", { class: "char-hero portraits" }, [
      h("div", { class: "char-portrait-wrap" }, [
        img(charPortrait(c), "char-portrait tall", c.character_name),
        h("div", { class: "el-bar", style: "background:" + elGradient(resolveEl(c.element)) }),
      ]),
      h("div", { class: "char-meta" }, [
        h("h1", null, c.character_name),
        h("div", { class: "meta-row" }, [elChip(c.element)].concat(flags)),
        h("div", { class: "statline" }, [
          stat("Base HP", "100"),
          stat("Element", (c.element && c.element.display_name) || "—"),
          stat("Base skills", String((c.base_skill_ids || []).length)),
          stat("Fusion forms", String(Object.keys(c.fusion_skills || {}).length)),
          stat("Augments", String((c.augment_ids || []).length)),
          c.roster_index != null ? stat("Roster #", String(c.roster_index)) : null,
        ]),
        titleStr ? h("div", { class: "titles" }, [h("b", null, "Title words: "), titleStr]) : null,
      ]),
    ]);
    el.view.appendChild(hero);

    // Tabs
    var owned = IDX.skillsByOwner[c.id] || [];
    var baseSkills = owned.filter(function (s) { return (s.classification || {}).kind === "base"; })
      .sort(function (a, b) { return a.classification.slot - b.classification.slot; });
    var augs = (IDX.augByOwner[c.id] || []).slice().sort(function (a, b) { return (a.index || 0) - (b.index || 0); });
    var minions = IDX.minionByOwner[c.id] || [];
    var fusionCount = Object.keys(c.fusion_skills || {}).length;

    var tabs = [];
    tabs.push(["Base skills", baseSkills.length, function () { return skillGrid(baseSkills); }]);
    if (fusionCount) tabs.push(["Fusions", fusionCount, function () { return fusionSection(c); }]);
    if (augs.length) tabs.push(["Augments", augs.length, function () { return augSection(augs); }]);
    if (minions.length) tabs.push(["Minions", minions.length, function () { return minionSection(minions); }]);

    var bar = h("div", { class: "tabbar" });
    var panes = h("div");
    tabs.forEach(function (t, i) {
      var pane = h("div", { class: "tabpane" + (i === 0 ? " active" : "") });
      var built = false;
      var btn = h("button", { class: i === 0 ? "active" : "" }, [t[0], " ", h("span", { class: "badge", style: "background:var(--panel-3);color:var(--text-dim);margin-left:2px" }, String(t[1]))]);
      btn.addEventListener("click", function () {
        Array.prototype.forEach.call(bar.children, function (b) { b.classList.remove("active"); });
        Array.prototype.forEach.call(panes.children, function (pp) { pp.classList.remove("active"); });
        btn.classList.add("active"); pane.classList.add("active");
        if (!built) { append(pane, t[2]()); built = true; }
      });
      if (i === 0) { append(pane, t[2]()); built = true; }
      bar.appendChild(btn); panes.appendChild(pane);
    });
    el.view.appendChild(bar);
    el.view.appendChild(panes);
  }

  function stat(k, v) { return h("div", { class: "stat" }, [h("div", { class: "k" }, k), h("div", { class: "v" }, v)]); }
  function skillGrid(list) {
    if (!list.length) return h("div", { class: "empty-note" }, "None.");
    return h("div", { class: "skill-grid" }, list.map(function (s) { return skillCard(s); }));
  }

  function fusionSection(c) {
    var wrap = h("div");
    wrap.appendChild(h("div", { class: "callout" }, [
      "Between rounds, ", h("b", null, c.short_name || c.character_name), " can fuse with a teammate. The resulting ",
      h("b", null, "fusion element"), " is set by ", h("b", null, (c.element && c.element.display_name)),
      " × the teammate's base element — each pairing below unlocks a fusion passive + active. Try pairings in the ",
      h("a", { href: "#/fusions", style: "color:var(--accent-2)" }, "Fusion Lab"), ".",
    ]));

    // Order fusion forms by base-partner element id for a stable, intuitive layout.
    var forms = [];
    IDX.baseEls.forEach(function (be) {
      var res = fusionResultElement(c.element.id, be.id);
      if (!res) return;
      var pair = (c.fusion_skills || {})[res.name];
      if (!pair) return;
      forms.push({ partner: be, result: res, pair: pair });
    });
    // de-dupe results (in case two partners map to same result — they don't here, but be safe)
    var grid = h("div", { class: "fusion-grid" });
    forms.forEach(function (f) {
      var art = fusionFormArt(c, f.result.name);
      var thumb = art.portrait || art.prof || (IDX.skillById[f.pair.passive] && IDX.skillById[f.pair.passive].image);
      grid.appendChild(h("div", { class: "fusion-card", onclick: function () { go("#/fusion/" + c.id + "/" + f.result.name); } }, [
        h("div", { class: "grad-bar", style: "background:" + elGradient(f.result) }),
        img(thumb, "ff-art", f.result.display_name + " form"),
        h("div", { class: "ff-body" }, [
          h("div", { class: "ff-name" }, f.result.display_name),
          h("div", { class: "ff-recipe" }, [
            miniEl(c.element), h("span", { class: "arrow" }, "+"), miniEl(f.partner),
          ]),
        ]),
      ]));
    });
    wrap.appendChild(grid);
    return wrap;
  }

  function miniEl(e) {
    e = resolveEl(e);
    return h("span", { class: "mini-el" }, [
      h("span", { class: "dot", style: "background:" + (e.is_fusion ? elGradient(e) : elColor(e)) }),
      h("span", null, e.display_name),
    ]);
  }

  function augSection(augs) {
    return h("div", { class: "skill-grid" }, augs.map(function (a) {
      var color = elColor(resolveEl(a.element));
      return h("div", { class: "aug-card", style: "--el:" + color }, [
        h("div", { class: "an" }, [a.display_name || a.augment_name, " ", elChip(a.element, { sm: true })]),
        h("div", { class: "ad" }, a.description || h("em", { style: "color:var(--text-faint)" }, "No description.")),
        h("div", { class: "ai" }, "id " + a.id + (a.deploy_mark ? " · deploy mark" : "")),
      ]);
    }));
  }
  function ownerMinionSkills(ownerId) {
    return (IDX.skillsByOwner[ownerId] || []).filter(function (s) { return s.is_minion_skill; });
  }
  function minionSection(minions) {
    var ownerId = minions[0] && minions[0].owner;
    var mskills = ownerId ? ownerMinionSkills(ownerId) : [];
    var wrap = h("div");
    wrap.appendChild(minionGrid(minions));
    if (mskills.length) {
      wrap.appendChild(h("div", { class: "sec-sub", style: "margin:22px 0 12px;font-weight:700;color:var(--text);font-size:15px" },
        "Minion abilities (" + mskills.length + ")"));
      wrap.appendChild(h("div", { class: "callout" }, "The extractor keys minion abilities to the summoner, not to individual minions — so the full summoned-ability pool is listed together here."));
      wrap.appendChild(skillGrid(mskills));
    }
    return wrap;
  }

  // ---------- VIEW: single fusion form ----------
  function viewFusionForm(args) {
    var c = IDX.charById[args[0]];
    var res = IDX.elByName[args[1]];
    if (!c || !res) { el.view.appendChild(h("div", { class: "empty-note" }, "Unknown fusion form.")); return; }
    var pair = (c.fusion_skills || {})[res.name];
    if (!pair) { el.view.appendChild(h("div", { class: "empty-note" }, "This hero has no " + res.display_name + " fusion.")); return; }

    el.view.appendChild(h("div", { class: "breadcrumb" }, [
      h("a", { href: "#/roster" }, "Roster"), sep(), h("a", { href: "#/char/" + c.id }, c.short_name || c.character_name),
      sep(), "Fusion · " + res.display_name,
    ]));

    // which base partner(s) yield this
    var partners = [];
    IDX.baseEls.forEach(function (be) {
      var r = fusionResultElement(c.element.id, be.id);
      if (r && r.id === res.id) partners.push(be);
    });

    var art = fusionFormArt(c, res.name);
    var hero = h("div", { class: "char-hero portraits" }, [
      h("div", { class: "char-portrait-wrap" }, [
        img(art.portrait || art.prof || charPortrait(c), "char-portrait tall", res.display_name + " form"),
        h("div", { class: "el-bar", style: "background:" + elGradient(res) }),
      ]),
      h("div", { class: "char-meta" }, [
        h("h1", null, [(c.short_name || c.character_name), " · ", res.display_name]),
        h("div", { class: "meta-row" }, [elChip(res)]),
        h("div", { class: "recipe-note" }, [
          miniEl(c.element), h("span", { class: "arrow" }, "+"),
          h("span", null, partners.map(function (p, i) { return h("span", null, [i ? " / " : "", miniEl(p)]); })),
          h("span", { class: "arrow" }, "→"), miniEl(res),
        ]),
        h("div", { class: "callout" }, [
          "Fuse ", h("b", null, c.short_name || c.character_name), " with a teammate whose base element is ",
          h("b", null, partners.map(function (p) { return p.display_name; }).join(" or ")),
          " to take the ", h("b", null, res.display_name), " form.",
        ]),
      ]),
    ]);
    el.view.appendChild(hero);

    var skills = [pair.passive, pair.active].map(function (id) { return IDX.skillById[id]; }).filter(Boolean);
    el.view.appendChild(h("div", { class: "section" }, [h("h2", null, "Fusion skills"), skillGrid(skills)]));
  }
  function sep() { return h("span", { class: "sep" }, "›"); }

  // ---------- VIEW: Fusion Lab (pairing tool) ----------
  var labState = { a: null, b: null };
  function viewFusionLab() {
    el.view.appendChild(pageHead("Fusion Lab", "Pick two teammates — see the fusion element they'd share and each hero's fusion kit for it."));

    var fuseable = DB.characters.filter(function (c) { return c.can_fuse; })
      .sort(function (a, b) { return (a.short_name || a.character_name).localeCompare(b.short_name || b.character_name); });

    if (!labState.a) labState.a = fuseable[0].id;
    if (!labState.b) labState.b = fuseable[1].id;

    function pickSelect(which) {
      var sel = h("select", { onchange: function () { labState[which] = this.value; draw(); } },
        fuseable.map(function (c) { return h("option", { value: c.id }, (c.short_name || c.character_name) + " — " + c.element.display_name); }));
      sel.value = labState[which];
      return sel;
    }

    var selA = h("div", { class: "lab-pick" });
    var selB = h("div", { class: "lab-pick" });
    el.view.appendChild(h("div", { class: "lab-selectors" }, [
      selA, h("div", { class: "lab-fuse-mark" }, "✦"), selB,
    ]));
    var result = h("div", { class: "lab-result" });
    el.view.appendChild(result);

    function draw() {
      clear(selA); append(selA, [h("label", null, "Hero A"), pickSelect("a")]);
      clear(selB); append(selB, [h("label", null, "Hero B"), pickSelect("b")]);
      clear(result);
      var ca = IDX.charById[labState.a], cb = IDX.charById[labState.b];
      if (!ca || !cb) return;
      if (ca.id === cb.id) { result.appendChild(h("div", { class: "empty-note" }, "Pick two different heroes.")); return; }
      var res = fusionResultElement(ca.element.id, cb.element.id);
      if (!res) { result.appendChild(h("div", { class: "empty-note" }, "No fusion recipe for that element pair.")); return; }

      result.appendChild(h("div", { class: "result-head", style: "border-left:5px solid " + elColor(res) }, [
        miniEl(ca.element), h("span", { class: "arrow", style: "font-size:20px" }, "+"), miniEl(cb.element),
        h("span", { class: "arrow", style: "font-size:20px" }, "→"),
        h("span", { class: "big-el", style: "color:" + elColor(res) }, res.display_name),
        h("span", { style: "margin-left:auto" }, elChip(res)),
      ]));

      result.appendChild(h("div", { class: "pair-cols" }, [
        pairColumn(ca, res), pairColumn(cb, res),
      ]));
    }
    draw();
  }

  function pairColumn(c, res) {
    var pair = (c.fusion_skills || {})[res.name];
    var art = fusionFormArt(c, res.name);
    var col = h("div", { class: "pair-col" }, [
      h("div", { class: "pair-lead", onclick: function () { go("#/fusion/" + c.id + "/" + res.name); } }, [
        img(art.portrait || art.prof || charPortrait(c), "pair-portrait", res.display_name + " form"),
        h("div", { class: "pair-lead-info" }, [
          h("div", { class: "pair-hero-name" }, c.short_name || c.character_name),
          h("div", { class: "pair-form-name", style: "color:" + elColor(res) }, res.display_name + " form"),
          elChip(res, { sm: true }),
        ]),
      ]),
    ]);
    if (!pair) { col.appendChild(h("div", { class: "empty-note" }, "No " + res.display_name + " fusion kit.")); return col; }
    var skills = [pair.passive, pair.active].map(function (id) { return IDX.skillById[id]; }).filter(Boolean);
    col.appendChild(h("div", { class: "skill-grid", style: "grid-template-columns:1fr" }, skills.map(function (s) { return skillCard(s); })));
    var link = h("div", { class: "backlink", style: "margin-top:10px", onclick: function () { go("#/fusion/" + c.id + "/" + res.name); } }, ["Open full form →"]);
    col.appendChild(link);
    return col;
  }

  // ---------- VIEW: Skills browser ----------
  var skillState = { q: "", element: "", kind: "", cls: "", targeting: "", passive: "" };
  function viewSkills() {
    el.view.appendChild(pageHead("Skills", DB.skills.length + " abilities across all heroes, fusions, variants and minions"));

    function sel(key, label, options) {
      var s = h("select", { onchange: function () { skillState[key] = this.value; draw(); } },
        [h("option", { value: "" }, label)].concat(options.map(function (o) {
          return h("option", { value: o[0] }, o[1]);
        })));
      s.value = skillState[key];
      return s;
    }
    var elOpts = IDX.baseEls.concat(IDX.fusionEls).filter(function (e) {
      return DB.skills.some(function (s) { return s.element && s.element.id === e.id; });
    }).map(function (e) { return [e.name, e.display_name]; });
    var classKeys = Object.keys(DB.skills[0].classes);

    var search = h("input", { type: "search", placeholder: "Search name / description…", value: skillState.q,
      oninput: function () { skillState.q = this.value; draw(); } });
    var countEl = h("span", { class: "count" });
    el.view.appendChild(h("div", { class: "filter-bar" }, [
      search,
      sel("element", "All elements", elOpts),
      sel("kind", "All kinds", [["base", "Base"], ["fusion", "Fusion"], ["variant", "Variant"], ["minion", "Minion"]]),
      sel("cls", "Any class", classKeys.map(function (k) { return [k, k]; })),
      sel("targeting", "Any targeting", [["single", "Single"], ["self", "Self"], ["all", "All"]]),
      sel("passive", "Active + passive", [["active", "Active only"], ["passive", "Passive only"]]),
      countEl,
    ]));
    var list = h("div", { class: "skill-grid" });
    el.view.appendChild(list);

    function draw() {
      var q = skillState.q.trim().toLowerCase();
      var res = DB.skills.filter(function (s) {
        if (skillState.element && !(s.element && s.element.name === skillState.element)) return false;
        if (skillState.kind && (s.classification || {}).kind !== skillState.kind) return false;
        if (skillState.cls && !(s.classes && s.classes[skillState.cls])) return false;
        if (skillState.targeting && !(s.targeting_type && s.targeting_type.name === skillState.targeting)) return false;
        if (skillState.passive === "passive" && !s.is_passive) return false;
        if (skillState.passive === "active" && s.is_passive) return false;
        if (q) {
          var hay = (s.name + " " + (s.description || "") + " " + s.owner + " " + s.id).toLowerCase();
          if (hay.indexOf(q) < 0) return false;
        }
        return true;
      });
      countEl.textContent = res.length + " skills";
      clear(list);
      res.slice(0, 400).forEach(function (s) { list.appendChild(skillCard(s)); });
      if (res.length > 400) list.appendChild(h("div", { class: "empty-note" }, "Showing first 400 of " + res.length + " — refine filters to see more."));
      if (!res.length) list.appendChild(h("div", { class: "empty-note" }, "No skills match."));
    }
    draw();
  }

  // ---------- VIEW: single skill ----------
  function viewSkill(args) {
    var s = IDX.skillById[args[0]];
    if (!s) { el.view.appendChild(h("div", { class: "empty-note" }, "Unknown skill.")); return; }
    var owner = IDX.charById[s.owner];
    var e = resolveEl(s.element);
    var color = elColor(e);

    el.view.appendChild(h("div", { class: "breadcrumb" }, [
      h("a", { href: "#/skills" }, "Skills"), sep(),
      owner ? h("a", { href: "#/char/" + owner.id }, owner.short_name || owner.character_name) : s.owner, sep(), s.name,
    ]));

    el.view.appendChild(h("div", { class: "char-hero" }, [
      h("div", { class: "char-portrait-wrap" }, [
        img(assetExists(s.image) ? s.image : null, "char-portrait", s.name),
        h("div", { class: "el-bar", style: "background:" + elGradient(e) }),
      ]),
      h("div", { class: "char-meta" }, [
        h("h1", null, s.name),
        h("div", { class: "meta-row" }, [elChip(e), owner ? h("span", { class: "chip", style: "cursor:pointer", onclick: function () { go("#/char/" + owner.id); } }, (owner.short_name || owner.character_name)) : null]),
        h("div", { class: "statline" }, [
          stat("Cost", (s.cost && (s.cost.generic + s.cost.specific)) ? ((s.cost.generic ? s.cost.generic + " generic" : "") + (s.cost.generic && s.cost.specific ? " + " : "") + (s.cost.specific ? s.cost.specific + " " + e.display_name : "")) : "Free"),
          stat("Cooldown", String(s.cooldown || 0)),
          stat("Type", s.is_passive ? "Passive" : "Active"),
          stat("Targeting", s.targeting_type ? s.targeting_type.name + (s.targeting_type.defaulted ? " (default)" : "") : "—"),
          stat("Priority", String(s.priority)),
        ]),
        h("div", { class: "skill-desc", style: "font-size:15px;color:var(--text)" }, s.description || "No description."),
        h("div", { class: "pill-row", style: "margin-top:12px" }, classChips(s).concat(
          s.hidden ? [h("span", { class: "meta-pill" }, "hidden")] : [],
          s.hidden_targets ? [h("span", { class: "meta-pill" }, "hidden targets")] : []
        )),
      ]),
    ]));

    // Full class map + provenance
    var classRows = Object.keys(s.classes).map(function (k) {
      return h("tr", null, [h("td", null, k), h("td", null, s.classes[k] ? h("span", { style: "color:var(--help)" }, "✓") : h("span", { style: "color:var(--text-faint)" }, "—"))]);
    });
    el.view.appendChild(h("div", { class: "section" }, [
      h("h2", null, "Details"),
      h("div", { style: "display:grid;grid-template-columns:1fr 1fr;gap:24px;align-items:start" }, [
        h("table", { class: "data-table" }, [h("tbody", null, classRows)]),
        h("table", { class: "data-table" }, [h("tbody", null, [
          row("Skill id", s.id),
          row("Owner", s.owner),
          row("Classification", JSON.stringify(s.classification)),
          row("Minion skill", String(s.is_minion_skill)),
          row("Source file", s.source_file),
          row("Image", s.image),
        ])]),
      ]),
    ]));

    // sibling skills of same owner
    if (owner) {
      var sibs = (IDX.skillsByOwner[owner.id] || []).filter(function (x) { return x.id !== s.id; });
      if (sibs.length) el.view.appendChild(h("div", { class: "section" }, [
        h("h2", null, [owner.short_name || owner.character_name, "'s other skills"]),
        h("div", { class: "skill-grid" }, sibs.map(function (x) { return skillCard(x); })),
      ]));
    }
  }
  function row(k, v) { return h("tr", null, [h("td", { style: "color:var(--text-faint)" }, k), h("td", { style: "font-family:var(--mono);font-size:12px" }, esc(v))]); }

  // ---------- VIEW: Elements ----------
  function viewElements() {
    el.view.appendChild(pageHead("Elements & Fusion", "10 base elements · 55 fusion pairings · click any cell"));

    // interactive recipe matrix
    var section = h("div", { class: "section" }, [h("h2", null, "Fusion recipe matrix"),
      h("div", { class: "sec-sub" }, "base element × base element → fusion element (fusion is symmetric)")]);
    var wrap = h("div", { class: "matrix-wrap" });
    var table = h("table", { class: "matrix" });
    var thead = h("tr", null, [h("th", { class: "corner" }, "×")]);
    IDX.baseEls.forEach(function (e) { thead.appendChild(h("th", null, headEl(e))); });
    table.appendChild(thead);
    IDX.baseEls.forEach(function (ra) {
      var tr = h("tr", null, [h("th", null, headEl(ra))]);
      IDX.baseEls.forEach(function (rb) {
        var res = fusionResultElement(ra.id, rb.id);
        var color = res ? elColor(res) : "transparent";
        var td = h("td", { class: "cell", style: "background:" + color + "26", title: ra.display_name + " × " + rb.display_name + " → " + (res ? res.display_name : "?") }, [
          h("div", { class: "rname", style: "color:" + color }, res ? res.display_name : "—"),
        ]);
        if (res) td.addEventListener("click", function () { go("#/element/" + res.name); });
        tr.appendChild(td);
      });
      table.appendChild(tr);
    });
    wrap.appendChild(table); section.appendChild(wrap);
    el.view.appendChild(section);

    // element cards
    el.view.appendChild(h("div", { class: "section" }, [
      h("h2", null, ["Base elements ", h("span", { class: "badge" }, String(IDX.baseEls.length))]),
      h("div", { class: "el-grid" }, IDX.baseEls.map(elCard)),
    ]));
    el.view.appendChild(h("div", { class: "section" }, [
      h("h2", null, ["Fusion elements ", h("span", { class: "badge" }, String(IDX.fusionEls.length))]),
      h("div", { class: "el-grid" }, IDX.fusionEls.slice().sort(function (a, b) { return a.display_name.localeCompare(b.display_name); }).map(elCard)),
    ]));
  }
  function headEl(e) { return h("span", { class: "head-el" }, [h("span", { class: "dot", style: "background:" + elColor(e) }), e.display_name]); }
  function elCard(e) {
    var comp = "";
    if (e.components && e.components.length) comp = e.components.map(function (c) { return c.a_name + " + " + c.b_name; }).join(", ");
    else if (e.is_base) comp = "base element" + (e.color ? " · " + e.color : "");
    return h("div", { class: "el-card", style: "--el:" + elColor(e), onclick: function () { go("#/element/" + e.name); } }, [
      h("div", { class: "en" }, e.display_name),
      h("div", { class: "es" }, e.is_base ? "Base" : e.is_generic ? "Generic energy" : "Fusion"),
      comp ? h("div", { class: "ec" }, comp) : null,
    ]);
  }

  // ---------- VIEW: single element ----------
  function viewElement(args) {
    var e = IDX.elByName[args[0]];
    if (!e) { el.view.appendChild(h("div", { class: "empty-note" }, "Unknown element.")); return; }
    el.view.appendChild(h("div", { class: "breadcrumb" }, [h("a", { href: "#/elements" }, "Elements"), sep(), e.display_name]));
    var color = elColor(e);

    el.view.appendChild(h("div", { class: "page-head" }, [
      h("h1", null, [h("span", { style: "display:inline-block;width:20px;height:20px;border-radius:50%;vertical-align:middle;margin-right:10px;background:" + (e.is_fusion ? elGradient(e) : color) }), e.display_name]),
      h("div", { class: "sub" }, e.is_base ? ("Base element" + (e.color ? " · " + e.color : "")) : e.is_generic ? "Generic (any) energy used in skill costs" : "Fusion element"),
    ]));

    // components / recipes
    if (e.is_fusion && e.components) {
      el.view.appendChild(h("div", { class: "callout" }, e.components.map(function (c) {
        return h("div", { class: "recipe-note" }, [miniEl(IDX.elById[c.a]), h("span", { class: "arrow" }, "+"), miniEl(IDX.elById[c.b]), h("span", { class: "arrow" }, "→"), miniEl(e)]);
      })));
    }
    if (e.is_base) {
      var recs = IDX.baseEls.map(function (b) { var r = fusionResultElement(e.id, b.id); return r ? h("div", { class: "recipe-note", style: "margin:4px 0" }, [miniEl(e), h("span", { class: "arrow" }, "+"), miniEl(b), h("span", { class: "arrow" }, "→"), h("a", { href: "#/element/" + r.name, style: "color:var(--accent-2)" }, r.display_name)]) : null; }).filter(Boolean);
      el.view.appendChild(h("div", { class: "section" }, [h("h2", null, "Fuses into"), h("div", null, recs)]));
    }

    // characters with this element
    var chars = DB.characters.filter(function (c) { return c.element && c.element.id === e.id; });
    if (chars.length) el.view.appendChild(h("div", { class: "section" }, [
      h("h2", null, ["Heroes ", h("span", { class: "badge" }, String(chars.length))]),
      h("div", { class: "roster-grid" }, chars.map(heroCard)),
    ]));

    // heroes that can take this as a fusion form
    if (e.is_fusion) {
      var fusers = DB.characters.filter(function (c) { return c.fusion_skills && c.fusion_skills[e.name]; });
      if (fusers.length) el.view.appendChild(h("div", { class: "section" }, [
        h("h2", null, ["Reachable as a fusion form by ", h("span", { class: "badge" }, String(fusers.length))]),
        h("div", { class: "skill-grid" }, fusers.map(function (c) {
          var pair = c.fusion_skills[e.name];
          var art = fusionFormArt(c, e.name);
          return h("div", { class: "skill-card click", style: "--el:" + color, onclick: function () { go("#/fusion/" + c.id + "/" + e.name); } }, [
            img(art.portrait || art.prof || charPortrait(c), "pf-thumb", (c.short_name || c.character_name) + " " + e.display_name + " form"),
            h("div", { class: "skill-main" }, [
              h("div", { class: "skill-head" }, [h("span", { class: "skill-name" }, (c.short_name || c.character_name))]),
              h("div", { class: "skill-desc" }, "Passive: " + ((IDX.skillById[pair.passive] || {}).name || "?") + " · Active: " + ((IDX.skillById[pair.active] || {}).name || "?")),
            ]),
          ]);
        })),
      ]));
    }

    // skills of this element
    var skills = DB.skills.filter(function (s) { return s.element && s.element.id === e.id; });
    if (skills.length) el.view.appendChild(h("div", { class: "section" }, [
      h("h2", null, ["Skills ", h("span", { class: "badge" }, String(skills.length))]),
      h("div", { class: "skill-grid" }, skills.slice(0, 60).map(function (s) { return skillCard(s); })),
      skills.length > 60 ? h("div", { class: "empty-note" }, "…and " + (skills.length - 60) + " more") : null,
    ]));
  }

  // ---------- VIEW: Minions ----------
  function viewMinions() {
    el.view.appendChild(pageHead("Minions", IDX.minions.length + " summoned units · HP recovered heuristically from spawn code"));
    var byOwner = {};
    IDX.minions.forEach(function (m) { (byOwner[m.owner] = byOwner[m.owner] || []).push(m); });
    Object.keys(byOwner).sort().forEach(function (ownerId) {
      var owner = IDX.charById[ownerId];
      el.view.appendChild(h("div", { class: "section" }, [
        h("h2", null, [owner ? h("a", { href: "#/char/" + owner.id, style: "color:inherit" }, (owner.short_name || owner.character_name)) : ownerId,
          " ", h("span", { class: "badge" }, String(byOwner[ownerId].length))]),
        minionGrid(byOwner[ownerId]),
      ]));
    });
  }
  function minionGrid(list) {
    return h("div", { class: "minion-grid" }, list.map(function (m) {
      var color = elColor(resolveEl(m.element));
      var hp = m.base_hp != null ? m.base_hp + " HP" : (m.hp_source === "dynamic" ? "Dynamic HP" : "HP unknown");
      return h("div", { class: "minion-card", style: "--el:" + color, onclick: function () { go("#/minion/" + m.id); }, }, [
        img(assetExists(m.image) ? m.image : null, "", m.character_name),
        h("div", { class: "mb" }, [
          h("div", { class: "mn" }, m.character_name || m.path_name),
          h("div", { class: "ms" }, [elChip(m.element, { sm: true, link: false }), " ", hp]),
        ]),
      ]);
    }));
  }
  function viewMinion(args) {
    var m = IDX.minionById[args[0]];
    if (!m) { el.view.appendChild(h("div", { class: "empty-note" }, "Unknown minion.")); return; }
    var owner = IDX.charById[m.owner];
    el.view.appendChild(h("div", { class: "breadcrumb" }, [h("a", { href: "#/minions" }, "Minions"), sep(), m.character_name || m.path_name]));
    el.view.appendChild(h("div", { class: "char-hero" }, [
      h("div", { class: "char-portrait-wrap" }, [img(assetExists(m.image) ? m.image : null, "char-portrait", m.character_name),
        h("div", { class: "el-bar", style: "background:" + elGradient(resolveEl(m.element)) })]),
      h("div", { class: "char-meta" }, [
        h("h1", null, m.character_name || m.path_name),
        h("div", { class: "meta-row" }, [elChip(m.element), owner ? h("span", { class: "chip", style: "cursor:pointer", onclick: function () { go("#/char/" + owner.id); } }, "Summoned by " + (owner.short_name || owner.character_name)) : null]),
        h("div", { class: "statline" }, [
          stat("Base HP", m.base_hp != null ? String(m.base_hp) : (m.hp_source === "dynamic" ? "Dynamic" : "Unknown")),
          stat("HP source", m.hp_source || "—"),
          stat("Owner", m.owner || "—"),
        ]),
        m.base_hp_candidates && m.base_hp_candidates.length > 1 ? h("div", { class: "callout" }, "HP candidates found in spawn code: " + m.base_hp_candidates.join(", ")) : null,
      ]),
    ]));
    var poolSkills = ownerMinionSkills(m.owner);
    if (poolSkills.length) {
      el.view.appendChild(h("div", { class: "section" }, [
        h("h2", null, [owner ? (owner.short_name || owner.character_name) : m.owner, "'s minion abilities ", h("span", { class: "badge" }, String(poolSkills.length))]),
        h("div", { class: "callout" }, "Minion abilities are recorded against the summoner rather than individual minions, so this is the full pool of abilities the summoner's minions draw from."),
        skillGrid(poolSkills),
      ]));
    }
  }

  // ---------- VIEW: About ----------
  function viewAbout() {
    var c = DB._meta.counts;
    el.view.appendChild(pageHead("About this codex", "An offline, data-driven browser for the extracted game database."));
    el.view.appendChild(h("div", { class: "section" }, [
      h("h2", null, "What's inside"),
      h("table", { class: "data-table", style: "max-width:520px" }, [h("tbody", null, [
        row("Characters", c.characters + " (" + c.characters_in_roster + " in roster)"),
        row("Skills", c.skills + " (" + c.skills_character + " hero, " + c.skills_minion + " minion)"),
        row("Augments", c.augments), row("Masteries", c.masteries),
        row("Minions", c.minions + " (" + c.minions_with_hp + " with HP)"),
        row("Elements", c.elements + " (10 base, 55 fusion, 1 generic)"),
        row("Fusion recipes", c.fusion_recipes),
      ])]),
    ]));
    el.view.appendChild(h("div", { class: "section" }, [
      h("h2", null, "How fusion works"),
      h("div", { class: "callout" }, [
        "Each round, a hero may pick an ", h("b", null, "Augment"), " (a passive upgrade to their kit) or ",
        h("b", null, "fuse"), " their element with a teammate's. The fusion element is looked up from the ",
        h("b", null, "base × base"), " recipe table, and each partner gains a fusion passive + active for that element ",
        "plus new display art. Explore any pairing in the ", h("a", { href: "#/fusions", style: "color:var(--accent-2)" }, "Fusion Lab"), ".",
      ]),
    ]));
    var notes = (DB._meta.notes || []).concat(["Damage/heal values are only in each skill's description text (they live in GDScript, not as data fields)."]);
    el.view.appendChild(h("div", { class: "section" }, [
      h("h2", null, "Data provenance"),
      h("ul", { style: "color:var(--text-dim);font-size:13px;line-height:1.8" }, notes.map(function (n) { return h("li", null, n); })),
    ]));
    if ((DB._meta.info || []).length) el.view.appendChild(h("div", { class: "section" }, [
      h("h2", null, ["Extractor notes ", h("span", { class: "badge" }, String(DB._meta.info.length))]),
      h("ul", { style: "color:var(--text-faint);font-size:12px;line-height:1.7" }, DB._meta.info.map(function (n) { return h("li", null, typeof n === "string" ? n : JSON.stringify(n)); })),
    ]));
    el.view.appendChild(h("div", { class: "section" }, [
      h("h2", null, "Refreshing the data"),
      h("div", { class: "callout" }, ["Re-run the export, then ", h("code", { style: "color:var(--accent)" }, "python build_data.py"), " to rebuild ", h("code", null, "app/db.js"), ". This page reads that bundle (or ", h("code", null, "output/database.json"), " when served over HTTP)."]),
    ]));
  }

  // ---------- GLOBAL SEARCH ----------
  var searchIndex = [];
  function buildSearchIndex() {
    DB.characters.forEach(function (c) { searchIndex.push({ type: "Hero", name: c.character_name, sub: c.element.display_name, hash: "#/char/" + c.id, img: charPortrait(c), rect: true, key: (c.character_name + " " + c.id + " " + (c.short_name || "")).toLowerCase() }); });
    DB.skills.forEach(function (s) { searchIndex.push({ type: "Skill", name: s.name, sub: (IDX.charById[s.owner] ? (IDX.charById[s.owner].short_name || s.owner) : s.owner) + " · " + (s.element ? s.element.display_name : ""), hash: "#/skill/" + encodeURIComponent(s.id), img: assetExists(s.image) ? s.image : null, key: (s.name + " " + s.id + " " + (s.description || "")).toLowerCase() }); });
    DB.augments.forEach(function (a) { searchIndex.push({ type: "Augment", name: a.display_name || a.augment_name, sub: (IDX.charById[a.owner] ? (IDX.charById[a.owner].short_name || a.owner) : a.owner), hash: "#/char/" + a.owner, img: null, key: ((a.display_name || "") + " " + a.id + " " + (a.description || "")).toLowerCase() }); });
    DB.elements.forEach(function (e) { if (!e.is_generic) searchIndex.push({ type: "Element", name: e.display_name, sub: e.is_base ? "Base" : "Fusion", hash: "#/element/" + e.name, img: null, key: (e.display_name + " " + e.name).toLowerCase() }); });
    IDX.minions.forEach(function (m) { searchIndex.push({ type: "Minion", name: m.character_name || m.path_name, sub: (IDX.charById[m.owner] ? (IDX.charById[m.owner].short_name || m.owner) : m.owner), hash: "#/minion/" + m.id, img: assetExists(m.image) ? m.image : null, key: ((m.character_name || "") + " " + m.path_name).toLowerCase() }); });
  }
  var searchSel = -1, searchHits = [];
  function runSearch() {
    var q = el.search.value.trim().toLowerCase();
    if (!q) { el.searchResults.hidden = true; return; }
    var terms = q.split(/\s+/);
    searchHits = searchIndex.filter(function (it) { return terms.every(function (t) { return it.key.indexOf(t) >= 0; }); });
    // rank: name startsWith first
    searchHits.sort(function (a, b) {
      var as = a.name.toLowerCase().indexOf(q) === 0 ? 0 : 1, bs = b.name.toLowerCase().indexOf(q) === 0 ? 0 : 1;
      return as - bs;
    });
    searchHits = searchHits.slice(0, 30);
    searchSel = -1;
    renderSearch();
  }
  function renderSearch() {
    clear(el.searchResults);
    if (!searchHits.length) { el.searchResults.appendChild(h("div", { class: "search-empty" }, "No matches.")); el.searchResults.hidden = false; return; }
    var groups = {};
    searchHits.forEach(function (it) { (groups[it.type] = groups[it.type] || []).push(it); });
    var order = ["Hero", "Fusion", "Skill", "Augment", "Element", "Minion"];
    var flat = [];
    Object.keys(groups).sort(function (a, b) { return order.indexOf(a) - order.indexOf(b); }).forEach(function (g) {
      el.searchResults.appendChild(h("div", { class: "sr-group" }, g + "s"));
      groups[g].forEach(function (it) {
        var idx = flat.length; flat.push(it);
        var item = h("div", { class: "sr-item", onclick: function () { pickSearch(it); } }, [
          it.img ? img(it.img, it.rect ? "sr-thumb-rect" : "") : h("div", { style: "width:30px;height:30px;border-radius:6px;background:var(--panel-3);flex:none" }),
          h("div", { style: "min-width:0" }, [h("div", { class: "sr-name" }, it.name), h("div", { class: "sr-sub" }, it.sub)]),
        ]);
        item.dataset.idx = idx;
        el.searchResults.appendChild(item);
      });
    });
    searchHits = flat;
    el.searchResults.hidden = false;
  }
  function pickSearch(it) { el.searchResults.hidden = true; el.search.value = ""; go(it.hash); }
  function moveSel(d) {
    var items = el.searchResults.querySelectorAll(".sr-item");
    if (!items.length) return;
    searchSel = (searchSel + d + items.length) % items.length;
    items.forEach(function (n, i) { n.classList.toggle("sel", i === searchSel); if (i === searchSel) n.scrollIntoView({ block: "nearest" }); });
  }

  el.search.addEventListener("input", runSearch);
  el.search.addEventListener("keydown", function (e) {
    if (e.key === "ArrowDown") { e.preventDefault(); moveSel(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); moveSel(-1); }
    else if (e.key === "Enter") { var items = el.searchResults.querySelectorAll(".sr-item"); if (searchSel >= 0 && items[searchSel]) items[searchSel].click(); else if (searchHits[0]) pickSearch(searchHits[0]); }
    else if (e.key === "Escape") { el.searchResults.hidden = true; el.search.blur(); }
  });
  document.addEventListener("click", function (e) { if (!e.target.closest(".appbar-search")) el.searchResults.hidden = true; });
  document.addEventListener("keydown", function (e) {
    if (e.key === "/" && document.activeElement !== el.search && !/input|textarea|select/i.test((document.activeElement || {}).tagName || "")) {
      e.preventDefault(); el.search.focus();
    }
  });

  // ---------- BOOT ----------
  function boot(db, assets) {
    DB = db; ASSETS = assets ? new Set(assets) : null;
    buildIndices();
    buildSearchIndex();
    el.footStats.textContent = DB._meta.counts.characters + " heroes · " + DB._meta.counts.skills + " skills · " +
      DB._meta.counts.augments + " augments · " + DB._meta.counts.elements + " elements";
    window.addEventListener("hashchange", render);
    render();
  }

  function start() {
    if (window.GAME_DB) { boot(window.GAME_DB, window.ASSETS_INDEX); return; }
    // Fallback: fetch when served over HTTP (file:// will throw → show guidance)
    fetch("output/database.json").then(function (r) { return r.json(); }).then(function (db) { boot(db, null); })
      .catch(function () {
        el.view.innerHTML = '<div class="empty-note" style="margin:40px">Could not load the database.<br><br>' +
          'Run <code>python build_data.py</code> to generate <code>app/db.js</code>, then reload — ' +
          'or serve this folder with <code>python -m http.server</code> and open it via http://localhost:8000/.</div>';
      });
  }
  start();
})();
