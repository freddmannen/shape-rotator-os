import { SANITIZED_INTEL_DATA } from "./intel-data.js";

const state = {
  data: SANITIZED_INTEL_DATA,
  error: "",
  query: "",
  kind: "all",
  sensitivity: "all",
  selectedId: SANITIZED_INTEL_DATA.defaultId || "",
};

const KIND_LABELS = {
  person: "People",
  project: "Projects",
  transcript: "Meetings",
  pack: "Packs",
  osint: "Surfaces",
};

const KIND_DOTS = {
  person: "#7cc0c4",
  project: "#d8b25a",
  transcript: "#9ccb78",
  pack: "#e08272",
  osint: "#b4a2d6",
  source: "#b4a2d6",
};

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function entityTitle(entity) {
  return entity?.displayTitle || entity?.title || entity?.id || "Untitled";
}

function entityType(entity) {
  return entity?.displayType || KIND_LABELS[entity?.type] || entity?.type || "Object";
}

function displaySensitivity(entity) {
  if (!entity) return "";
  return entity.displaySensitivity || "Vault metadata";
}

function defaultSelection(entities) {
  const sorted = [...entities].sort((a, b) =>
    (b.coverage || 0) - (a.coverage || 0)
    || (b.neighborCount || 0) - (a.neighborCount || 0)
    || entityTitle(a).localeCompare(entityTitle(b)));
  return sorted.find((entity) => entity.neighborCount)?.id || sorted[0]?.id || "";
}

function matches(entity) {
  const query = state.query.trim().toLowerCase();
  const typeOk = state.kind === "all" || entity.type === state.kind;
  const sensitivityOk = state.sensitivity === "all"
    || (state.sensitivity === "restricted" && entity.sensitive)
    || (state.sensitivity === "standard" && !entity.sensitive);
  if (!typeOk || !sensitivityOk) return false;
  if (!query) return true;
  const haystack = [
    entityTitle(entity),
    entity.id,
    entity.path,
    entity.subtitle,
    entity.displayRole,
    ...(entity.members || []),
    ...(entity.participants || []),
    ...(entity.projects || []),
    ...(entity.surfaces || []),
  ].join(" ").toLowerCase();
  return haystack.includes(query);
}

function selectedEntity(data) {
  const entities = data?.entities || [];
  if (!entities.some((entity) => entity.id === state.selectedId)) {
    state.selectedId = defaultSelection(entities);
  }
  return entities.find((entity) => entity.id === state.selectedId) || entities[0] || null;
}

function neighborsFor(data, selected) {
  if (!data || !selected) return [];
  const ids = new Set();
  for (const edge of data.edges || []) {
    if (edge.source === selected.id) ids.add(edge.target);
    if (edge.target === selected.id) ids.add(edge.source);
  }
  const byId = new Map((data.entities || []).map((entity) => [entity.id, entity]));
  return [...ids].map((id) => byId.get(id)).filter(Boolean)
    .sort((a, b) => (b.coverage || 0) - (a.coverage || 0) || entityTitle(a).localeCompare(entityTitle(b)))
    .slice(0, 18);
}

function sourceMix(entity) {
  return (entity?.sourceMix || []).map((item) =>
    `<span class="intel-pill"><strong>${esc(item.count)}</strong> ${esc(item.label)}</span>`
  ).join("");
}

function metricTiles(data) {
  const summary = data?.summary || {};
  const transcript = data?.transcriptSummary || {};
  const graph = data?.graphSummary || {};
  const metrics = [
    ["people", summary.people],
    ["projects", summary.projects],
    ["meetings", summary.meeting_packs],
    ["transcripts", transcript.transcript_records || summary.transcripts],
    ["edges", graph.edges],
    ["held back", data?.redactionSummary?.sensitiveEntitiesRemoved || 0],
  ];
  return metrics.map(([label, value]) => `
    <div class="intel-metric">
      <strong>${esc(value ?? "—")}</strong>
      <span>${esc(label)}</span>
    </div>
  `).join("");
}

function renderEntityList(entities) {
  if (!entities.length) {
    return `<p class="intel-empty">No vault objects match this filter.</p>`;
  }
  return entities.slice(0, 80).map((entity) => {
    const selected = entity.id === state.selectedId ? " is-selected" : "";
    const restricted = entity.sensitive ? " is-restricted" : "";
    const dot = KIND_DOTS[entity.type] || KIND_DOTS.source;
    return `
      <button class="intel-entity${selected}${restricted}" type="button" data-intel-select="${esc(entity.id)}">
        <span class="intel-entity-dot" style="--dot:${esc(dot)}"></span>
        <span class="intel-entity-main">
          <strong>${esc(entityTitle(entity))}</strong>
          <small>${esc(entityType(entity))} · coverage ${esc(entity.coverage ?? 0)} · ${esc(displaySensitivity(entity))}</small>
        </span>
      </button>
    `;
  }).join("");
}

function renderNeighbors(items) {
  if (!items.length) return `<p class="intel-muted">No indexed neighbors for this selection.</p>`;
  return items.map((entity) => `
    <button class="intel-neighbor" type="button" data-intel-select="${esc(entity.id)}">
      <span class="intel-neighbor-type">${esc(entityType(entity))}</span>
      <span>${esc(entityTitle(entity))}</span>
    </button>
  `).join("");
}

function buildCards(entity, neighbors) {
  if (!entity) return [];
  const cards = [];
  const mix = entity.sourceMix || [];
  cards.push({
    tier: "grounded",
    lens: "source coverage",
    title: `${entityTitle(entity)} has ${entity.sourceDocCount || mix.length || 0} indexed source surface${(entity.sourceDocCount || mix.length) === 1 ? "" : "s"}`,
    body: "This card is derived from the vault status export, not from a new model read.",
    chain: [
      `selected object: ${entity.path || entity.id}`,
      `coverage score: ${entity.coverage ?? 0}`,
      mix.length ? `source mix: ${mix.map((item) => `${item.label} ×${item.count}`).join(", ")}` : "source mix not yet populated in the export",
      "therefore: start from the named corpus path before treating any relationship view as truth",
    ],
    why: "Coverage tells an operator whether this object is ready for a direct read, a context pack, or a gap-finding pass.",
    confirm: entity.path ? `Open ${entity.path} and check the pack header before using this as source-backed context.` : "Resolve a canonical corpus path.",
  });
  if (neighbors.length) {
    cards.push({
      tier: "inferred",
      lens: "relationship density",
      title: `${entityTitle(entity)} is connected to ${neighbors.length} visible neighbor${neighbors.length === 1 ? "" : "s"}`,
      body: "Relationship density is a navigation signal. It is not a verdict about importance.",
      chain: [
        `relationship view contains ${neighbors.length} filtered neighbors for this selection`,
        `top related objects: ${neighbors.slice(0, 4).map(entityTitle).join(", ")}`,
        "therefore: use the neighbor set to decide which adjacent packs or meetings to open next",
      ],
      why: "Dense relationship objects are good starting points for assembling an operator context pack.",
      confirm: "Check the source paths behind the neighbors; do not infer meaning from graph position alone.",
    });
  }
  if (entity.sensitive) {
    cards.push({
      tier: "restricted",
      lens: "sensitivity boundary",
      title: `${entityTitle(entity)} carries restricted operator context`,
      body: "The panel exposes the existence and path of restricted material, not the private body text.",
      chain: [
        "vault export marks this object as sensitive",
        "restricted content remains in the vault corpus, outside this Electron panel",
        "therefore: route any shareable output through an audience-safe pass before quoting or summarizing",
      ],
      why: "The useful signal is that private context exists and changes interpretation; the UI should label that boundary instead of hiding it.",
      confirm: "Operator must choose restricted-operator vs audience-safe handling before any downstream use.",
    });
  }
  if ((entity.repos || []).length) {
    cards.push({
      tier: "grounded",
      lens: "repo trail",
      title: `${entityTitle(entity)} has ${(entity.repos || []).length} linked repo record${entity.repos.length === 1 ? "" : "s"}`,
      body: "Repository records are useful for checking whether a project’s claimed surface exists in code.",
      chain: [
        `linked repos: ${entity.repos.map((repo) => repo.name || repo.github || repo.path).join(", ")}`,
        "repo status is metadata, not final technical review",
        "therefore: use repo links as a verification trail, not as an assessment shortcut",
      ],
      why: "Code and commit surfaces often confirm or falsify project-readiness claims faster than prose alone.",
      confirm: "Open the repo pack and verify status/privacy before citing implementation evidence.",
    });
  }
  return cards;
}

function renderChain(chain) {
  return `
    <ol class="intel-chain">
      ${chain.map((step, index) => {
        const conclusion = index === chain.length - 1 || /^\s*therefore\b/i.test(step);
        const body = String(step).replace(/^\s*therefore[\s,:]*/i, "");
        return `
          <li class="${conclusion ? "is-conclusion" : ""}">
            <span>${conclusion ? "∴" : index + 1}</span>
            <p>${conclusion ? `<strong>therefore</strong> ` : ""}${esc(body)}</p>
          </li>
        `;
      }).join("")}
    </ol>
  `;
}

function renderCards(cards) {
  return cards.map((card) => `
    <article class="intel-card intel-card--${esc(card.tier)}">
      <header>
        <div class="intel-card-meta">
          <span class="intel-tier">${esc(card.tier)}</span>
          <span class="intel-lens">${esc(card.lens)}</span>
        </div>
        <h3>${esc(card.title)}</h3>
        <p>${esc(card.body)}</p>
      </header>
      ${renderChain(card.chain)}
      <footer>
        <div><span>why it matters</span>${esc(card.why)}</div>
        <div><span>to confirm</span>${esc(card.confirm)}</div>
      </footer>
    </article>
  `).join("");
}

function renderInspector(entity, neighbors) {
  if (!entity) return `<section class="intel-inspector"><p class="intel-empty">No object selected.</p></section>`;
  const restricted = entity.sensitive ? `<span class="intel-status is-restricted">restricted</span>` : `<span class="intel-status">standard vault</span>`;
  return `
    <section class="intel-inspector">
      <header class="intel-inspector-head">
        <div>
          <p class="intel-kicker">${esc(entityType(entity))}</p>
          <h2>${esc(entityTitle(entity))}</h2>
          <p>${esc(entity.subtitle || displaySensitivity(entity))}</p>
        </div>
        ${restricted}
      </header>
      <div class="intel-path-row">
        <code>${esc(entity.path || entity.id)}</code>
        <button type="button" data-intel-copy="${esc(entity.path || entity.id)}">copy path</button>
      </div>
      <div class="intel-source-mix">${sourceMix(entity) || `<span class="intel-pill">source mix pending</span>`}</div>
      <section>
        <h3>Related objects</h3>
        <div class="intel-neighbors">${renderNeighbors(neighbors)}</div>
      </section>
    </section>
  `;
}

function renderShell(container, data) {
  const entities = (data.entities || []).filter(matches);
  if (!entities.some((entity) => entity.id === state.selectedId)) {
    state.selectedId = defaultSelection(entities);
  }
  const selected = selectedEntity(data);
  const neighbors = neighborsFor(data, selected);
  const cards = buildCards(selected, neighbors);
  const generatedDate = (data.statusGeneratedAt || data.generatedAt || "").slice(0, 10);
  container.innerHTML = `
    <section class="intel-panel">
      <header class="intel-hero">
        <div>
          <p class="intel-kicker">Shape Rotator Intelligence Vault</p>
          <h1>Intel</h1>
          <p>Vault-backed relationship and source coverage. Lenses guide navigation; corpus packs remain truth.</p>
        </div>
        <div class="intel-hero-note">
          <span>snapshot ${esc(generatedDate || "unknown")}</span>
          <span>no corpus bodies bundled</span>
        </div>
      </header>
      <div class="intel-metrics">${metricTiles(data)}</div>
      <section class="intel-layout">
        <aside class="intel-sidebar">
          <div class="intel-search">
            <input type="search" data-intel-query aria-label="Filter intel by person, project, meeting, or path" placeholder="filter person, project, meeting, path" value="${esc(state.query)}" />
            <div class="intel-filter-row" role="group" aria-label="kind filter">
              ${["all", "project", "person", "transcript", "pack"].map((kind) => `
                <button type="button" data-intel-kind="${kind}" class="${state.kind === kind ? "is-active" : ""}">
                  ${esc(kind === "all" ? "all" : KIND_LABELS[kind] || kind)}
                </button>
              `).join("")}
            </div>
            <div class="intel-filter-row" role="group" aria-label="sensitivity filter">
              ${[
                ["all", "any"],
                ["standard", "standard"],
                ["restricted", "restricted"],
              ].map(([value, label]) => `
                <button type="button" data-intel-sensitivity="${value}" class="${state.sensitivity === value ? "is-active" : ""}">
                  ${esc(label)}
                </button>
              `).join("")}
            </div>
          </div>
          <div class="intel-list-head">
            <span>${entities.length} visible</span>
            <button type="button" data-intel-reset>reset</button>
          </div>
          <div class="intel-list">${renderEntityList(entities)}</div>
        </aside>
        <main class="intel-main">
          ${renderInspector(selected, neighbors)}
          <section class="intel-cards">
            <div class="intel-section-head">
              <h3>Intel cards</h3>
              <p>Metadata-derived reads with visible limits.</p>
            </div>
            ${renderCards(cards)}
          </section>
        </main>
      </section>
    </section>
  `;
}

export function renderIntel(container) {
  if (!container) return;
  if (state.error && !state.data) {
    container.innerHTML = `<section class="intel-panel"><p class="intel-empty">Intel data unavailable: ${esc(state.error)}</p></section>`;
    return;
  }
  renderShell(container, state.data);
}

function rerender(container, { focusQuery = false } = {}) {
  renderIntel(container);
  wireIntel(container);
  if (focusQuery) {
    const input = container.querySelector("[data-intel-query]");
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  }
}

export function wireIntel(container) {
  if (!container) return;
  const query = container.querySelector("[data-intel-query]");
  if (query) {
    query.addEventListener("input", () => {
      state.query = query.value || "";
      rerender(container, { focusQuery: true });
    });
  }
  for (const button of container.querySelectorAll("[data-intel-kind]")) {
    button.addEventListener("click", () => {
      state.kind = button.dataset.intelKind || "all";
      rerender(container);
    });
  }
  for (const button of container.querySelectorAll("[data-intel-sensitivity]")) {
    button.addEventListener("click", () => {
      state.sensitivity = button.dataset.intelSensitivity || "all";
      rerender(container);
    });
  }
  for (const button of container.querySelectorAll("[data-intel-select]")) {
    button.addEventListener("click", () => {
      state.selectedId = button.dataset.intelSelect || "";
      rerender(container);
    });
  }
  const reset = container.querySelector("[data-intel-reset]");
  if (reset) {
    reset.addEventListener("click", () => {
      state.query = "";
      state.kind = "all";
      state.sensitivity = "all";
      rerender(container);
    });
  }
  for (const button of container.querySelectorAll("[data-intel-copy]")) {
    button.addEventListener("click", async () => {
      const text = button.dataset.intelCopy || "";
      const old = button.textContent;
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = "copied";
        setTimeout(() => { button.textContent = old; }, 900);
      } catch {
        button.textContent = "copy failed";
        setTimeout(() => { button.textContent = old; }, 900);
      }
    });
  }
}
