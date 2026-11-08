import { _electron as electron, expect } from '@playwright/test';
import electronPath from 'electron';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const repoRoot = process.cwd();
const executable = process.env.SUPPORT_SMOKE_EXECUTABLE || electronPath;
const args = process.env.SUPPORT_SMOKE_EXECUTABLE ? [] : ['.'];
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'supp-ai-smoke-'));
const ticketsRoot = path.join(fixtureRoot, 'tickets');
const dataRoot = path.join(fixtureRoot, 'data');
const configDir = path.join(fixtureRoot, 'config');
const configFile = path.join(configDir, 'config.json');
const ticketA = path.join(ticketsRoot, 'ticket_901');
const ticketB = path.join(ticketsRoot, 'ticket_902');
const markdownA = path.join(ticketA, 'ticket_901.md');
const screenshotPath = path.join(repoRoot, 'test-results', 'workspace.png');
const initialA = '# Synthetic ticket 901\n\nA harmless desktop fixture.\n\n## Details\n\n- First item\n- Second item\n\n```text\nsynthetic log excerpt\n```\n\n| Field | Value |\n| --- | --- |\n| Status | Open |\n\nSee [the synthetic log](evidence.log).\n';
const initialB = '# Synthetic ticket 902\n\nA second harmless fixture.\n';
let app;
let page;
let succeeded = false;
const pageErrors = [];

async function waitForContents(file, expected) {
  await expect.poll(() => fs.readFile(file, 'utf8'), { timeout: 10_000 }).toBe(expected);
}
const source = () => page.getByRole('textbox', { name: 'Markdown source' });
const rich = () => page.locator('.ProseMirror[contenteditable="true"]');
const home = () => page.locator('.home-screen');
const ticketRow = (name) => page.locator('.home-ticket').filter({ hasText: name });
const tab = (name) => page.locator('.ticket-tabs .tab').filter({ hasText: name });
const rail = () => page.locator('.files-rail');
const conflict = () => page.locator('.conflict-banner');
const pickTicket = async (name) => {
  await page.getByRole('button', { name: 'Ticket menu' }).click();
  await page.getByRole('menuitem', { name: new RegExp(name) }).click();
};

async function sendSyntheticPrompt() {
  const input = page.getByRole('textbox', { name: 'Message Copilot' });
  await input.fill('Reply exactly READY. Do not use tools.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(input).toHaveValue('');
}

try {
  await fs.mkdir(ticketA, { recursive: true });
  await fs.mkdir(ticketB, { recursive: true });
  await fs.mkdir(dataRoot, { recursive: true });
  await fs.writeFile(markdownA, initialA);
  await fs.writeFile(path.join(ticketB, 'ticket_902.md'), initialB);
  await fs.writeFile(path.join(ticketA, 'evidence.log'), 'Synthetic evidence only.\n');
  const env = { ...process.env, SUPPORT_TICKETS_ROOT: ticketsRoot, SUPPORT_DATA_DIR: dataRoot, SUPPORT_CONFIG_DIR: configDir };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: executable, args, cwd: repoRoot, env, timeout: 30_000 });
  page = await app.firstWindow();
  page.setDefaultTimeout(10_000);
  page.on('pageerror', (error) => pageErrors.push(error));
  await expect(home()).toBeVisible();
  await ticketRow('ticket_901').click();
  await expect(rich()).toContainText('Synthetic ticket 901');
  await waitForContents(markdownA, initialA);
  await expect(rail().getByRole('button', { name: 'Find sessions' })).toBeVisible();
  await expect(page.locator('.global-error')).toHaveCount(0);
  await expect(rail()).toBeVisible();
  await page.getByRole('button', { name: 'Hide files' }).click();
  await expect(rail()).toHaveCount(0);
  await expect.poll(async () => JSON.parse(await fs.readFile(configFile, 'utf8')).filesHidden).toBe(true);
  await page.getByRole('button', { name: 'Layout menu' }).click();
  await page.getByRole('menuitem', { name: 'Show files' }).click();
  await expect(rail()).toBeVisible();
  await page.getByText('evidence.log', { exact: true }).click();
  await expect(page.locator('.text-view')).toContainText('Synthetic evidence only.');
  await page.locator('button[title="Back to ticket summary"]').click();
  await expect(rich()).toContainText('Synthetic ticket 901');
  await rich().click();
  await page.keyboard.press('Control+End');
  await page.getByRole('button', { name: 'Bold', exact: true }).click();
  await expect(rich()).toBeFocused();
  await page.keyboard.type(' smoke-bold');
  await expect(rich().locator('strong')).toContainText('smoke-bold');
  await page.getByRole('button', { name: 'Markdown', exact: true }).click();
  await expect(source()).toHaveValue(/smoke-bold/);
  const unsupported = `${await source().inputValue()}\n\n:::unsupported\nsmoke-raw-source\n:::\n`;
  await source().fill(unsupported);
  await waitForContents(markdownA, unsupported);
  const localDraft = `${unsupported}\nlocal-draft\n`;
  await source().fill(localDraft);
  await fs.writeFile(markdownA, `${initialA}\nExternal synthetic edit.\n`);
  await expect(conflict()).toBeVisible();
  await pickTicket('ticket_902');
  await expect(conflict()).toBeVisible();
  await expect(source()).toHaveValue(localDraft);
  await page.getByRole('button', { name: 'Keep my version' }).click();
  await expect(conflict()).toHaveCount(0);
  await waitForContents(markdownA, localDraft);
  await pickTicket('ticket_902');
  await expect(rich()).toContainText('Synthetic ticket 902');
  await pickTicket('ticket_901');
  await expect(source()).toHaveValue(localDraft);

  if (process.env.RUN_COPILOT_SMOKE === '1') {
    console.log('Live smoke: concurrent conversations');
    await sendSyntheticPrompt();
    await tab('ticket_902').click();
    await sendSyntheticPrompt();
    await tab('ticket_901').click();
    await expect(page.locator('.message.agent')).toContainText('READY', { timeout: 120_000 });
    await expect(rail().getByRole('button', { name: /Conversation 1/ })).toBeVisible();
    const attachButtons = rail().getByRole('button', { name: /Attach/ });
    if (await attachButtons.count()) await expect(attachButtons.first()).toBeEnabled();
    await expect(tab('ticket_901').locator('.complete-icon')).toBeVisible({ timeout: 120_000 });
    await tab('ticket_902').click();
    await expect(page.locator('.message.agent')).toContainText('READY', { timeout: 120_000 });
    await expect(tab('ticket_902').locator('.complete-icon')).toBeVisible({ timeout: 120_000 });
    await expect(page.locator('.message.user')).toHaveCount(1);
    await tab('ticket_901').click();
    await expect(page.locator('.message.user')).toHaveCount(1);
  }
  await expect(tab('ticket_901')).toBeVisible();
  await page.locator('.ticket-tabs button[aria-label="Close ticket_902"]').click();
  await expect(tab('ticket_902')).toHaveCount(0);
  await expect(tab('ticket_901')).toHaveClass(/active/);
  await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
  await page.screenshot({ path: screenshotPath, fullPage: true });
  if (pageErrors.length) throw new AggregateError(pageErrors, 'Renderer had uncaught errors.');
  const quitDraft = `${localDraft}\nquit-flush-smoke\n`;
  await source().fill(quitDraft);
  await app.close();
  app = undefined;
  await waitForContents(markdownA, quitDraft);
  if (process.env.RUN_COPILOT_SMOKE === '1') {
    console.log('Live smoke: restoring conversation after app restart');
    app = await electron.launch({ executablePath: executable, args, cwd: repoRoot, env, timeout: 30_000 });
    page = await app.firstWindow();
    page.setDefaultTimeout(10_000);
    page.on('pageerror', (error) => pageErrors.push(error));
    await expect(source()).toHaveValue(quitDraft);
    await expect(page.locator('.message.user')).toHaveCount(1);
    await expect(page.locator('.message.agent')).toContainText('READY');
    await page.getByRole('textbox', { name: 'Message Copilot' }).fill('What exact readiness word did you reply earlier? Reply with that word only. Do not use tools.');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.locator('.message.agent')).toHaveCount(2, { timeout: 120_000 });
    await expect(page.locator('.message.agent').last()).toContainText('READY', { timeout: 120_000 });
    await expect(tab('ticket_901').locator('.complete-icon')).toBeVisible({ timeout: 120_000 });
    console.log('Live smoke: automatic file edit and modification banner');
    await page.evaluate(() => {
      globalThis.supportSmoke = { modifyingBanner: false, localApproval: false };
      new MutationObserver(() => {
        if (document.querySelector('.agent-banner')) globalThis.supportSmoke.modifyingBanner = true;
        if (document.querySelector('.approval-card')) globalThis.supportSmoke.localApproval = true;
      }).observe(document.body, { subtree: true, childList: true });
    });
    await page.getByRole('textbox', { name: 'Message Copilot' }).fill("Use apply_patch to append a paragraph with the exact text 'Copilot synthetic evidence.' to this ticket's main Markdown summary. Do not use shell commands or modify any other files. Reply EDITED when done.");
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(tab('ticket_901').locator('.complete-icon')).toBeVisible({ timeout: 120_000 });
    await expect.poll(() => fs.readFile(markdownA, 'utf8'), { timeout: 120_000 }).toContain('Copilot synthetic evidence.');
    await expect(source()).toHaveValue(/Copilot synthetic evidence\./);
    expect(await page.evaluate(() => globalThis.supportSmoke)).toEqual({ modifyingBanner: true, localApproval: false });
    if (pageErrors.length) throw new AggregateError(pageErrors, 'Renderer had uncaught errors.');
    await app.close();
    app = undefined;
  }
  await fs.writeFile(configFile, JSON.stringify({ chatSide: 'right', filesSide: 'left', filesHidden: false }));
  console.log('Desktop smoke: layout and last view after restart');
  app = await electron.launch({ executablePath: executable, args, cwd: repoRoot, env, timeout: 30_000 });
  page = await app.firstWindow();
  page.setDefaultTimeout(10_000);
  page.on('pageerror', (error) => pageErrors.push(error));
  await expect(tab('ticket_901')).toHaveClass(/active/);
  await expect(home()).toHaveCount(0);
  await expect(page.locator('.workspace-body > *').first()).toHaveClass(/files-rail/);
  await expect(page.locator('.workspace-body > *').last()).toHaveClass(/chat-panel/);
  await page.getByRole('button', { name: 'Layout menu' }).click();
  await page.getByRole('menuitem', { name: 'Chat on the left' }).click();
  await expect.poll(async () => JSON.parse(await fs.readFile(configFile, 'utf8')).chatSide).toBe('left');
  await page.getByRole('button', { name: 'Ticket menu' }).click();
  await page.getByRole('menuitem', { name: 'Home', exact: true }).click();
  await expect(home()).toBeVisible();
  await expect.poll(async () => JSON.parse(await fs.readFile(path.join(dataRoot, 'settings.json'), 'utf8')).lastTicketId).toBeNull();
  await app.close();
  app = undefined;
  succeeded = true;
  console.log(`Desktop smoke test passed. Screenshot: ${screenshotPath}`);
} catch (error) {
  console.error('Desktop smoke failed:', error);
  if (page) {
    console.error('Synthetic workspace state:', await page.evaluate(() => window.workspace.snapshot()).catch((cause) => String(cause)));
    await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: screenshotPath }).catch((cause) => console.error('Failure screenshot:', cause));
  }
  throw error;
} finally {
  if (app) {
    if (!succeeded && page) {
      await page.evaluate(async () => {
        const snapshot = await window.workspace.snapshot();
        if (snapshot.ok) for (const state of snapshot.value.sessions) {
          if (['starting', 'running', 'approval'].includes(state.activity)) await window.workspace.stop(state.ticketId);
        }
      }).catch((error) => console.error('Stop failed during cleanup:', error));
    }
    const close = app.close();
    const timer = setTimeout(() => {
      console.error('Smoke cleanup: terminating its specific Electron process', app.process().pid);
      app.process().kill();
    }, 20_000);
    await close.catch((error) => console.error('Smoke cleanup could not close the app:', error));
    clearTimeout(timer);
  }
  if (succeeded) await fs.rm(fixtureRoot, { recursive: true, force: true });
  else console.error(`Smoke fixture retained for diagnosis: ${fixtureRoot}`);
}
