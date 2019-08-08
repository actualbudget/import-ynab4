const fs = require('fs');
const os = require('os');
const { join } = require('path');
const d = require('date-fns');
const normalizePathSep = require('slash');
const uuid = require('uuid');
const actual = require('@actual-app/api');
const { amountToInteger } = actual.utils;

// Utils

function mapAccountType(type) {
  switch (type) {
    case 'Cash':
    case 'Checking':
      return 'checking';
    case 'CreditCard':
      return 'credit';
    case 'Savings':
      return 'savings';
    case 'InvestmentAccount':
      return 'investment';
    case 'Mortgage':
      return 'mortgage';
    default:
      return 'other';
  }
}

function sortByKey(arr, key) {
  return [...arr].sort((item1, item2) => {
    if (item1[key] < item2[key]) {
      return -1;
    } else if (item1[key] > item2[key]) {
      return 1;
    }
    return 0;
  });
}

function groupBy(arr, keyName) {
  return arr.reduce(function(obj, item) {
    var key = item[keyName];
    if (!obj.hasOwnProperty(key)) {
      obj[key] = [];
    }
    obj[key].push(item);
    return obj;
  }, {});
}

function monthFromDate(date) {
  return d.format(d.parseISO(date), 'yyyy-MM');
}

function getCurrentMonth() {
  return d.format(new Date(), 'yyyy-MM');
}

// Importer

async function importAccounts(data, entityIdMap) {
  return Promise.all(
    data.accounts.map(async account => {
      if (!account.isTombstone) {
        const id = await actual.createAccount({
          type: mapAccountType(account.accountType),
          name: account.accountName,
          offbudget: account.onBudget ? false : true,
          closed: account.hidden ? true : false
        });
        entityIdMap.set(account.entityId, id);
      }
    })
  );
}

async function importCategories(data, entityIdMap) {
  const masterCategories = sortByKey(data.masterCategories, 'sortableIndex');

  await Promise.all(
    masterCategories.map(async masterCategory => {
      if (
        masterCategory.type === 'OUTFLOW' &&
        !masterCategory.isTombstone &&
        masterCategory.subCategories &&
        masterCategory.subCategories.some(cat => !cat.isTombstone) > 0
      ) {
        const id = await actual.createCategoryGroup({
          name: masterCategory.name,
          is_income: false
        });
        entityIdMap.set(masterCategory.entityId, id);

        if (masterCategory.subCategories) {
          const subCategories = sortByKey(
            masterCategory.subCategories,
            'sortableIndex'
          );
          subCategories.reverse();

          // This can't be done in parallel because sort order depends
          // on insertion order
          for (let category of subCategories) {
            if (!category.isTombstone) {
              const id = await actual.createCategory({
                name: category.name,
                group_id: entityIdMap.get(category.masterCategoryId)
              });
              entityIdMap.set(category.entityId, id);
            }
          }
        }
      }
    })
  );
}

async function importPayees(data, entityIdMap) {
  for (let payee of data.payees) {
    if (!payee.isTombstone) {
      let id = await actual.createPayee({
        name: payee.name,
        category: entityIdMap.get(payee.autoFillCategoryId) || null,
        transfer_acct: entityIdMap.get(payee.targetAccountId) || null
      });

      // TODO: import payee rules

      entityIdMap.set(payee.entityId, id);
    }
  }
}

async function importTransactions(data, entityIdMap) {
  const categories = await actual.getCategories({ asList: true });
  const incomeCategoryId = categories.find(cat => cat.name === 'Income').id;
  const accounts = await actual.getAccounts();
  const payees = await actual.getPayees();

  function getCategory(id) {
    if (id == null || id === 'Category/__Split__') {
      return null;
    } else if (
      id === 'Category/__ImmediateIncome__' ||
      id === 'Category/__DeferredIncome__'
    ) {
      return incomeCategoryId;
    }
    return entityIdMap.get(id);
  }

  function isOffBudget(acctId) {
    let acct = accounts.find(acct => acct.id === acctId);
    if (!acct) {
      throw new Error('Could not find account for transaction when importing');
    }
    return acct.offbudget;
  }

  // Go ahead and generate ids for all of the transactions so we can
  // reliably resolve transfers
  for (let transaction of data.transactions) {
    entityIdMap.set(transaction.entityId, uuid.v4());
  }

  let sortOrder = 1;
  let transactionsGrouped = groupBy(data.transactions, 'accountId');

  await Promise.all(
    Object.keys(transactionsGrouped).map(async accountId => {
      let transactions = transactionsGrouped[accountId];

      let toImport = transactions
        .map(transaction => {
          if (transaction.isTombstone) {
            return;
          }

          let id = entityIdMap.get(transaction.entityId);
          let transferId =
            entityIdMap.get(transaction.transferTransactionId) || null;

          let payee_id = null;
          let payee = null;
          if (transferId) {
            payee_id = payees.find(
              p =>
                p.transfer_acct === entityIdMap.get(transaction.targetAccountId)
            ).id;
          } else {
            payee_id = entityIdMap.get(transaction.payeeId);
          }

          let newTransaction = {
            id,
            amount: amountToInteger(transaction.amount),
            category_id: isOffBudget(entityIdMap.get(accountId))
              ? null
              : getCategory(transaction.categoryId),
            date: transaction.date,
            notes: transaction.memo || null,
            payee,
            payee_id,
            transfer_id: transferId
          };

          newTransaction.subtransactions =
            transaction.subTransactions &&
            transaction.subTransactions.map((t, i) => {
              return {
                amount: amountToInteger(t.amount),
                category_id: getCategory(t.categoryId)
              };
            });

          return newTransaction;
        })
        .filter(x => x);

      await actual.addTransactions(entityIdMap.get(accountId), toImport);
    })
  );
}

function fillInBudgets(data, categoryBudgets) {
  // YNAB only contains entries for categories that have been actually
  // budgeted. That would be fine except that we need to set the
  // "carryover" flag on each month when carrying debt across months.
  // To make sure our system has a chance to set this flag on each
  // category, make sure a budget exists for every category of every
  // month.
  const budgets = [...categoryBudgets];
  data.masterCategories.forEach(masterCategory => {
    if (masterCategory.subCategories) {
      masterCategory.subCategories.forEach(category => {
        if (!budgets.find(b => b.categoryId === category.entityId)) {
          budgets.push({
            budgeted: 0,
            categoryId: category.entityId
          });
        }
      });
    }
  });
  return budgets;
}

async function importBudgets(data, entityIdMap) {
  let budgets = sortByKey(data.monthlyBudgets, 'month');
  let earliestMonth = monthFromDate(budgets[0].month);
  let currentMonth = getCurrentMonth();

  await actual.batchBudgetUpdates(async () => {
    const carryoverFlags = {};

    for (let budget of budgets) {
      await Promise.all(
        fillInBudgets(data, budget.monthlySubCategoryBudgets).map(
          async catBudget => {
            if (!catBudget.isTombstone) {
              let amount = amountToInteger(catBudget.budgeted);
              let catId = entityIdMap.get(catBudget.categoryId);
              let month = monthFromDate(budget.month);
              if (!catId) {
                return;
              }

              await actual.setBudgetAmount(month, catId, amount);

              if (catBudget.overspendingHandling === 'AffectsBuffer') {
                // Turn off the carryover flag so it doesn't propagate
                // to future months
                carryoverFlags[catId] = false;
              } else if (
                catBudget.overspendingHandling === 'Confined' ||
                carryoverFlags[catId]
              ) {
                // Overspending has switched to carryover, set the
                // flag so it propagates to future months
                carryoverFlags[catId] = true;

                await actual.setBudgetCarryover(month, catId, true);
              }
            }
          }
        )
      );
    }
  });
}

function estimateRecentness(str) {
  // The "recentness" is the total amount of changes that this device
  // is aware of, which is estimated by summing up all of the version
  // numbers that its aware of. This works because version numbers are
  // increasing integers.
  return str.split(',').reduce((total, version) => {
    const [_, number] = version.split('-');
    return total + parseInt(number);
  }, 0);
}

function findLatestDevice(files) {
  let devices = files
    .map(deviceFile => {
      const contents = fs.readFileSync(deviceFile, 'utf8');

      let data;
      try {
        data = JSON.parse(contents);
      } catch (e) {
        return null;
      }

      if (data.hasFullKnowledge) {
        return {
          deviceGUID: data.deviceGUID,
          shortName: data.shortDeviceId,
          recentness: estimateRecentness(data.knowledge)
        };
      }

      return null;
    })
    .filter(x => x);

  devices = sortByKey(devices, 'recentness');
  return devices[devices.length - 1].deviceGUID;
}

async function doImport(data) {
  const entityIdMap = new Map();

  console.log('Importing Accounts...');
  await importAccounts(data, entityIdMap);

  console.log('Importing Categories...');
  await importCategories(data, entityIdMap);

  console.log('Importing Payees...');
  await importPayees(data, entityIdMap);

  console.log('Importing Transactions...');
  await importTransactions(data, entityIdMap);

  console.log('Importing Budgets...');
  await importBudgets(data, entityIdMap);

  console.log('Setting up...');
}

async function importYNAB4(filepath) {
  const unixFilepath = normalizePathSep(filepath);
  const m = unixFilepath.match(/\/([^\/\~]*)\~.*\.ynab4/);
  if (!m) {
    throw new Error('Not a YNAB4 file: ' + filepath);
  }
  let budgetName = m[1];

  const metaStr = fs.readFileSync(join(filepath, 'Budget.ymeta'));
  const meta = JSON.parse(metaStr);
  const budgetPath = join(filepath, meta.relativeDataFolderName);

  const deviceFiles = fs.readdirSync(join(budgetPath, 'devices'));
  let deviceGUID = findLatestDevice(
    deviceFiles.map(f => join(budgetPath, 'devices', f))
  );

  const yfullPath = join(budgetPath, deviceGUID, 'Budget.yfull');
  let contents;
  try {
    contents = fs.readFileSync(yfullPath, 'utf8');
  } catch (e) {
    throw new Error('Error reading Budget.yfull file');
  }

  let data;
  try {
    data = JSON.parse(contents);
  } catch (e) {
    throw new Error('Error parsing Budget.yull file');
  }

  return actual.runImport(budgetName, () => doImport(data));
}

function findBudgetsInDir(dir) {
  if (fs.existsSync(dir)) {
    return fs
      .readdirSync(dir)
      .map(file => {
        const m = file.match(/^([^\~]*)\~.*\.ynab4/);
        if (m) {
          return {
            name: m[1],
            filepath: join(dir, file)
          };
        }
      })
      .filter(x => x);
  }
  return [];
}

function findBudgets() {
  return findBudgetsInDir(join(os.homedir(), 'Documents', 'YNAB')).concat(
    findBudgetsInDir(join(os.homedir(), 'Dropbox', 'YNAB'))
  );
}

module.exports = { findBudgetsInDir, findBudgets, importYNAB4 };
