const { findBudgets, importYNAB4 } = require('./importer');

async function run() {
  let budgets = await findBudgets();
  await importYNAB4(budgets[0].filepath);
}

run();
