#! /usr/bin/env node
// @flow
/* eslint-disable no-console */

import {verifyProof, getMessageLen, getMessageContent} from './index.js';
import {readFileAsync, writeFileAsync} from './helpers.js';
import f from 'figlet';
import chalk from 'chalk';
import process from 'process';
import R from 'ramda';
import elegantSpinner from 'elegant-spinner';
import logUpdate from 'log-update';

const flags = {
  saveMessage: '-s',
};

//BANNER
console.log(chalk.cyan(f.textSync('oraclize', {font: 'Isometric1', horizontalLayout: 'default', verticalLayout: 'default'}))); 

//SPINNER
const frames = R.compose(R.map(() => elegantSpinner()), R.range)(0, process.stdout.columns);
console.log();
console.log(chalk.yellow('PRELIMINARY CHECKS IN PROGRESS'));
setInterval(function () {
  logUpdate(frames.map((x) => chalk.green(x())));
}, 50);

const saveOutputPath = () => {
  return process.argv[R.findIndex(x => x === flags.saveMessage, process.argv) + 1];
};

const parseProof = async (path) => {
  const parsedProof = new Uint8Array(await readFileAsync(path));

  let verifiedProof;
  try {
    verifiedProof = await verifyProof(parsedProof);  
    if (!verifiedProof.mainProof.isVerified) {
      throw new Error();
    }
  } catch (error) {
    throw new Error(error);
  }
  console.log();
  console.log(chalk.green('Proof file: '), path);
  console.log();
  console.log(chalk.yellow('Main proof: '),'\n ', verifiedProof.mainProof);
  console.log(chalk.yellow('Extension proof: '),'\n ', verifiedProof.extensionProof);
  console.log(chalk.yellow('Proof shield: '),'\n ', verifiedProof.proofShield);
  console.log(chalk.yellow('Message: '),'\n ', getMessageLen(verifiedProof.message) < process.stdout.columns * 80
    ? getMessageContent(verifiedProof.message)
    : 'please use save message flag');
  
  console.log(chalk.yellow('Proof ID: '),'\n ', verifiedProof.proofId);
  if (R.contains(flags.saveMessage, process.argv)) {
    if(typeof verifiedProof.message === 'string') {
      await writeFileAsync(saveOutputPath(), verifiedProof.message);
    } else {
      await writeFileAsync(saveOutputPath(), Buffer.from(getMessageContent(verifiedProof.message, true)), 'binary');
    }
  }
};

parseProof(process.argv[2]).then(() => {
  console.log();
  console.log(chalk.green('SUCCESS'));
  process.exit(0);
}).catch(e => {
  console.log(e);
  console.log();
  console.log(chalk.red('FAILURE'));
  process.exit(255);
});
