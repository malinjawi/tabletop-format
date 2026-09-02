#!/usr/bin/env python3
"""Compatibility entry point for the canonical Chromium renderer.

Existing integrations invoke ``python3 tools/render_cards.py``. Keep that
interface, but execute render_cards.mjs so there is only one implementation of
card faces: layoutCard() from the hub/editor/print-sheet renderer.
"""
import os
import shutil
import sys
from pathlib import Path


node = os.environ.get("FMT_NODE_BIN") or shutil.which("node")
if not node:
    raise SystemExit("render_cards: Node.js was not found; set FMT_NODE_BIN")

script = Path(__file__).with_suffix(".mjs")
os.execv(node, [node, str(script), *sys.argv[1:]])
