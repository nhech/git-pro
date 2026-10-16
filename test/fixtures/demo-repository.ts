import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * A small shop project with a believable history, for the screenshots: branches that diverge and merge, a cherry-pick, tags, a remote that is ahead and behind, and a working
 * tree with staged, modified, renamed and untracked files. Dates are relative to now, so the graph reads "2 d ago", "5 d ago"… whenever it is built.
 */
export interface DemoRepositories {
  /** The project, on `main`, with changes in its working tree. */
  readonly project: string;
  /** A clone of the project, stopped in the middle of a merge that has conflicts. */
  readonly merging: string;
}

const people = [['Ada Nguyen', 'ada@storefront.example'], ['Linus Park', 'linus@storefront.example'], ['Maria Gomez', 'maria@storefront.example']] as const;
const days = (count: number, hour = 10) => { const date = new Date(Date.now() - count * 86_400_000); date.setHours(hour, 12, 0, 0); return date.toISOString(); };

export async function buildDemoRepositories(root: string): Promise<DemoRepositories> {
  const project = path.join(root, 'storefront'), remote = path.join(root, 'storefront.git'), merging = path.join(root, 'storefront-merge'), other = path.join(root, 'storefront-teammate');
  const environment = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'), GIT_TERMINAL_PROMPT: '0' };
  await writeFile(environment.GIT_CONFIG_GLOBAL, '[user]\n name = Ada Nguyen\n email = ada@storefront.example\n[commit]\n gpgsign = false\n[init]\n defaultBranch = main\n[merge]\n conflictStyle = merge\n[core]\n autocrlf = false\n');
  let cwd = project, author = 0;
  const git = (...args: string[]): string => {
    const [name, email] = people[author]!, result = spawnSync('git', args, { cwd, env: { ...environment, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email }, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout;
  };
  const write = async (file: string, content: string) => { await mkdir(path.dirname(path.join(cwd, file)), { recursive: true }); await writeFile(path.join(cwd, file), content); };
  const commit = async (who: number, ago: number, message: string, files: Record<string, string>) => {
    author = who; for (const [file, content] of Object.entries(files)) await write(file, content);
    git('add', '-A'); const when = days(ago); const [name, email] = people[who]!;
    const result = spawnSync('git', ['commit', '-q', '-m', message], { cwd, env: { ...environment, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when }, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`commit ${message}: ${result.stderr}`);
    return git('rev-parse', 'HEAD').trim();
  };
  const merge = async (who: number, ago: number, branch: string, message: string) => {
    author = who; const when = days(ago), [name, email] = people[who]!;
    const result = spawnSync('git', ['merge', '--no-ff', '-q', '-m', message, branch], { cwd, env: { ...environment, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when }, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`merge ${branch}: ${result.stderr}`);
  };

  await mkdir(project, { recursive: true }); await mkdir(remote, { recursive: true });
  cwd = remote; git('init', '-q', '--bare'); cwd = project; git('init', '-q');
  const pricing = (extra = '') => `export interface Line { sku: string; unitCents: number; quantity: number }\n\nexport function subtotal(lines: readonly Line[]): number {\n  return lines.reduce((sum, line) => sum + line.unitCents * line.quantity, 0);\n}\n${extra}`;
  await commit(0, 21, 'Initial commit', { 'package.json': '{\n  "name": "storefront",\n  "version": "0.1.0",\n  "scripts": { "test": "node --test" }\n}\n', 'README.md': '# Storefront\n\nA small shop API and cart.\n', 'src/cart.ts': 'import type { Line } from "./pricing";\n\nexport class Cart {\n  private readonly lines: Line[] = [];\n  add(line: Line): void { this.lines.push(line); }\n  get items(): readonly Line[] { return this.lines; }\n}\n' });
  await commit(1, 19, 'Add pricing rules', { 'src/pricing.ts': pricing() });
  await commit(0, 17, 'Add the orders API', { 'src/api/orders.ts': 'export interface Order { id: string; totalCents: number }\n\nexport function createOrder(totalCents: number): Order {\n  return { id: crypto.randomUUID(), totalCents };\n}\n', 'src/ui/Button.tsx': 'export const Button = (props: { label: string }) => <button>{props.label}</button>;\n' });
  git('tag', 'v1.0');
  git('checkout', '-q', '-b', 'fix/rounding');
  await commit(1, 15, 'Round discounts to the nearest cent', { 'src/pricing.ts': pricing('\nexport function discount(cents: number, percent: number): number {\n  return Math.round((cents * percent) / 100);\n}\n') });
  git('checkout', '-q', 'main');
  git('checkout', '-q', '-b', 'feature/checkout');
  const start = await commit(2, 14, 'Start the checkout flow', { 'src/checkout.ts': 'import { Cart } from "./cart";\nimport { createOrder } from "./api/orders";\nimport { subtotal } from "./pricing";\n\nexport function checkout(cart: Cart) {\n  return createOrder(subtotal(cart.items));\n}\n' });
  await commit(2, 12, 'Validate the shipping address', { 'src/checkout.ts': 'import { Cart } from "./cart";\nimport { createOrder } from "./api/orders";\nimport { subtotal } from "./pricing";\n\nexport interface Address { street: string; city: string; postcode: string }\n\nexport function validate(address: Address): boolean {\n  return Boolean(address.street && address.city && /^[0-9A-Z -]{3,10}$/i.test(address.postcode));\n}\n\nexport function checkout(cart: Cart, address: Address) {\n  if (!validate(address)) throw new Error("Invalid shipping address");\n  return createOrder(subtotal(cart.items));\n}\n' });
  await commit(2, 9, 'Show the order summary', { 'src/ui/CartView.tsx': 'import type { Line } from "../pricing";\n\nexport const CartView = (props: { lines: readonly Line[] }) => (\n  <ul>{props.lines.map(line => <li key={line.sku}>{line.quantity} × {line.sku}</li>)}</ul>\n);\n' });
  git('checkout', '-q', 'main');
  await commit(0, 13, 'Add the users API', { 'src/api/users.ts': 'export interface User { id: string; name: string }\n\nexport const users = new Map<string, User>();\n' });
  await merge(1, 11, 'fix/rounding', 'Merge fix/rounding: round discounts');
  // The first commit of the feature, copied onto main: Compare marks the pair as the same change.
  // It keeps the author of the original and takes the date of the day it was copied, so the dates in the list read in order.
  const copied = days(10), copier = { ...environment, GIT_COMMITTER_NAME: 'Ada Nguyen', GIT_COMMITTER_EMAIL: 'ada@storefront.example', GIT_COMMITTER_DATE: copied };
  for (const args of [['cherry-pick', start], ['commit', '-q', '--amend', '--no-edit', '--date', copied]]) {
    const result = spawnSync('git', args, { cwd, env: copier, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  }
  await commit(1, 6, 'Document the pricing module', { 'docs/pricing.md': '# Pricing\n\nAll amounts are integer cents.\n' });
  git('tag', 'v1.1'); git('branch', 'release/1.1');
  await commit(0, 4, 'Cap the quantity of one line at 99', { 'src/cart.ts': 'import type { Line } from "./pricing";\n\nexport class Cart {\n  private readonly lines: Line[] = [];\n  add(line: Line): void {\n    this.lines.push({ ...line, quantity: Math.min(line.quantity, 99) });\n  }\n  get items(): readonly Line[] { return this.lines; }\n}\n' });
  git('remote', 'add', 'origin', remote); git('push', '-q', '-u', 'origin', 'main'); git('push', '-q', '-u', 'origin', 'feature/checkout'); git('push', '-q', 'origin', '--tags');
  // A teammate pushes to main (so main is behind), and one more commit of ours stays local (so it is ahead).
  await mkdir(other, { recursive: true }); cwd = root; git('clone', '-q', remote, other); cwd = other; author = 1;
  await commit(1, 2, 'Log failed payments', { 'src/api/payments.ts': 'export function logFailure(reason: string): void {\n  console.error("payment failed:", reason);\n}\n' });
  git('push', '-q', 'origin', 'main'); cwd = project; git('fetch', '-q', 'origin');
  git('checkout', '-q', 'feature/checkout'); await commit(2, 1, 'Add a checkout test', { 'tests/checkout.test.ts': 'import { validate } from "../src/checkout";\n\nvalidate({ street: "1 Main St", city: "Springfield", postcode: "12345" });\n' });
  git('checkout', '-q', 'main'); await commit(0, 1, 'Bump the version to 0.2.0', { 'package.json': '{\n  "name": "storefront",\n  "version": "0.2.0",\n  "scripts": { "test": "node --test" }\n}\n' });

  // A clone stopped in the middle of a merge with two conflicts, for the Conflicts tab.
  cwd = root; git('clone', '-q', project, merging); cwd = merging; author = 0;
  git('checkout', '-q', '-b', 'promo/spring-sale');
  await commit(1, 3, 'Apply the spring discount in pricing', { 'src/pricing.ts': pricing('\nexport const SPRING = 15;\n\nexport function total(lines: readonly Line[]): number {\n  return Math.round(subtotal(lines) * (100 - SPRING) / 100);\n}\n'), 'README.md': '# Storefront\n\nA small shop API and cart.\n\n## Spring sale\n\nAll orders get 15% off.\n' });
  git('checkout', '-q', 'main');
  await commit(0, 2, 'Add a loyalty discount in pricing', { 'src/pricing.ts': pricing('\nexport const LOYALTY = 5;\n\nexport function total(lines: readonly Line[]): number {\n  return Math.round(subtotal(lines) * (100 - LOYALTY) / 100);\n}\n'), 'README.md': '# Storefront\n\nA small shop API and cart.\n\n## Loyalty\n\nReturning customers get 5% off.\n' });
  const merged = spawnSync('git', ['merge', 'promo/spring-sale'], { cwd, env: { ...environment, GIT_AUTHOR_NAME: 'Ada Nguyen', GIT_AUTHOR_EMAIL: 'ada@storefront.example', GIT_COMMITTER_NAME: 'Ada Nguyen', GIT_COMMITTER_EMAIL: 'ada@storefront.example' }, encoding: 'utf8' });
  if (merged.status === 0) throw new Error('The demo merge was expected to conflict.');

  // The project's working tree: staged, modified, renamed and untracked files.
  cwd = project;
  await write('src/api/users.ts', 'export interface User { id: string; name: string; email: string }\n\nexport const users = new Map<string, User>();\n');
  await write('tests/cart.test.ts', 'import { Cart } from "../src/cart";\n\nnew Cart().add({ sku: "mug", unitCents: 900, quantity: 2 });\n');
  git('mv', 'src/ui/Button.tsx', 'src/ui/PrimaryButton.tsx'); git('add', 'src/api/users.ts', 'tests/cart.test.ts');
  await write('src/cart.ts', 'import type { Line } from "./pricing";\n\nconst MAX_QUANTITY = 99;\n\nexport class Cart {\n  private readonly lines: Line[] = [];\n  add(line: Line): void {\n    this.lines.push({ ...line, quantity: Math.min(line.quantity, MAX_QUANTITY) });\n  }\n  remove(sku: string): void {\n    const index = this.lines.findIndex(line => line.sku === sku);\n    if (index >= 0) this.lines.splice(index, 1);\n  }\n  get items(): readonly Line[] { return this.lines; }\n}\n');
  await write('src/pricing.ts', pricing('\nexport function discount(cents: number, percent: number): number {\n  return Math.round((cents * percent) / 100);\n}\n\nexport function withTax(cents: number, rate = 0.2): number {\n  return Math.round(cents * (1 + rate));\n}\n'));
  await write('README.md', '# Storefront\n\nA small shop API and cart.\n\n## Development\n\nRun `npm test` before you push.\n');
  await write('docs/notes.md', 'Ideas for the next release:\n\n- gift wrapping\n- saved carts\n');
  return { project, merging };
}
