#!/usr/bin/env node
const { findBudgets, importYNAB4 } = require('./importer');

async function run() {
  let filepath = process.argv[2];
  await importYNAB4(filepath);
}

run();
