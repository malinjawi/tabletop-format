#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { buildForgeDataWorkingCopy } from "./lib/forge-project.mjs";
import { buildForgeWorkbook, inspectForgeWorkbook, inspectWorkbookCandidate } from "./lib/workbook.mjs";
import { deterministicZip, readZip } from "./lib/deterministic-zip.mjs";

const ROOT=resolve(import.meta.dirname,".."),temp=mkdtempSync(join(tmpdir(),"forge-workbook-test-"));
const PYTHON=process.env.FORGE_PYTHON||(existsSync(join(ROOT,".venv","bin","python"))?join(ROOT,".venv","bin","python"):"python3");
const hash=value=>createHash("sha256").update(value).digest("hex");
try{
  const ref=execFileSync("git",["rev-parse","HEAD"],{cwd:ROOT,encoding:"utf8"}).trim();
  const working=buildForgeDataWorkingCopy(join(ROOT,"examples","ember"),{sourceRef:ref});
  const first=buildForgeWorkbook(working.archive),second=buildForgeWorkbook(working.archive);
  assert.equal(hash(first.workbook),hash(second.workbook),"XLSX bytes must be deterministic");
  assert.equal(first.metadata.format,"forge-tabular-workbook");
  assert.deepEqual(Object.keys(first.metadata.tables),["cards","printings","tokens"]);
  const original=inspectForgeWorkbook(first.workbook);
  assert.equal(original.source.ref,ref);
  assert.equal(original.tables.cards.rows,9);
  assert.equal(original.tables.tokens.rows,3);
  const candidate=inspectWorkbookCandidate(first.workbook);
  assert.equal(candidate.suggested_sheet,"cards","ordinary workbook onboarding should prefer the card-like tab over README");
  const literalEntries=new Map(working.entries);
  literalEntries.set("editable/cards.csv",Buffer.from(literalEntries.get("editable/cards.csv").toString().replace(",Kindling,",",=SUM(A1:A2),")));
  const literal=inspectForgeWorkbook(buildForgeWorkbook(deterministicZip(literalEntries)).workbook);
  assert.match(literal.tables.cards.csv,/=SUM\(A1:A2\)/,"canonical text must not become an executable workbook formula");

  const path=join(temp,"edited.xlsx");writeFileSync(path,first.workbook);
  execFileSync(PYTHON,["-c",String.raw`
from openpyxl import load_workbook
import sys
p=sys.argv[1];w=load_workbook(p)
def set_value(sheet,row_id,column,value):
    ws=w[sheet];headers=[cell.value for cell in ws[1]];id_col=headers.index("id")+1;target=headers.index(column)+1
    for row in range(2,ws.max_row+1):
        if ws.cell(row,id_col).value==row_id: ws.cell(row,target).value=value;return
    raise RuntimeError(row_id)
set_value("cards","kindling","name","Kindling Workbook")
set_value("printings","p_kindling_core","quantity",4)
set_value("tokens","spark_token","name","Spark Workbook")
w.save(p)
`,path]);
  const edited=inspectForgeWorkbook(readFileSync(path));
  assert.match(edited.tables.cards.csv,/Kindling Workbook/);
  assert.match(edited.tables.printings.csv,/p_kindling_core[^\n]*,4(?:,|\n)/);
  assert.match(edited.tables.tokens.csv,/Spark Workbook/);

  execFileSync(PYTHON,["-c",String.raw`
from openpyxl import load_workbook
import sys
p=sys.argv[1];w=load_workbook(p);w["cards"]["B2"]="=1+1";w.save(p)
`,path]);
  assert.throws(()=>inspectForgeWorkbook(readFileSync(path)),/contains a formula/);

  const linkedEntries=readZip(first.workbook);
  linkedEntries.set("xl/externalLinks/externalLink1.xml",Buffer.from("<externalLink/>"));
  assert.throws(()=>inspectForgeWorkbook(deterministicZip(linkedEntries)),/external workbook links/);
  const macroEntries=readZip(first.workbook);
  macroEntries.set("xl/vbaProject.bin",Buffer.from("not executable"));
  assert.throws(()=>inspectForgeWorkbook(deterministicZip(macroEntries)),/macros and external workbook links/);

  const noPieces=buildForgeDataWorkingCopy(join(ROOT,"examples","_fixtures","netrunner-sg"),{sourceRef:ref});
  const blank=inspectForgeWorkbook(buildForgeWorkbook(noPieces.archive).workbook);
  assert.equal(blank.tables.tokens.rows,0);
  assert(blank.tables.tokens.columns.includes("id"),"an empty pieces table must keep its stable schema");
  console.log("✓ deterministic XLSX export, multi-table return, ordinary-workbook inspection, formula/macro/link rejection, and empty-table bootstrap");
}finally{rmSync(temp,{recursive:true,force:true});}
