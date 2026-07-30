// jamcheck.mjs — the JS twin of tools/check_jam.py: does a game qualify for a jam?
// The server's submit-time gate. Caller passes already-read data (the server
// reads YAML with regex, no yaml dep): raw game.yaml text + parsed cards/printings
// + rules text. Keep the constraint logic in lockstep with check_jam.py.
export function jamQualify(jam, { gameYaml = "", cards = [], printings = [], rulesMd = "" }) {
  const c = jam.constraints || {};
  const reasons = [];
  const license = (gameYaml.match(/^license:\s*["']?([^"'\s#]+)/m) ?? [])[1] ?? "";
  const title = ((gameYaml.match(/^title:\s*(.+)$/m) ?? [])[1] ?? "").replace(/^["']|["']$/g, "").trim();
  const desc = ((gameYaml.match(/^description:\s*(.+)$/m) ?? [])[1] ?? "").replace(/^["']|["']$/g, "");

  if (c.max_cards != null && cards.length > c.max_cards) reasons.push(`${cards.length} unique cards; jam max is ${c.max_cards}`);
  if (c.min_cards != null && cards.length < c.min_cards) reasons.push(`${cards.length} unique cards; jam min is ${c.min_cards}`);
  const deck = printings.reduce((s, p) => s + (p.quantity ?? 1), 0);
  if (c.max_deck_size != null && deck > c.max_deck_size) reasons.push(`${deck} physical cards; jam max is ${c.max_deck_size}`);
  if (Array.isArray(c.required_license) && c.required_license.length && !c.required_license.includes(license))
    reasons.push(`license '${license || "?"}' not in the jam's allowed list: ${c.required_license.join(", ")}`);
  if (c.theme_word_required) {
    const theme = String(jam.theme || "").toLowerCase();
    let hay = (title + " " + desc).toLowerCase();
    hay += " " + cards.map(x => (x.name || "") + " " + (x.text || "")).join(" ").toLowerCase();
    hay += " " + rulesMd.toLowerCase();
    if (theme && !hay.includes(theme)) reasons.push(`theme word '${jam.theme}' not found in title, cards, or rules`);
  }
  return { qualified: reasons.length === 0, reasons, cards: cards.length, deck };
}
