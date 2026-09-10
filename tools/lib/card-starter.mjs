import yaml from "js-yaml";

export const CARD_STARTER_SIZES = {
  poker: { label: "Poker · 63.5 × 88.9 mm", width: 63.5, height: 88.9 },
  bridge: { label: "Bridge · 57 × 89 mm", width: 57, height: 89 },
  tarot: { label: "Tarot · 70 × 120 mm", width: 70, height: 120 },
  japanese: { label: "Japanese · 59 × 86 mm", width: 59, height: 86 },
};
export const CARD_STARTER_FIELDS = {
  cost: { key: "cost", name: "Cost", type: "integer" },
  power: { key: "power", name: "Power", type: "integer" },
  category: { key: "category", name: "Category", type: "string" },
};
const TEMPLATES = new Set(["classic", "minimal", "party"]);
export const DEFAULT_CARD_PRINT_PROFILE = Object.freeze({ schema_version: 1, preset: "balanced-duplex",
  selection: { card_ids: [] }, home: { fronts_only: false, gutter_mm: 0, crop_marks: "grid", crop_mark_sides: "both",
    sleeve_profile: "none", sleeve_fit: "contain" },
  press: { target: "generic-srgb", include_back: true, crop_marks: "outside-bleed", crop_mark_sides: "both", color_space: "sRGB", pdf_standard: "none",
    dieline: { enabled: false } } });
export const defaultCardPrintProfile = () => structuredClone(DEFAULT_CARD_PRINT_PROFILE);

const stableId = (value, fallback = "card") => String(value || fallback).normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_")
  .replace(/^_+|_+$/g, "").slice(0, 58) || fallback;

export function normalizeCardStarter(raw = {}, title = "Game") {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("card starter must be an object");
  const value = /** @type {Record<string, unknown>} */ (raw);
  const requestedTemplate = String(value.template || "");
  const requestedSize = String(value.size || "");
  const template = TEMPLATES.has(requestedTemplate) ? requestedTemplate : "classic";
  const size = Object.hasOwn(CARD_STARTER_SIZES, requestedSize) ? requestedSize : "poker";
  const names = (Array.isArray(value.names) ? value.names : String(value.names || "").split(/\r?\n/))
    .map(value => String(value || "").trim()).filter(Boolean).slice(0, 12);
  if (!names.length) throw new Error("add at least one starter card name");
  if (names.some(name => name.length > 100)) throw new Error("starter card names must be 100 characters or fewer");
  const fieldKeys = [...new Set((Array.isArray(value.fields) ? value.fields : []).map(String))]
    .filter(key => Object.hasOwn(CARD_STARTER_FIELDS, key));
  const backText = String(value.back_text || title || "CARD BACK").trim().slice(0, 80);
  const quantity = Math.max(1, Math.min(12, Math.round(Number(value.quantity) || 1)));
  return { schema_version: 1, kind: "cards", template, size, fields: fieldKeys,
    names, back_text: backText || "CARD BACK", quantity,
    production: { bleed_mm: 2, home_print: ["A4", "US Letter"], duplex: "long-edge-mirrored", crop_marks: true } };
}

function layoutFor(starter) {
  const { width: W, height: H } = CARD_STARTER_SIZES[starter.size];
  const hasCost = starter.fields.includes("cost"), hasPower = starter.fields.includes("power"), hasCategory = starter.fields.includes("category");
  const typeSource = hasCategory ? "{card.type} · {card.attributes.category}" : "card.type";
  const fonts = [{ id: "title", family: "Arial", weight: 700, style: "normal" },
    { id: "body", family: "Arial", weight: 400, style: "normal" }];
  let regions;
  if (starter.template === "minimal") {
    regions = [
      { id: "title", type: "text", src: "card.name", x: 5, y: 6, w: W - (10 + (hasCost ? 10 : 0) + (hasPower ? 10 : 0)), h: 9, font: "title", size_pt: 13, align: "left", valign: "middle", color: "#111827" },
      ...(hasCost ? [{ id: "cost", type: "badge", src: "card.attributes.cost", x: W - (hasPower ? 22 : 13), y: 5.5, d: 8, shape: "circle", font: "title", size_pt: 9, bg: "#111827", color: "#ffffff" }] : []),
      ...(hasPower ? [{ id: "power", type: "badge", src: "card.attributes.power", x: W - 13, y: 5.5, d: 8, shape: "square", font: "title", size_pt: 9, bg: "#7c3aed", color: "#ffffff" }] : []),
      { id: "rules", type: "richtext", src: "card.text", x: 5, y: 19, w: W - 10, h: H - 30, font: "body", size_pt: 10, min_size_pt: 7, align: "left", color: "#1f2937", symbols: true, autoshrink: true },
      { id: "type", type: "text", src: typeSource, x: 5, y: H - 8, w: W - 10, h: 4, font: "title", size_pt: 6.5, align: "left", valign: "middle", uppercase: true, color: "#6b7280" },
    ];
  } else if (starter.template === "party") {
    regions = [
      { id: "shell", type: "rect", x: 0, y: 0, w: W, h: H, fill: "#171923", radius_mm: 3 },
      ...(hasCost ? [{ id: "cost", type: "badge", src: "card.attributes.cost", x: 5, y: 5, d: 8, shape: "circle", font: "title", size_pt: 9, bg: "#ffffff", color: "#171923" }] : []),
      ...(hasPower ? [{ id: "power", type: "badge", src: "card.attributes.power", x: W - 13, y: 5, d: 8, shape: "square", font: "title", size_pt: 9, bg: "#7c3aed", color: "#ffffff" }] : []),
      { id: "rules", type: "richtext", src: "card.text", x: 6, y: hasCost || hasPower ? 16 : 9, w: W - 12, h: H - (hasCost || hasPower ? 34 : 27), font: "title", size_pt: 16, min_size_pt: 9, align: "left", color: "#ffffff", symbols: true, autoshrink: true },
      { id: "title", type: "text", src: "card.name", x: 6, y: H - 15, w: W - 12, h: 6, font: "title", size_pt: 8, align: "left", valign: "middle", color: "#c4b5fd" },
      { id: "type", type: "text", src: typeSource, x: 6, y: H - 8, w: W - 12, h: 4, font: "body", size_pt: 6, align: "left", valign: "middle", uppercase: true, color: "#a5b4fc" },
    ];
  } else {
    regions = [
      { id: "shell", type: "rect", x: 0, y: 0, w: W, h: H, fill: "#293241", radius_mm: 3 },
      { id: "title_panel", type: "rect", x: 3, y: 3, w: W - 6, h: 10, fill: "#f8fafc", radius_mm: 2 },
      { id: "title", type: "text", src: "card.name", x: 6, y: 4.5, w: W - (hasCost ? 20 : 12), h: 7, font: "title", size_pt: 10, align: "left", valign: "middle", color: "#111827" },
      ...(hasCost ? [{ id: "cost", type: "badge", src: "card.attributes.cost", x: W - 13, y: 3.5, d: 8, shape: "circle", font: "title", size_pt: 10, bg: "#111827", color: "#ffffff" }] : []),
      { id: "art", type: "image", src: "printing.art", credit: "printing.artist", x: 3, y: 15, w: W - 6, h: H * .38, fit: "cover", bg: "#64748b" },
      { id: "rules_panel", type: "rect", x: 3, y: 16 + H * .38, w: W - 6, h: H - (23 + H * .38), fill: "#f8fafc", radius_mm: 2 },
      { id: "type", type: "text", src: typeSource, x: 6, y: 18 + H * .38, w: W - 12, h: 5, font: "title", size_pt: 7, align: "left", valign: "middle", uppercase: true, color: "#334155" },
      { id: "rules", type: "richtext", src: "card.text", x: 6, y: 24 + H * .38, w: W - 12, h: H - (36 + H * .38), font: "body", size_pt: 8.5, min_size_pt: 6, align: "left", color: "#111827", symbols: true, autoshrink: true },
      ...(hasPower ? [{ id: "power", type: "badge", src: "card.attributes.power", x: W - 13, y: H - 12, d: 8, shape: "square", font: "title", size_pt: 9, bg: "#7c3aed", color: "#ffffff" }] : []),
    ];
  }
  const backBg = starter.template === "party" ? "#171923" : "#293241";
  const paletteColor = starter.template === "party" ? "#171923" : starter.template === "minimal" ? "#ffffff" : "#293241";
  return { card: { w_mm: W, h_mm: H, bleed_mm: 2, radius_mm: 3, bg: starter.template === "party" ? "#171923" : "#ffffff" },
    back: { text: starter.back_text, bg: backBg, color: "#ffffff", border_color: "#ffffff", border_mm: .8,
      regions: [
        { id: "back_field", type: "rect", x: 0, y: 0, w: W, h: H, fill: backBg },
        { id: "back_border", type: "rect", x: 3, y: 3, w: W - 6, h: H - 6, fill: "none", stroke: "#ffffff", stroke_w_mm: .8, radius_mm: 2 },
        { id: "back_title", type: "text", src: "g.layout.back.text", x: 7, y: H / 2 - 8, w: W - 14, h: 16, font: "title", size_pt: 20, align: "center", valign: "middle", color: "#ffffff" },
      ] },
    fonts, palette: { by: "type", map: { card: paletteColor }, default: paletteColor }, regions };
}

export function buildCardStarter(game, raw) {
  const starter = normalizeCardStarter(raw, game.title);
  const definitions = starter.fields.map(key => CARD_STARTER_FIELDS[key]);
  const used = new Set(), cards = starter.names.map((name, index) => {
    const root = stableId(name), id = used.has(root) ? `${root}_${index + 1}` : root;used.add(id);
    const attributes = {};
    if (starter.fields.includes("cost")) attributes.cost = index + 1;
    if (starter.fields.includes("power")) attributes.power = index + 1;
    if (starter.fields.includes("category")) attributes.category = "starter";
    return { id, name, type: "card", subtypes: [], text: index === 0 ? "Describe what this card does." : "Replace this with one testable effect.", keywords: [], attributes, deck_limit: starter.quantity };
  });
  const printings = cards.map((card, index) => ({ id: `p_${card.id}_core`, card_id: card.id, set_id: "core", collector_number: String(index + 1).padStart(3, "0"), quantity: starter.quantity }));
  const nextGame = { ...game, attribute_definitions: definitions };
  const layout = layoutFor(starter);
  const designRoot = "templates/card-design";
  const designManifest = { version: 1, name: `${game.title} card design`,
    description: "The shared visual system for every starter card in this game.",
    system: `${designRoot}/system.yaml`, legacy_source: "templates/layout.yaml", components: [],
    families: [{ id: "card", label: "Card", match: { type: "card" }, source: `${designRoot}/families/card.yaml`, specimens: cards.slice(0, 3).map(card => card.id) }],
    region_order: layout.regions.map(region => region.id) };
  const designSystem = { card: layout.card, back: layout.back, fonts: layout.fonts, palette: layout.palette };
  const files = [
    { path: "game.yaml", content: yaml.dump(nextGame, { noRefs: true, lineWidth: -1, sortKeys: false }) },
    { path: "components/cards.json", content: JSON.stringify(cards, null, 2) + "\n" },
    { path: "components/printings.json", content: JSON.stringify(printings, null, 2) + "\n" },
    { path: "sets/sets.yaml", content: yaml.dump([{ id: "core", name: `${game.title} Prototype`, position: 1, size: cards.length }], { noRefs: true, lineWidth: -1, sortKeys: false }) },
    { path: "templates/layout.yaml", content: yaml.dump(layout, { noRefs: true, lineWidth: -1, sortKeys: false }) },
    { path: `${designRoot}/manifest.yaml`, content: yaml.dump(designManifest, { noRefs: true, lineWidth: -1, sortKeys: false }) },
    { path: `${designRoot}/system.yaml`, content: yaml.dump(designSystem, { noRefs: true, lineWidth: -1, sortKeys: false }) },
    { path: `${designRoot}/families/card.yaml`, content: yaml.dump({ regions: layout.regions }, { noRefs: true, lineWidth: -1, sortKeys: false }) },
    { path: "templates/print.yaml", content: yaml.dump(defaultCardPrintProfile(), { noRefs: true, lineWidth: -1, sortKeys: false }) },
    { path: "design/card-starter.json", content: JSON.stringify(starter, null, 2) + "\n" },
  ];
  return { starter, game: nextGame, cards, printings, layout, files };
}
