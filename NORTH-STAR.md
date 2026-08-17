# NORTH STAR — the discipline (written 2026-08, at the founder's direction)

## The rule
No new features. No new pages. No new games. **One vertical slice at a time, finished to
flawless, before anything else is touched.** "Finished" means a stranger can walk the slice
without hitting a single rough edge — no dead buttons, no placeholder text, no layout breaks,
no unstyled states, no surprise alerts, mobile-sane, loading/empty/error states designed.

## Slice 1 (current): THE CARD LOOP — GAMES LOCKED (founder decision)
**Primary yardstick: Netrunner — System Gateway** (maximum card complexity: 8 attributes,
per-type layouts, factions, symbols, influence, decks, banlist — if the loop is flawless here,
simpler games pass for free; internal fixture only, never shipped publicly).
IMPORTANT: Netrunner has NO official formatter and never will (NSG reserves frames/fonts and
invites original fan frames). The yardstick is therefore OUR frame system rendering maximum
complexity beautifully — which is the exact surface community games will use. Do not chase
pixel-parity with the printed card; the scan is reference only. CAH is where exactness is judged.
**Public demo: Cards Against Humanity** (license-clean CC BY-NC-SA; the loop must ALSO pass
here before the slice is done).
Original note on CAH:
(Locked by the founder 2026-08. Why CAH: CC BY-NC-SA license means the exact physical look is
legal even in public; cards are text-only so every edit keeps perfect physical fidelity; the
game is instantly recognizable in any demo. Every polish decision is made against THIS game
only. Other games stay installed but are not the yardstick.)
A visitor can, with zero instruction:
1. Land on the game page and understand it in 5 seconds.
2. Browse cards that look exactly like the physical cards. Fast, clean grid.
3. Open a card → see it large → click Edit → change text → the REAL card updates as they type.
4. Save: signed in w/ access → commit; signed in w/o access → propose (PR) — both flows
   smooth, explained, undoable. Signed out → clear, kind prompt to sign in (no alert()s).
5. See the PR as a visual card diff (before → after), comment, merge.
6. After merge: grid, modal, print sheet all show the new card. History shows who/when/what.
7. Print: the sheet that comes out matches what they saw. Exactly.

Definition of done: someone unfamiliar records themselves doing 1–7 without confusion;
every state (empty/loading/error/unauthorized) is intentional; zero browser alert()/prompt();
consistent spacing/typography; works at laptop + phone widths.

## Then, in order (do not start early):
Slice 2: sign-in/identity + onboarding (first-run experience).
Slice 3: host-a-game from CSV/Sheet — the creator's first 10 minutes.
Slice 4: the jam loop. Slice 5: releases + print/PnP distribution.

## How to work
Fix-list per slice lives in a GitHub-style issue doc in docs/slices/. Walk the slice in a
browser FIRST, list every flaw, fix top-to-bottom, re-walk, repeat until clean. Only then move on.

## Adoption doctrine (founder, 2026-08): one ladder, three audiences
1. **Players** (the wedge): contributing must feel as easy as commenting — see a card, change a
   number, propose. No jargon, no git exposed. Slice 1 + the founder's own first-game test.
2. **Designers** (the middle): the platform must feel FAMILIAR, not foreign — meet them in
   their tools: Sheets/CSV sync (built), nanDECK/TTS/Screentop bridges (built), IDML *content*
   import for rulebooks (planned), exports to everything they already use. Their workflow
   ports in; nothing is forced out.
3. **Publishers** (FFG, CGE, …): come LAST and bottom-up — the GitHub path. Publishers adopt
   where the games, talent, and playtest data already live (like they scout Kickstarter/itch
   today). Sell them nothing until communities prove the loop; then their needs are private
   repos, IP/role controls, scouting dashboards, licensing rails (fork-royalty = licensing
   infrastructure). Never chase enterprise deals before network proof.
The same substrate serves all three; only the SURFACE changes per audience. Simplicity for
players is priority #1 because it is the only rung that generates the other two.
