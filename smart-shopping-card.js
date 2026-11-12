/* Smart Shopping Card – Lovelace-Karte ohne externe Abhängigkeiten.
 * Nutzt die Local-To-do-Listen (todo.lidl / .netto / .penny / .kaufland / .rewe) als
 * dauerhaften Speicher. Zusatzdaten (Menge, Einheit, Preis, Notiz, Quelle)
 * stehen im Beschreibungsfeld des To-do-Eintrags als "schlüssel: wert"-Zeilen.
 */
const SS_VERSION = "7";
console.info("%c SMART-SHOPPING-CARD v" + SS_VERSION, "color:#fff;background:#03a9f4");
const SS_DEFAULT_STORES = {
  lidl: { name: "Lidl", entity: "todo.lidl", color: "#0050aa", accent: "#ffd800", text: "#ffffff", icon: "mdi:storefront" },
  netto: { name: "Netto", entity: "todo.netto", color: "#ffd800", accent: "#e2001a", text: "#c8102e", icon: "mdi:storefront" },
  penny: { name: "Penny", entity: "todo.penny", color: "#cd1719", accent: "#ffffff", text: "#ffffff", icon: "mdi:storefront" },
  kaufland: { name: "Kaufland", entity: "todo.kaufland", color: "#e10915", accent: "#0b4ea2", text: "#ffffff", icon: "mdi:storefront" },
  rewe: { name: "REWE", entity: "todo.rewe", color: "#cc071e", accent: "#ffffff", text: "#ffffff", icon: "mdi:cart" },
};

const ssEsc = (v) =>
  String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ssNorm = (s) => String(s || "").trim().toLowerCase();
const ssEur = (n) => (n == null ? "" : Number(n).toLocaleString("de-DE", { style: "currency", currency: "EUR" }));
const ssDate = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
  return m ? `${m[3]}.${m[2]}.` : "";
};
const ssKey = (n) => String(n || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "");
const ssToday = () => new Date().toISOString().slice(0, 10);

function ssParse(desc) {
  const meta = { qty: 1, unit: "", price: null, note: "", source: "manual", valid_until: "" };
  String(desc || "").split("\n").forEach((line) => {
    const m = /^(\w+):\s*(.*)$/.exec(line.trim());
    if (!m) return;
    if (m[1] === "qty") meta.qty = Math.max(1, parseFloat(m[2].replace(",", ".")) || 1);
    else if (m[1] === "price") meta.price = parseFloat(m[2].replace(",", ".")) || null;
    else if (m[1] in meta) meta[m[1]] = m[2];
  });
  return meta;
}

function ssSerialize(meta) {
  const lines = [`qty: ${meta.qty || 1}`];
  if (meta.unit) lines.push(`unit: ${String(meta.unit).replace(/\n/g, " ")}`);
  if (meta.price) lines.push(`price: ${meta.price}`);
  if (meta.source) lines.push(`source: ${meta.source}`);
  if (meta.valid_until) lines.push(`valid_until: ${meta.valid_until}`);
  if (meta.note) lines.push(`note: ${String(meta.note).replace(/\n/g, " ")}`);
  return lines.join("\n");
}

class SmartShoppingCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._tab = "overview";
    this._items = {};
    this._offers = [];
    this._offersMeta = {};
    this._offerFilter = "all";
    this._offerSearch = "";
    this._globalSearch = "";
    this._editing = null;
    this._target = {};
    this._seen = {};
    this._toastText = "";
    this._focus = null;
    this._loaded = false;
  }

  setConfig(config) {
    this._config = {
      offers_url: "/local/smart_shopping/offers.json",
      offers_entity: "sensor.smart_shopping_angebote",
      special_discount: 25,
      ...config,
    };
    this._stores = {};
    Object.keys(SS_DEFAULT_STORES).forEach((k) => {
      this._stores[k] = { ...SS_DEFAULT_STORES[k], ...((config.stores || {})[k] || {}) };
    });
    this._render();
  }

  getCardSize() { return 8; }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) {
      this._loadOffers();
    }
    Object.keys(this._stores).forEach((k) => {
      const st = hass.states[this._stores[k].entity];
      const stamp = st ? `${st.state}|${st.last_updated}` : "missing";
      if (this._seen[k] !== stamp) {
        this._seen[k] = stamp;
        this._loadItems(k);
      }
    });
    const oe = hass.states[this._config.offers_entity];
    const ostamp = oe ? `${oe.state}|${oe.last_updated}` : "";
    if (!first && this._seenOffers !== ostamp) this._loadOffers();
    this._seenOffers = ostamp;
    if (first) this._render();
  }

  // ------------------------------------------------------------- Daten
  async _loadItems(key) {
    try {
      const res = await this._hass.callWS({ type: "todo/item/list", entity_id: this._stores[key].entity });
      this._items[key] = (res.items || []).map((i) => ({
        uid: i.uid, name: i.summary, done: i.status === "completed", meta: ssParse(i.description),
      }));
    } catch (e) {
      this._items[key] = this._items[key] || null; // Entität fehlt -> Platzhalter
      this._errors = { ...(this._errors || {}), [key]: true };
    }
    this._render();
  }

  async _loadOffers() {
    try {
      const r = await fetch(`${this._config.offers_url}?t=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) throw new Error(r.status);
      const data = await r.json();
      this._offers = Array.isArray(data.offers) ? data.offers : [];
      this._offersMeta = { updated: data.updated, sources: data.sources || {} };
      this._offersError = false;
    } catch (e) {
      this._offers = [];
      this._offersError = true;
    }
    this._render();
  }

  _storeKeyByName(name) {
    return Object.keys(this._stores).find((k) => ssNorm(this._stores[k].name) === ssNorm(name)) || null;
  }

  _openCount(key) {
    const st = this._hass && this._hass.states[this._stores[key].entity];
    if (st && !isNaN(parseInt(st.state, 10))) return parseInt(st.state, 10);
    return (this._items[key] || []).filter((i) => !i.done).length;
  }

  /** Gleiches Produkt (normalisierter Name) bei anderen Märkten, nur aktuell gültige Angebote. */
  _siblings(o) {
    const key = ssKey(o.name);
    const seen = new Set();
    return this._validOffers().filter((x) => {
      if (ssKey(x.name) !== key || !this._isCurrent(x)) return false;
      const sk = this._storeKeyByName(x.store);
      if (!sk || seen.has(sk)) return false;
      seen.add(sk);
      return true;
    });
  }

  /** Angebot gilt heute (Start erreicht, Ende nicht überschritten). */
  _isCurrent(o) {
    const t = ssToday();
    return (!o.valid_from || o.valid_from <= t) && (!o.valid_until || o.valid_until >= t);
  }

  _validOffers() {
    const today = ssToday();
    return this._offers.filter((o) => !o.valid_until || o.valid_until >= today);
  }

  // ----------------------------------------------------------- Aktionen
  _call(service, data) {
    return this._hass.callService("todo", service, data);
  }

  _toast(text) {
    this._toastText = text;
    this._render();
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { this._toastText = ""; this._render(); }, 2600);
  }

  /** Fügt hinzu, vermeidet Duplikate (offene Einträge -> Hinweis, erledigte -> wieder öffnen). */
  async _addItem(key, item, { done = false } = {}) {
    const entity = this._stores[key].entity;
    await this._loadItems(key);
    const list = this._items[key] || [];
    const dup = list.find((i) => ssNorm(i.name) === ssNorm(item.name));
    let uid;
    let result = "added";
    if (dup && !dup.done) {
      uid = dup.uid;
      result = "duplicate";
    } else if (dup && dup.done) {
      uid = dup.uid;
      await this._call("update_item", { entity_id: entity, item: dup.uid, status: "needs_action", description: ssSerialize({ ...dup.meta, ...item.meta }) });
      result = "reopened";
    } else {
      await this._call("add_item", { entity_id: entity, item: item.name, description: ssSerialize(item.meta) });
    }
    if (done) {
      if (!uid) {
        await this._loadItems(key);
        const created = (this._items[key] || []).find((i) => ssNorm(i.name) === ssNorm(item.name));
        uid = created && created.uid;
      }
      if (uid) await this._call("update_item", { entity_id: entity, item: uid, status: "completed" });
    }
    await this._loadItems(key);
    return result;
  }

  async _addFromOffer(offer, targetKey, done) {
    const src = this._siblings(offer).find((x) => this._storeKeyByName(x.store) === targetKey) || offer;
    const res = await this._addItem(targetKey, {
      name: src.name,
      meta: { qty: 1, unit: src.unit || "", price: src.price, note: "", source: "offer", valid_until: src.valid_until || "" },
    }, { done });
    const store = this._stores[targetKey].name;
    const msg = { added: `Zu ${store} hinzugefügt`, duplicate: `Steht schon auf der ${store}-Liste`, reopened: `Auf ${store}-Liste wieder geöffnet` }[res];
    this._toast(done ? `Bei ${store} abgehakt` : msg);
  }

  async _toggle(key, uid) {
    const it = (this._items[key] || []).find((i) => i.uid === uid);
    if (!it) return;
    it.done = !it.done; // sofortiges Feedback
    this._render();
    await this._call("update_item", { entity_id: this._stores[key].entity, item: uid, status: it.done ? "completed" : "needs_action" });
  }

  async _saveEdit(key, uid, form) {
    const it = (this._items[key] || []).find((i) => i.uid === uid);
    if (!it) return;
    const name = form.name.trim();
    if (!name) return;
    const meta = {
      ...it.meta,
      qty: Math.max(1, parseFloat(String(form.qty).replace(",", ".")) || 1),
      unit: form.unit.trim(),
      price: parseFloat(String(form.price).replace(",", ".")) || null,
      note: form.note.trim(),
    };
    const targetKey = form.store;
    if (targetKey && targetKey !== key) {
      const res = await this._addItem(targetKey, { name, meta });
      if (res === "duplicate") { this._toast(`Steht schon bei ${this._stores[targetKey].name}`); return; }
      await this._call("remove_item", { entity_id: this._stores[key].entity, item: [uid] });
      await this._loadItems(key);
      this._editing = null;
      this._toast(`Nach ${this._stores[targetKey].name} verschoben`);
      return;
    }
    await this._call("update_item", { entity_id: this._stores[key].entity, item: uid, rename: name, description: ssSerialize(meta) });
    this._editing = null;
    await this._loadItems(key);
  }

  async _remove(key, uid) {
    await this._call("remove_item", { entity_id: this._stores[key].entity, item: [uid] });
    this._editing = null;
    await this._loadItems(key);
  }

  async _clearAll(key) {
    const list = this._items[key] || [];
    if (!list.length) return;
    if (!window.confirm(`Wirklich alle ${list.length} Einträge der ${this._stores[key].name}-Liste löschen?`)) return;
    await this._call("remove_item", { entity_id: this._stores[key].entity, item: list.map((i) => i.uid) });
    await this._loadItems(key);
  }

  async _clearDone(key) {
    await this._call("remove_completed_items", { entity_id: this._stores[key].entity });
    await this._loadItems(key);
  }

  async _refreshOffers() {
    this._toast("Angebote werden aktualisiert …");
    try { await this._hass.callService("smart_shopping", "angebote_aktualisieren"); } catch (e) { /* ignorieren */ }
    setTimeout(() => this._loadOffers(), 4000);
  }

  // ------------------------------------------------------------ Render
  _render() {
    if (!this._config) return;
    const root = this.shadowRoot;
    const active = root.activeElement;
    if (active && active.dataset && active.dataset.keep) {
      this._focus = { id: active.dataset.keep, start: active.selectionStart, end: active.selectionEnd };
    }
    let body = "";
    if (this._tab === "overview") body = this._renderOverview();
    else if (this._tab === "offers") body = this._renderOffers();
    else body = this._renderList(this._tab);

    root.innerHTML = `<style>${this._css()}</style>
      <ha-card>
        <div class="tabs">${this._tabBtn("overview", "Übersicht", "mdi:view-dashboard")}
          ${Object.keys(this._stores).map((k) => this._tabBtn(k, this._stores[k].name, null, k)).join("")}
          ${this._tabBtn("offers", "Angebote", "mdi:tag-multiple")}</div>
        <div class="body">${body}</div>
        <div class="ver">Smart Shopping Karte v${SS_VERSION}</div>
        ${this._toastText ? `<div class="toast">${ssEsc(this._toastText)}</div>` : ""}
      </ha-card>`;
    this._bind();
    if (this._focus) {
      const el = root.querySelector(`[data-keep="${this._focus.id}"]`);
      if (el) { el.focus(); try { el.setSelectionRange(this._focus.start, this._focus.end); } catch (e) { /* number inputs */ } }
    }
  }

  _tabBtn(id, label, icon, storeKey) {
    const on = this._tab === id ? " on" : "";
    let badge = "";
    let lead = icon ? `<ha-icon icon="${icon}"></ha-icon>` : "";
    if (storeKey) {
      const s = this._stores[storeKey];
      lead = `<span class="dot" style="background:${s.color};color:${s.text}">${ssEsc(s.name[0])}</span>`;
      const c = this._openCount(storeKey);
      if (c) badge = `<span class="cnt">${c}</span>`;
    }
    return `<button class="tab${on}" data-tab="${id}">${lead}<span>${ssEsc(label)}</span>${badge}</button>`;
  }

  _logo(key, size) {
    const s = this._stores[key];
    if (s.logo) return `<img class="logo" style="width:${size}px;height:${size}px" src="${ssEsc(s.logo)}" alt="${ssEsc(s.name)}">`;
    return `<span class="logo badge" style="width:${size}px;height:${size}px;background:${s.color};color:${s.text};box-shadow:inset 0 -4px 0 ${s.accent}">${ssEsc(s.name[0])}</span>`;
  }

  _renderOverview() {
    const keys = Object.keys(this._stores);
    const total = keys.reduce((a, k) => a + this._openCount(k), 0);
    const offerCount = this._validOffers().length;
    const tiles = keys.map((k) => `<button class="tile" data-tab="${k}" style="border-color:${this._stores[k].color}">
        ${this._logo(k, 40)}<b>${this._openCount(k)}</b><small>offen bei ${ssEsc(this._stores[k].name)}</small></button>`).join("");
    return `<div class="tiles">${tiles}
        <button class="tile" data-tab="offers"><ha-icon icon="mdi:tag-multiple"></ha-icon><b>${offerCount}</b><small>Angebote</small></button>
        <div class="tile total"><ha-icon icon="mdi:cart-variant"></ha-icon><b>${total}</b><small>offen gesamt</small></div></div>
      <input class="search" data-keep="gsearch" type="search" placeholder="Alles durchsuchen (Listen &amp; Angebote)" value="${ssEsc(this._globalSearch)}">
      <div id="res">${this._renderGlobalResults()}</div>`;
  }

  _renderGlobalResults() {
    const keys = Object.keys(this._stores);
    const q = ssNorm(this._globalSearch);
    let results = "";
    if (q) {
      const rows = [];
      keys.forEach((k) => (this._items[k] || []).filter((i) => ssNorm(i.name).includes(q)).forEach((i) =>
        rows.push(`<button class="row-link" data-tab="${k}">${this._logo(k, 28)}<span class="grow ${i.done ? "done" : ""}">${ssEsc(i.name)}</span><small>Liste</small></button>`)));
      this._validOffers().filter((o) => ssNorm(o.name).includes(q)).slice(0, 20).forEach((o) => {
        const k = this._storeKeyByName(o.store);
        rows.push(`<div class="row-link">${k ? this._logo(k, 28) : ""}<span class="grow">${ssEsc(o.name)}</span><small>${ssEur(o.price)}</small>
          ${k ? `<button class="mini primary" data-quick="${ssEsc(o.id)}">+</button>` : ""}</div>`);
      });
      results = `<div class="results">${rows.join("") || '<p class="muted">Nichts gefunden.</p>'}</div>`;
    }
    return results;
  }

  _renderList(key) {
    const s = this._stores[key];
    const items = this._items[key];
    if (items === null || items === undefined) {
      return `<p class="muted">${this._errors && this._errors[key] ? `Liste <code>${ssEsc(s.entity)}</code> nicht gefunden. Bitte die „Local To-do“-Liste „${ssEsc(s.name)}“ anlegen.` : "Lade …"}</p>`;
    }
    const open = items.filter((i) => !i.done);
    const done = items.filter((i) => i.done);
    const row = (i) => this._editing === `${key}:${i.uid}` ? this._renderEditor(key, i) : `
      <div class="item ${i.done ? "done" : ""}">
        <button class="check" data-toggle="${ssEsc(i.uid)}" aria-label="abhaken"><ha-icon icon="${i.done ? "mdi:checkbox-marked" : "mdi:checkbox-blank-outline"}"></ha-icon></button>
        <button class="itext" data-edit="${ssEsc(i.uid)}">
          <span class="iname">${i.meta.qty > 1 || i.meta.unit ? `<b>${ssEsc(i.meta.qty)}${i.meta.unit ? " " + ssEsc(i.meta.unit) : "×"}</b> ` : ""}${ssEsc(i.name)}</span>
          <span class="imeta">${[i.meta.price ? ssEur(i.meta.price) : "", i.meta.source === "offer" ? "Angebot" + (i.meta.valid_until ? " bis " + ssDate(i.meta.valid_until) : "") : "", i.meta.note].filter(Boolean).map(ssEsc).join(" · ")}</span>
        </button></div>`;
    return `<div class="head">${this._logo(key, 44)}<div class="grow"><h2>${ssEsc(s.name)}</h2><small>${open.length} offen · ${done.length} erledigt</small></div></div>
      <form class="add" data-add="${key}">
        <input data-keep="add-name" name="name" placeholder="Produkt hinzufügen …" autocomplete="off" required>
        <input data-keep="add-qty" name="qty" type="number" min="1" step="1" value="1" inputmode="numeric" aria-label="Menge">
        <button class="primary big" type="submit"><ha-icon icon="mdi:plus"></ha-icon></button></form>
      <div class="list">${open.map(row).join("") || '<p class="muted">Keine offenen Artikel 🎉</p>'}</div>
      ${done.length ? `<div class="sep">Erledigt</div><div class="list">${done.map(row).join("")}</div>` : ""}
      <div class="actions">
        <button class="ghost" data-cleardone="${key}" ${done.length ? "" : "disabled"}><ha-icon icon="mdi:broom"></ha-icon> Erledigte entfernen</button>
        <button class="ghost danger" data-clearall="${key}" ${items.length ? "" : "disabled"}><ha-icon icon="mdi:delete-sweep"></ha-icon> Liste leeren</button></div>`;
  }

  _renderEditor(key, i) {
    const opts = Object.keys(this._stores).map((k) => `<option value="${k}" ${k === key ? "selected" : ""}>${ssEsc(this._stores[k].name)}</option>`).join("");
    return `<form class="editor" data-save="${ssEsc(i.uid)}">
      <label>Name<input name="name" value="${ssEsc(i.name)}" required></label>
      <div class="two"><label>Menge<input name="qty" type="number" min="1" step="1" value="${ssEsc(i.meta.qty)}"></label>
        <label>Einheit<input name="unit" value="${ssEsc(i.meta.unit)}" placeholder="z. B. Packungen"></label></div>
      <div class="two"><label>Preis (€)<input name="price" inputmode="decimal" value="${i.meta.price ? ssEsc(i.meta.price) : ""}"></label>
        <label>Markt<select name="store">${opts}</select></label></div>
      <label>Notiz<input name="note" value="${ssEsc(i.meta.note)}" placeholder="optional"></label>
      <div class="actions"><button class="primary big" type="submit">Speichern</button>
        <button class="ghost" type="button" data-cancel="1">Abbrechen</button>
        <button class="ghost danger" type="button" data-remove="${ssEsc(i.uid)}"><ha-icon icon="mdi:delete"></ha-icon></button></div></form>`;
  }

  _renderOffers() {
    const filters = [["all", "Alle"], ...Object.keys(this._stores).map((k) => [k, this._stores[k].name])];
    const errs = Object.entries(this._offersMeta.sources || {}).filter(([, v]) => !v.ok);
    return `<div class="chips">${filters.map(([id, label]) => `<button class="chip ${this._offerFilter === id ? "on" : ""}" data-filter="${id}">${ssEsc(label)}</button>`).join("")}
        <button class="chip" data-refresh="1" title="Aktualisieren"><ha-icon icon="mdi:refresh"></ha-icon></button></div>
      <input class="search" data-keep="osearch" type="search" placeholder="Angebote suchen" value="${ssEsc(this._offerSearch)}">
      ${this._offersError ? '<p class="muted">Angebotsdaten nicht verfügbar. Bitte „Angebote aktualisieren“ ausführen oder manuell erfassen.</p>' : ""}
      ${errs.length ? `<p class="warn">${errs.length} Quelle(n) derzeit nicht erreichbar – zuletzt bekannte Angebote werden gezeigt.</p>` : ""}
      <div id="grid" class="grid">${this._renderOfferGrid()}</div>
      ${this._offersMeta.updated ? `<small class="muted">Stand: ${ssEsc(new Date(this._offersMeta.updated).toLocaleString("de-DE"))}</small>` : ""}`;
  }

  _renderOfferGrid() {
    const q = ssNorm(this._offerSearch);
    const list = this._validOffers().filter((o) => {
      if (this._offerFilter !== "all" && this._storeKeyByName(o.store) !== this._offerFilter) return false;
      return !q || ssNorm(o.name).includes(q);
    });
    const cards = list.map((o) => this._offerCard(o)).join("");
    return cards || '<p class="muted">Keine Angebote gefunden.</p>';
  }

  _offerCard(o) {
    const defKey = this._storeKeyByName(o.store) || Object.keys(this._stores)[0];
    const stores = this._siblings(o).map((x) => this._storeKeyByName(x.store));
    if (!stores.includes(defKey)) stores.unshift(defKey);
    const target = stores.includes(this._target[o.id]) ? this._target[o.id] : defKey;
    const src = target === defKey ? o : (this._siblings(o).find((x) => this._storeKeyByName(x.store) === target) || o);
    const ts = this._stores[target];
    const upcoming = !this._isCurrent(src);
    const onList = (this._items[target] || []).some((i) => !i.done && ssNorm(i.name) === ssNorm(src.name));
    const special = src.special || (src.discount_percent && src.discount_percent >= this._config.special_discount);
    const img = src.image
      ? `<img src="${ssEsc(src.image)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'ph',textContent:'🛒'}))">`
      : '<div class="ph">🛒</div>';
    const opts = stores.map((k) => `<option value="${k}" ${k === target ? "selected" : ""}>${ssEsc(this._stores[k].name)}</option>`).join("");
    const chooser = stores.length > 1
      ? `<div class="oact"><select data-target="${ssEsc(o.id)}" aria-label="Markt">${opts}</select></div>`
      : `<div class="only">Nur bei ${ssEsc(this._stores[defKey].name)} im Angebot</div>`;
    return `<div class="offer">
      <div class="oimg">${img}<span class="obadge" style="background:${ts.color};color:${ts.text}">${ssEsc(src.store)}</span>
        ${upcoming ? `<span class="osale soon">Ab ${ssEsc(ssDate(src.valid_from))}</span>` : ""}
        ${special ? '<span class="osale">Sonderangebot</span>' : ""}
        ${src.discount_percent ? `<span class="odisc">−${ssEsc(src.discount_percent)}%</span>` : ""}</div>
      <div class="obody"><div class="oname">${ssEsc(src.name)}</div>
        <div class="oprice"><b>${src.price != null ? ssEur(src.price) : "Preis n. v."}</b>${src.original_price ? `<s>${ssEur(src.original_price)}</s>` : ""}</div>
        <small class="muted">${src.valid_until ? `${src.valid_from ? ssDate(src.valid_from) + " – " : "bis "}${ssDate(src.valid_until)}` : "Zeitraum unbekannt"}</small>
        ${chooser}
        <div class="oact"><button class="primary big grow" data-add-offer="${ssEsc(o.id)}">${onList ? "Schon auf Liste" : "Zur Einkaufsliste"}</button>
          <button class="ghost big" data-done-offer="${ssEsc(o.id)}" title="Direkt abhaken"><ha-icon icon="mdi:check-bold"></ha-icon></button></div></div></div>`;
  }

  // ----------------------------------------------------------- Events
  _bind(scope) {
    const full = !scope;
    scope = scope || this.shadowRoot;
    const $ = (sel) => scope.querySelectorAll(sel);
    // Tastendrücke in Eingabefeldern dürfen nicht bis zu den globalen
    // Home-Assistant-Kurzbefehlen (a = Assist, e = Entitäten, c = Befehle) gelangen.
    if (!this._keysBound) {
      this._keysBound = true;
      ["keydown", "keyup", "keypress"].forEach((t) =>
        this.shadowRoot.addEventListener(t, (ev) => {
          const tag = (ev.composedPath()[0] || {}).tagName;
          if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") ev.stopPropagation();
        }));
    }
    const offerById = (id) => this._offers.find((o) => String(o.id) === String(id));
    const tgt = (o) => {
      const def = this._storeKeyByName(o.store) || Object.keys(this._stores)[0];
      const allowed = this._siblings(o).map((x) => this._storeKeyByName(x.store));
      return allowed.includes(this._target[o.id]) ? this._target[o.id] : def;
    };

    $("[data-tab]").forEach((b) => b.addEventListener("click", () => { this._tab = b.dataset.tab; this._editing = null; this._focus = null; this._render(); }));
    $("[data-filter]").forEach((b) => b.addEventListener("click", () => { this._offerFilter = b.dataset.filter; this._render(); }));
    $("[data-refresh]").forEach((b) => b.addEventListener("click", () => this._refreshOffers()));
    $("[data-toggle]").forEach((b) => b.addEventListener("click", () => this._toggle(this._tab, b.dataset.toggle)));
    $("[data-edit]").forEach((b) => b.addEventListener("click", () => { this._editing = `${this._tab}:${b.dataset.edit}`; this._render(); }));
    $("[data-cancel]").forEach((b) => b.addEventListener("click", () => { this._editing = null; this._render(); }));
    $("[data-remove]").forEach((b) => b.addEventListener("click", () => this._remove(this._tab, b.dataset.remove)));
    $("[data-cleardone]").forEach((b) => b.addEventListener("click", () => this._clearDone(b.dataset.cleardone)));
    $("[data-clearall]").forEach((b) => b.addEventListener("click", () => this._clearAll(b.dataset.clearall)));

    $("form[data-add]").forEach((f) => f.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const name = f.elements.name.value.trim();
      if (!name) return;
      const qty = Math.max(1, parseInt(f.elements.qty.value, 10) || 1);
      const res = await this._addItem(f.dataset.add, { name, meta: { qty, unit: "", price: null, note: "", source: "manual", valid_until: "" } });
      if (res === "duplicate") this._toast("Steht schon auf der Liste");
      this._focus = { id: "add-name", start: 0, end: 0 };
      this._render();
    }));
    $("form[data-save]").forEach((f) => f.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const v = (n) => f.elements[n].value;
      this._saveEdit(this._tab, f.dataset.save, { name: v("name"), qty: v("qty"), unit: v("unit"), price: v("price"), note: v("note"), store: v("store") });
    }));

    $("[data-target]").forEach((s) => s.addEventListener("change", () => { this._target[s.dataset.target] = s.value; this._render(); }));
    $("[data-add-offer]").forEach((b) => b.addEventListener("click", () => { const o = offerById(b.dataset.addOffer); if (o) this._addFromOffer(o, tgt(o), false); }));
    $("[data-done-offer]").forEach((b) => b.addEventListener("click", () => { const o = offerById(b.dataset.doneOffer); if (o) this._addFromOffer(o, tgt(o), true); }));
    $("[data-quick]").forEach((b) => b.addEventListener("click", () => { const o = offerById(b.dataset.quick); if (o) this._addFromOffer(o, tgt(o), false); }));

    if (!full) return;
    const gs = this.shadowRoot.querySelector('[data-keep="gsearch"]');
    if (gs) gs.addEventListener("input", () => this._partial("#res", "_renderGlobalResults", () => { this._globalSearch = gs.value; }));
    const os = this.shadowRoot.querySelector('[data-keep="osearch"]');
    if (os) os.addEventListener("input", () => this._partial("#grid", "_renderOfferGrid", () => { this._offerSearch = os.value; }));
  }

  /** Nur den Ergebnisbereich neu zeichnen, das Eingabefeld bleibt unangetastet (Fokus/Tastatur). */
  _partial(selector, method, apply) {
    apply();
    const el = this.shadowRoot.querySelector(selector);
    if (!el) return;
    el.innerHTML = this[method]();
    this._bind(el);
  }

  _css() {
    return `
    :host{--ss-r:16px;--ss-line:var(--divider-color,#ddd)}
    ha-card{padding:0;overflow:hidden;position:relative;min-height:60vh}
    *{box-sizing:border-box} button,input,select{font:inherit;color:inherit}
    .tabs{display:flex;gap:4px;padding:8px;overflow-x:auto;border-bottom:1px solid var(--ss-line);position:sticky;top:0;background:var(--card-background-color);z-index:2}
    .tab{display:flex;align-items:center;gap:6px;min-height:48px;padding:0 14px;border:0;border-radius:24px;background:transparent;cursor:pointer;white-space:nowrap;font-weight:500}
    .tab.on{background:var(--primary-color,#03a9f4);color:var(--text-primary-color,#fff)}
    .dot{display:inline-grid;place-items:center;width:24px;height:24px;border-radius:50%;font-size:13px;font-weight:700}
    .cnt{background:var(--accent-color,#ff9800);color:#fff;border-radius:10px;padding:0 7px;font-size:12px;line-height:20px}
    .body{padding:12px 12px 24px}
    .muted{color:var(--secondary-text-color)} .warn{color:var(--warning-color,#b26a00);font-size:13px}
    .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:12px}
    .tile{display:flex;flex-direction:column;align-items:center;gap:4px;padding:14px 8px;border:2px solid var(--ss-line);border-radius:var(--ss-r);background:var(--secondary-background-color);cursor:pointer}
    .tile b{font-size:32px;line-height:1} .tile small{color:var(--secondary-text-color)} .tile.total{cursor:default;border-style:dashed}
    .logo{border-radius:12px;object-fit:contain;flex:none}
    .badge{display:inline-grid;place-items:center;font-weight:800;font-size:20px}
    .search,.add input,.editor input,.editor select,.oact select{width:100%;min-height:48px;padding:0 14px;border:1px solid var(--ss-line);border-radius:12px;background:var(--card-background-color)}
    .search{margin:8px 0}
    .results{display:flex;flex-direction:column;gap:6px}
    .row-link{display:flex;align-items:center;gap:10px;min-height:48px;padding:6px 10px;border:0;border-radius:12px;background:var(--secondary-background-color);text-align:left;width:100%}
    .grow{flex:1;min-width:0} .done{text-decoration:line-through;opacity:.6}
    .head{display:flex;align-items:center;gap:12px;margin-bottom:10px} h2{margin:0;font-size:22px}
    .add{display:flex;gap:8px;margin-bottom:10px} .add input[name=qty]{width:76px;text-align:center}
    button.primary{background:var(--primary-color,#03a9f4);color:var(--text-primary-color,#fff);border:0;border-radius:12px;cursor:pointer}
    button.big{min-height:48px;padding:0 16px} .mini{min-width:40px;min-height:40px;border-radius:10px}
    button.ghost{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:48px;padding:0 14px;border:1px solid var(--ss-line);border-radius:12px;background:transparent;cursor:pointer}
    button.ghost.danger{color:var(--error-color,#c62828)} button:disabled{opacity:.4;cursor:default}
    .list{display:flex;flex-direction:column;gap:6px}
    .item{display:flex;align-items:center;gap:4px;min-height:60px;border-radius:14px;background:var(--secondary-background-color);padding:2px 6px 2px 2px}
    .check{width:56px;height:56px;border:0;background:transparent;cursor:pointer;--mdc-icon-size:32px;color:var(--primary-color,#03a9f4)}
    .itext{flex:1;min-width:0;display:flex;flex-direction:column;align-items:flex-start;gap:2px;border:0;background:transparent;text-align:left;cursor:pointer;min-height:56px;justify-content:center}
    .item.done .iname{text-decoration:line-through;opacity:.6} .iname{font-size:17px;word-break:break-word} .imeta{font-size:12px;color:var(--secondary-text-color)}
    .sep{margin:16px 0 6px;font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--secondary-text-color)}
    .actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px} .oact{display:flex;gap:6px;margin-top:6px}
    .editor{display:flex;flex-direction:column;gap:8px;padding:12px;border-radius:14px;background:var(--secondary-background-color);border:2px solid var(--primary-color,#03a9f4)}
    .editor label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--secondary-text-color)} .two{display:grid;grid-template-columns:1fr 1fr;gap:8px}
    .chips{display:flex;gap:6px;overflow-x:auto;padding-bottom:4px}
    .chip{min-height:44px;padding:0 16px;border:1px solid var(--ss-line);border-radius:22px;background:transparent;cursor:pointer;white-space:nowrap}
    .chip.on{background:var(--primary-color,#03a9f4);color:var(--text-primary-color,#fff);border-color:transparent}
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px;margin:10px 0}
    .offer{display:flex;flex-direction:column;border:1px solid var(--ss-line);border-radius:var(--ss-r);overflow:hidden;background:var(--card-background-color)}
    .oimg{position:relative;height:130px;background:#fff;overflow:hidden;display:grid;place-items:center} .oimg img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;padding:6px;box-sizing:border-box}
    .ph{font-size:48px;display:grid;place-items:center;width:100%;height:100%}
    .obadge{position:absolute;top:8px;left:8px;padding:2px 10px;border-radius:10px;font-size:12px;font-weight:700}
    .odisc{position:absolute;top:8px;right:8px;padding:2px 8px;border-radius:10px;background:#d32f2f;color:#fff;font-size:13px;font-weight:700}
    .osale{position:absolute;bottom:8px;left:8px;padding:2px 8px;border-radius:10px;background:#ffd800;color:#222;font-size:11px;font-weight:700}
    .obody{padding:10px;display:flex;flex-direction:column;gap:2px;flex:1} .oname{font-weight:600;min-height:2.6em}
    .oprice{display:flex;align-items:baseline;gap:8px} .oprice b{font-size:22px} .oprice s{color:var(--secondary-text-color)}
    .osale.soon{background:#90caf9}
    .only{margin-top:6px;font-size:12px;color:var(--secondary-text-color)}
    .ver{text-align:center;font-size:11px;color:var(--secondary-text-color);padding:0 0 10px}
    .toast{position:sticky;bottom:12px;margin:0 12px;padding:12px 16px;border-radius:12px;background:var(--primary-text-color);color:var(--card-background-color);text-align:center}
    @media (max-width:480px){.grid{grid-template-columns:1fr 1fr;gap:8px}.oimg{height:110px}.tab span:not(.cnt):not(.dot){font-size:14px}}
    `;
  }
}

if (!customElements.get("smart-shopping-card")) customElements.define("smart-shopping-card", SmartShoppingCard);
window.customCards = window.customCards || [];
window.customCards.push({ type: "smart-shopping-card", name: "Smart Shopping", description: "Einkaufslisten & Angebote für Lidl, Netto, Penny, Kaufland und REWE" });
