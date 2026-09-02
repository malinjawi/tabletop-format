# Netrunner: System Gateway card design

This directory is the editable production source for the game's cards. Forge resolves each card through `manifest.yaml`:

1. `system.yaml` supplies physical dimensions, fonts, and palette tokens.
2. `components/` supplies reusable frame regions shared across families.
3. `families/` supplies the regions unique to one card family.
4. `region_order` preserves deterministic paint order across the composed files.

The original `../layout.yaml` remains as a migration snapshot. Once this manifest exists, Forge renders the composed family sources.
