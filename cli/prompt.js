import readline from 'readline';

export function ask(question, defaultValue = '') {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const display = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
    rl.question(display, answer => { rl.close(); resolve(answer.trim() || defaultValue); });
  });
}

/**
 * Enough of a secret to recognise, never enough to use.
 *
 * Showing a stored credential in full so the user can press enter to keep it
 * puts it in scrollback, in shell history, and in any screen recording — which
 * undoes the point of writing it to a private file in the first place.
 */
export function maskSecret(value, keep = 4) {
  const s = String(value ?? '');
  if (!s) return '';
  // Short values are hidden outright: head-plus-tail would reveal most of a
  // twelve-character string, which is worse than showing nothing.
  if (s.length <= keep * 2 + 4) return '*'.repeat(8);
  return `${s.slice(0, keep)}${'*'.repeat(8)}${s.slice(-keep)}`;
}

/**
 * Like `ask`, but never echoes an existing value back.
 *
 * The masked form is only for display — pressing enter keeps the real value,
 * so the round trip is lossless even though the terminal never sees it.
 */
export function askSecret(question, currentValue = '') {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const hint = currentValue ? ` [${maskSecret(currentValue)}]` : '';
    rl.question(`${question}${hint}: `, answer => {
      rl.close();
      resolve(answer.trim() || currentValue);
    });
  });
}

export function askChoice(question, choices, defaultIndex = 0) {
  const list = choices.map((c, i) => `  ${i + 1}. ${c}`).join('\n');
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question}\n${list}\nChoice [${defaultIndex + 1}]: `, answer => {
      rl.close();
      const idx = parseInt(answer, 10) - 1;
      resolve(Number.isFinite(idx) && idx >= 0 && idx < choices.length ? idx : defaultIndex);
    });
  });
}
