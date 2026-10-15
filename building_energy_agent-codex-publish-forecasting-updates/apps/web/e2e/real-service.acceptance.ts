import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const serviceConfigured = Boolean(process.env.BE_E2E_BASE_URL);
const runCancellation = process.env.BE_E2E_RUN_CANCEL === 'true';
const runDynamicSkill = process.env.BE_E2E_RUN_DYNAMIC_SKILL === 'true';
const runWorkflows = process.env.BE_E2E_RUN_WORKFLOWS === 'true';
const runRestart = process.env.BE_E2E_RUN_RESTART === 'true';
const runHarness = process.env.BE_E2E_RUN_HARNESS === 'true';
const projectRoot = path.resolve(import.meta.dirname, '../../..');
const evidenceRoot = path.join(projectRoot, '.runtime/acceptance/browser');
const serviceOutput = new WeakMap<ChildProcessWithoutNullStreams, () => string>();
let isolatedSessionSequence = 0;

async function persistEvidence(name: string, payload: Record<string, unknown>) {
  await mkdir(evidenceRoot, { recursive: true });
  await writeFile(
    path.join(evidenceRoot, `${name}.json`),
    `${JSON.stringify({ generated_at: new Date().toISOString(), ...payload }, null, 2)}\n`,
    'utf8',
  );
}

async function captureEvidenceScreenshot(page: Page, name: string) {
  await mkdir(evidenceRoot, { recursive: true });
  await page.screenshot({ path: path.join(evidenceRoot, name), fullPage: false });
  return name;
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to allocate restart port');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function startService(
  port: number,
  runtimeRoot: string,
  entry = 'apps/server/dist/index.js',
) {
  const child = spawn(process.execPath, [entry], {
    cwd: projectRoot,
    env: {
      ...process.env,
      BE_HOST: '127.0.0.1',
      BE_PORT: String(port),
      BE_RUNTIME_ROOT: runtimeRoot,
    },
  });
  let output = '';
  serviceOutput.set(child, () => output);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`restart service timeout: ${output}`)),
      15_000,
    );
    const ready = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (!output.includes('"service":"building-energy-server"')) return;
      clearTimeout(timeout);
      resolve();
    };
    child.stdout.on('data', ready);
    child.stderr.on('data', (chunk) => {
      output += chunk.toString('utf8');
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`restart service exited early (${code}): ${output}`));
    });
  });
  return child;
}

async function stopService(child: ChildProcessWithoutNullStreams | undefined) {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await Promise.race([
    exited,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('restart service did not stop')), 15_000),
    ),
  ]);
}

function expectServiceRunning(child: ChildProcessWithoutNullStreams) {
  expect(child.exitCode, serviceOutput.get(child)?.()).toBeNull();
}

function observeBrowserProblems(page: Page) {
  const problems = {
    pageErrors: [] as string[],
    consoleErrors: [] as string[],
    requestFailures: [] as string[],
    httpErrors: [] as string[],
  };
  page.on('pageerror', (error) => problems.pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.consoleErrors.push(message.text());
  });
  page.on('requestfailed', (request) => {
    // Vite development mode mounts React StrictMode twice; the first boot
    // request is intentionally aborted during effect cleanup.
    if (request.failure()?.errorText === 'net::ERR_ABORTED' && request.url().includes('/api/v1/')) {
      return;
    }
    problems.requestFailures.push(
      `${request.method()} ${request.url()} ${request.failure()?.errorText}`,
    );
  });
  page.on('response', (response) => {
    if (response.status() >= 400) {
      problems.httpErrors.push(
        `${response.status()} ${response.request().method()} ${response.url()}`,
      );
    }
  });
  return problems;
}

function expectNoBrowserProblems(problems: ReturnType<typeof observeBrowserProblems>) {
  expect(problems.pageErrors).toEqual([]);
  expect(problems.consoleErrors).toEqual([]);
  expect(problems.requestFailures).toEqual([]);
  expect(problems.httpErrors).toEqual([]);
}

function displaySkillName(skillName: string): string {
  const labels: Record<string, string> = {
    'building-energy-data-parsing': '建筑能源数据解析',
    'building-energy-data-processing': '建筑能源预测数据处理',
    'building-energy-data-quality': '建筑能源数据质量评估',
    'building-energy-load-forecasting': '建筑能源负荷预测',
    'building-energy-report-generation': '建筑能源专业报表生成',
  };
  return labels[skillName] ?? '分析步骤';
}

const reasoningLabels: Record<string, string> = {
  minimal: '最小',
  low: '低',
  medium: '中等',
  high: '高',
  xhigh: '很高',
  max: '最大',
  ultra: '极高',
};

async function createIsolatedSession(
  request: APIRequestContext,
  title: string,
  model = 'gpt-5.6-sol',
  reasoningLevel = 'xhigh',
) {
  const created = await request.post('/api/v1/sessions', {
    headers: { 'idempotency-key': `e2e-session-${Date.now()}-${++isolatedSessionSequence}` },
    data: {
      api_version: '1.0',
      title,
      model,
      reasoning_level: reasoningLevel,
    },
  });
  expect(created.status()).toBe(201);
  return (await created.json()).session.session_id as string;
}

async function selectSessionItem(page: Page, title: string, waitForComposer = false) {
  const sessionItem = page
    .locator('#session-list .session-item')
    .filter({ has: page.locator('.session-select', { hasText: title }) });
  const select = sessionItem.locator('.session-select');
  await expect(select).toHaveCount(1);
  await select.click();
  await expect(page.locator('.session-heading strong')).toHaveText(title);
  if (waitForComposer) {
    await expect(page.getByLabel('输入建筑能源分析需求')).toBeEnabled();
  }
}

async function deleteIsolatedSession(request: APIRequestContext, sessionId: string) {
  const deleted = await request.delete(`/api/v1/sessions/${sessionId}`, {
    headers: { 'idempotency-key': `e2e-session-delete-${sessionId}` },
    data: { api_version: '1.0', confirm_session_id: sessionId },
  });
  expect(deleted.ok()).toBeTruthy();
}

async function assertResultDetails(
  page: Page,
  workflow: { resultHeading: string; secondaryResultHeading?: string },
  screenshotName?: string,
) {
  await page.setViewportSize({ width: 1440, height: 900 });
  const resultKind = workflow.resultHeading === '权威指标' ? 'forecast' : 'quality';
  const resultEntry = page
    .locator('.activity-inspector .result-list button')
    .filter({ has: page.locator(`.result-type.result-${resultKind}`) })
    .first();
  const activityPanel = page.locator('#activity-inspector');
  if ((await activityPanel.getAttribute('aria-hidden')) !== 'false') {
    await page.getByRole('button', { name: '打开业务上下文' }).click();
    await expect(activityPanel).toHaveAttribute('aria-hidden', 'false');
  }
  await expect(resultEntry).toBeVisible();
  await resultEntry.click();

  const panel = page.locator('.result-details-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('status', { name: '结果状态' })).toContainText(/已验证|部分完成/);
  await expect(panel.getByRole('tab', { name: '报告与文件' })).toBeVisible();

  if (workflow.resultHeading === '六维结果') {
    await expect(panel.getByRole('tab', { name: '数据质量' })).toBeVisible();
    await panel.getByRole('tab', { name: '数据质量' }).click();
    await expect(panel.getByRole('heading', { name: '六维结果' })).toBeVisible();
  }
  if (workflow.resultHeading === '权威指标') {
    await expect(panel.getByRole('tab', { name: '负荷预测' })).toBeVisible();
    await panel.getByRole('tab', { name: '负荷预测' }).click();
    await expect(panel.getByRole('heading', { name: '权威指标' }).first()).toBeVisible();
  }
  if (workflow.secondaryResultHeading === '权威指标') {
    await panel.getByRole('tab', { name: '负荷预测' }).click();
    await expect(panel.getByRole('heading', { name: '权威指标' }).first()).toBeVisible();
  }

  await panel.getByRole('tab', { name: '报告与文件' }).click();
  await expect(panel.getByRole('heading', { name: '报告与受控文件' })).toBeVisible();
  await expect(panel.getByRole('link', { name: /^下载 / }).first()).toBeVisible();

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(resultEntry).toBeFocused();
  await resultEntry.click();
  await expect(panel).toBeVisible();

  await page.locator('.result-modal-backdrop').click({ position: { x: 4, y: 4 } });
  await expect(panel).toBeHidden();
  await resultEntry.click();
  await expect(panel).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(resultEntry).toBeFocused();

  if (screenshotName) {
    await page.setViewportSize({ width: 1080, height: 900 });
    await captureEvidenceScreenshot(page, screenshotName);
  }

  await page.setViewportSize({ width: 900, height: 800 });
  await expect(activityPanel).toHaveAttribute('aria-hidden', 'true');
  const activityTrigger = page.getByRole('button', { name: '打开业务上下文' });
  await activityTrigger.click();
  const activityDialog = page.getByRole('dialog', { name: '业务上下文' });
  await expect(activityDialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(activityDialog).toBeHidden();
  await expect(activityTrigger).toBeFocused();

  await page.setViewportSize({ width: 390, height: 844 });
  await activityTrigger.click();
  await expect(activityDialog).toBeVisible();
  const contextResult = activityDialog.getByRole('button', { name: /查看 .*的专业详情/ }).first();
  await expect(contextResult).toBeVisible();
  await contextResult.click();
  await expect(panel).toBeVisible();
  const viewportOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  expect(viewportOverflow).toBe(false);
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(activityDialog).toBeVisible();
  await expect(contextResult).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(activityDialog).toBeHidden();
  await expect(activityTrigger).toBeFocused();
}

test.describe('already-running real Building Energy Codex service', () => {
  test.skip(
    !serviceConfigured,
    'Set BE_E2E_BASE_URL to an already-running service; no API or SSE mocks are used.',
  );

  test('loads the contract-backed workspace without browser errors', async ({ page, request }) => {
    const problems = observeBrowserProblems(page);
    const title = `空白工作区验收 ${Date.now()}`;
    const sessionId = await createIsolatedSession(request, title);

    try {
      const health = await request.get('/api/v1/health');
      expect(health.ok()).toBeTruthy();
      expect(await health.json()).toMatchObject({ api_version: '1.0' });

      await page.goto('/');
      await selectSessionItem(page, title, true);
      await expect(page).toHaveTitle('EnergiAI｜建筑能源专业智能体');
      await expect(page.locator('#main-content')).toBeVisible();
      await expect(page.getByLabel('输入建筑能源分析需求')).toBeVisible();
      await expect(page.getByLabel('业务任务入口').locator('.task-entry-card')).toHaveCount(3);
      await expect(page.getByRole('button', { name: '业务上下文' })).toBeVisible();
      await expect(page.getByRole('button', { name: /模型设置：/ })).toBeVisible();
      expectNoBrowserProblems(problems);
    } finally {
      await deleteIsolatedSession(request, sessionId);
    }
  });

  test('keeps a professional preset local until an uploaded file is available', async ({
    page,
    request,
  }) => {
    const title = `专业文件门禁 ${Date.now()}`;
    const sessionId = await createIsolatedSession(request, title);

    try {
      await page.goto('/');
      await selectSessionItem(page, title);
      await page
        .getByLabel('业务任务入口')
        .getByRole('button', { name: '数据质量评估', exact: true })
        .click();
      await page.getByRole('button', { name: '发送消息', exact: true }).click();
      await expect(
        page.getByText('请先添加 XLSX、XLSM 或 CSV 数据文件，再启动专业分析。'),
      ).toBeVisible();

      const detail = await request.get(`/api/v1/sessions/${sessionId}`);
      expect(detail.ok()).toBeTruthy();
      expect((await detail.json()).turns).toHaveLength(0);
    } finally {
      await deleteIsolatedSession(request, sessionId);
    }
  });

  test('persists the composer model selection before the first turn', async ({ page, request }) => {
    const problems = observeBrowserProblems(page);
    const modelsResponse = await request.get('/api/v1/models');
    expect(modelsResponse.ok()).toBeTruthy();
    const catalog = (await modelsResponse.json()).models as Array<{
      id: string;
      display_name: string;
      reasoning_levels: string[];
      default_reasoning_level: string;
      availability: string;
    }>;
    const available = catalog.filter((model) => model.availability === 'available');
    test.skip(available.length < 2, '需要至少两个可用模型才能验证切换');
    const source = available[0]!;
    const target = available[1]!;
    const title = `模型切换验收 ${Date.now()}`;
    const sessionId = await createIsolatedSession(
      request,
      title,
      source.id,
      source.default_reasoning_level,
    );

    try {
      await page.goto('/');
      await selectSessionItem(page, title);
      const modelTrigger = page.getByRole('button', { name: /模型设置：/ });
      await expect(modelTrigger).toHaveAttribute(
        'aria-label',
        expect.stringContaining(source.display_name),
      );

      await modelTrigger.click();
      await page.getByRole('menuitemradio', { name: target.display_name, exact: true }).click();
      await expect
        .poll(
          async () =>
            (await (await request.get(`/api/v1/sessions/${sessionId}`)).json()).session.model,
        )
        .toBe(target.id);
      await expect(modelTrigger).toHaveAttribute(
        'aria-label',
        expect.stringContaining(target.display_name),
      );

      const reasoning =
        target.reasoning_levels.find((level) => level !== source.default_reasoning_level) ??
        target.reasoning_levels[0]!;
      await modelTrigger.click();
      await page
        .getByRole('menuitemradio', { name: reasoningLabels[reasoning], exact: true })
        .click();
      await expect
        .poll(
          async () =>
            (await (await request.get(`/api/v1/sessions/${sessionId}`)).json()).session
              .reasoning_level,
        )
        .toBe(reasoning);
      expectNoBrowserProblems(problems);
    } finally {
      await deleteIsolatedSession(request, sessionId);
    }
  });

  test('keeps one accessible shell across desktop, tablet, and small-screen drawers', async ({
    page,
    request,
  }) => {
    const problems = observeBrowserProblems(page);
    const title = `响应式抽屉验收 ${Date.now()}`;
    const sessionId = await createIsolatedSession(request, title);

    try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await selectSessionItem(page, title);
    await expect(page.locator('#session-rail')).toBeVisible();
    await expect(page.locator('#activity-inspector')).toBeVisible();
    await expect(page.locator('#session-rail')).toHaveCount(1);
    await expect(page.locator('#activity-inspector')).toHaveCount(1);
    await expect(page.locator('#main-content')).toHaveCount(1);

    await page.setViewportSize({ width: 900, height: 800 });
    await expect(page.locator('#session-rail')).toBeVisible();
    await expect(page.locator('#activity-inspector')).toHaveAttribute('aria-hidden', 'true');
    await expect(page.locator('#activity-inspector')).toHaveAttribute('inert', '');
    const activityTrigger = page.getByRole('button', { name: '打开业务上下文' });
    await activityTrigger.click();
    const activityDialog = page.getByRole('dialog', { name: '业务上下文' });
    await expect(activityDialog).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => document.activeElement?.closest('#activity-inspector') !== null),
      )
      .toBe(true);
    await page.keyboard.press('Escape');
    await expect(activityDialog).toBeHidden();
    await expect(activityTrigger).toBeFocused();

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('#session-rail')).toHaveAttribute('aria-hidden', 'true');
    await expect(page.locator('#session-rail')).toHaveAttribute('inert', '');
    const sessionTrigger = page.getByRole('button', { name: '打开会话列表' });
    await sessionTrigger.click();
    const sessionDialog = page.getByRole('dialog', { name: '会话导航' });
    await expect(sessionDialog).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.closest('#session-rail') !== null))
      .toBe(true);
    await page.keyboard.press('Escape');
    await expect(sessionDialog).toBeHidden();
    await expect(sessionTrigger).toBeFocused();

    await page.emulateMedia({ reducedMotion: 'reduce' });
    const transitionDuration = await page
      .locator('#session-rail')
      .evaluate((element) => getComputedStyle(element).transitionDuration);
    expect(Number.parseFloat(transitionDuration)).toBeLessThanOrEqual(0.001);
    expectNoBrowserProblems(problems);
    } finally {
      await deleteIsolatedSession(request, sessionId);
    }
  });

  test('saves explicit phase-seven responsive shell screenshots', async ({ page, request }) => {
    const problems = observeBrowserProblems(page);
    const title = `响应式截图验收 ${Date.now()}`;
    const sessionId = await createIsolatedSession(request, title);
    const screenshots: string[] = [];
    const viewports = [
      { width: 1440, height: 900, name: 'phase7-empty-1440.png' },
      { width: 1200, height: 900, name: 'phase7-shell-1200.png' },
      { width: 1080, height: 900, name: 'phase7-shell-1080.png' },
      { width: 760, height: 900, name: 'phase7-shell-760.png' },
    ];

    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto('/');
      await selectSessionItem(page, title);

    for (const viewport of viewports) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await expect(page.locator('#main-content')).toBeVisible();
      const viewportOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      expect(viewportOverflow).toBe(false);
      screenshots.push(await captureEvidenceScreenshot(page, viewport.name));
    }

    expectNoBrowserProblems(problems);
    await persistEvidence('phase7-responsive-shell', {
      acceptance: 'passed',
      screenshots,
      states: {
        empty: 'phase7-empty-1440.png',
        shell: ['phase7-shell-1200.png', 'phase7-shell-1080.png', 'phase7-shell-760.png'],
      },
      browser_problems: problems,
    });
    } finally {
      await deleteIsolatedSession(request, sessionId);
    }
  });

  test('restores the latest session after refresh and reconnects its real SSE stream', async ({
    page,
    request,
  }) => {
    const title = `刷新与重连验收 ${Date.now()}`;
    const sessionId = await createIsolatedSession(request, title);

    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto('/');
      await selectSessionItem(page, title);
      await expect(page.locator('#activity-inspector')).toHaveCount(1);

      await page.reload();
      await expect(page.locator('.session-heading strong')).toHaveText(title);
      await expect(page.locator('#activity-inspector')).toHaveCount(1);

      const eventsPattern = '**/api/v1/sessions/*/events*';
      let markAborted: (() => void) | undefined;
      let eventRequestCount = 0;
      const firstAbort = new Promise<void>((resolve) => {
        markAborted = resolve;
      });
      await page.route(eventsPattern, async (route) => {
        eventRequestCount += 1;
        if (eventRequestCount === 1) {
          markAborted?.();
          await route.abort('connectionreset');
          return;
        }
        await route.continue();
      });
      await page.reload();
      await firstAbort;
      await expect.poll(() => eventRequestCount).toBeGreaterThanOrEqual(2);
      await page.unroute(eventsPattern);
      await expect(page.locator('#session-rail')).toHaveCount(1);
      await expect(page.locator('#activity-inspector')).toHaveCount(1);
    } finally {
      await deleteIsolatedSession(request, sessionId);
    }
  });

  test('renames, archives, and restores a real session through the business shell', async ({
    page,
    request,
  }) => {
    const problems = observeBrowserProblems(page);
    const initialTitle = `会话生命周期验收 ${Date.now()}`;
    const renamedTitle = `${initialTitle}（已重命名）`;
    const sessionId = await createIsolatedSession(request, initialTitle);

    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto('/');
      await selectSessionItem(page, initialTitle);

      await page.getByRole('button', { name: '重命名当前会话' }).click();
      await page.getByRole('textbox', { name: '会话名称' }).fill(renamedTitle);
      await page.getByRole('button', { name: '保存会话名称' }).click();
      await expect(page.locator('.session-heading strong')).toHaveText(renamedTitle);
      await expect
        .poll(async () => {
          const detail = await request.get(`/api/v1/sessions/${sessionId}`);
          return (await detail.json()).session.title as string;
        })
        .toBe(renamedTitle);

      await page.getByRole('button', { name: '归档当前会话' }).click();
      await expect(page.getByText('该会话已归档')).toBeVisible();
      await expect(page.getByLabel('输入建筑能源分析需求')).toBeDisabled();
      await expect(page.getByRole('button', { name: '恢复会话' })).toBeVisible();
      await expect
        .poll(async () => {
          const archived = await request.get('/api/v1/sessions?archived=true');
          return (await archived.json()).sessions.some(
            (session: { session_id: string }) => session.session_id === sessionId,
          );
        })
        .toBe(true);

      await page.getByRole('button', { name: '恢复会话' }).click();
      await expect(page.getByLabel('输入建筑能源分析需求')).toBeEnabled();
      await expect
        .poll(async () => {
          const active = await request.get('/api/v1/sessions');
          return (await active.json()).sessions.some(
            (session: { session_id: string }) => session.session_id === sessionId,
          );
        })
        .toBe(true);
      expectNoBrowserProblems(problems);
    } finally {
      await deleteIsolatedSession(request, sessionId);
    }
  });

  const restartTest = runRestart ? test : test.skip;
  restartTest(
    'restores a persisted session and SSE after a real server restart',
    async ({ page, request }) => {
      const runtimeRoot = await mkdtemp(path.join(tmpdir(), 'be-restart-e2e-'));
      const port = await availablePort();
      const baseUrl = `http://127.0.0.1:${port}`;
      const title = `服务重启验收 ${Date.now()}`;
      let service: ChildProcessWithoutNullStreams | undefined;
      let sessionId: string | undefined;

      try {
        service = await startService(port, runtimeRoot);
        const created = await request.post(`${baseUrl}/api/v1/sessions`, {
          headers: { 'idempotency-key': `restart-create-${Date.now()}` },
          data: {
            api_version: '1.0',
            title,
            model: 'gpt-5.6-sol',
            reasoning_level: 'xhigh',
          },
        });
        expect(created.status()).toBe(201);
        sessionId = (await created.json()).session.session_id as string;

        await page.goto(baseUrl);
        await expect(page.locator('.session-heading strong')).toHaveText(title);
        await expect(page.locator('#activity-inspector')).toHaveCount(1);

        await stopService(service);
        service = undefined;
        service = await startService(port, runtimeRoot);
        expectServiceRunning(service);

        await page.reload();
        expectServiceRunning(service);
        await expect(page.locator('.session-heading strong')).toHaveText(title);
        await expect(page.locator('#activity-inspector')).toHaveCount(1);
        const detail = await request.get(`${baseUrl}/api/v1/sessions/${sessionId}`);
        expect(detail.ok()).toBeTruthy();
        expect((await detail.json()).session.title).toBe(title);
      } finally {
        if (service?.exitCode === null && sessionId) {
          await request.delete(`${baseUrl}/api/v1/sessions/${sessionId}`, {
            headers: { 'idempotency-key': `restart-delete-${sessionId}` },
            data: { api_version: '1.0', confirm_session_id: sessionId },
          });
        }
        await stopService(service);
        await rm(runtimeRoot, { recursive: true, force: true });
      }
    },
  );

  const harnessTest = runHarness ? test : test.skip;
  harnessTest(
    'persists a multi-question draft across restart and resumes the same thread',
    async ({ page, request }) => {
      const runtimeRoot = await mkdtemp(path.join(tmpdir(), 'be-questions-e2e-'));
      const port = await availablePort();
      const baseUrl = `http://127.0.0.1:${port}`;
      const entry = 'apps/server/scripts/acceptance-harness.mjs';
      let service: ChildProcessWithoutNullStreams | undefined;
      let sessionId: string | undefined;

      try {
        service = await startService(port, runtimeRoot, entry);
        await page.goto(baseUrl);
        await page.getByLabel('输入建筑能源分析需求').fill('请检查输入并提出所有当前阻塞问题。');
        await page.getByRole('button', { name: '发送消息' }).click();

        await expect(page.getByRole('heading', { name: '需要确认', exact: true })).toBeVisible();
        await expect(page.getByText('第 1 / 2 项', { exact: true })).toBeVisible();
        await expect(page.getByText('这份数据使用哪个时区？')).toBeVisible();
        await page.getByRole('radio', { name: 'Asia/Shanghai' }).check();
        await expect(page.getByText('草稿已保存')).toBeVisible();
        await page.getByRole('button', { name: '下一项', exact: true }).click();
        await expect(page.getByText('第 2 / 2 项', { exact: true })).toBeVisible();
        await expect(page.getByText('要分析哪个目标测点？')).toBeVisible();
        await page.getByRole('radio', { name: '自行输入' }).check();
        await page.getByLabel('你的回答').fill('main_load');
        await expect(page.getByText('草稿已保存')).toBeVisible();
        sessionId = (
          await request.get(`${baseUrl}/api/v1/sessions`).then((response) => response.json())
        ).sessions[0].session_id as string;

        await stopService(service);
        service = undefined;
        service = await startService(port, runtimeRoot, entry);
        await page.reload();

        await expect(page.getByRole('heading', { name: '需要确认', exact: true })).toBeVisible();
        await expect(page.getByText('第 2 / 2 项', { exact: true })).toBeVisible();
        await expect(page.getByRole('radio', { name: '自行输入' })).toBeChecked();
        await expect(page.getByLabel('你的回答')).toHaveValue('main_load');
        await page.getByRole('button', { name: '上一项', exact: true }).click();
        await expect(page.getByText('第 1 / 2 项', { exact: true })).toBeVisible();
        await expect(page.getByRole('radio', { name: 'Asia/Shanghai' })).toBeChecked();
        await page.getByRole('button', { name: '下一项', exact: true }).click();
        await page.getByRole('button', { name: '提交并继续' }).click();

        await expect(
          page.getByText('问题组回答已在同一 Codex thread 中恢复并完成。'),
        ).toBeVisible();
        await expect(page.getByRole('heading', { name: '需要确认', exact: true })).toHaveCount(0);
        const detail = await request.get(`${baseUrl}/api/v1/sessions/${sessionId}`);
        expect(detail.ok()).toBeTruthy();
        const resumed = (await detail.json()) as {
          turns: Array<{ turn_id: string; status: string }>;
          pending_question_set?: unknown;
        };
        expect(resumed.pending_question_set).toBeUndefined();
        expect(resumed.turns).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ status: 'needs_input' }),
            expect.objectContaining({ status: 'completed' }),
          ]),
        );
      } finally {
        if (service?.exitCode === null && sessionId) {
          await request.delete(`${baseUrl}/api/v1/sessions/${sessionId}`, {
            headers: { 'idempotency-key': `questions-delete-${sessionId}` },
            data: { api_version: '1.0', confirm_session_id: sessionId },
          });
        }
        await stopService(service);
        await rm(runtimeRoot, { recursive: true, force: true });
      }
    },
  );

  const cancellationTest = runCancellation ? test : test.skip;
  cancellationTest(
    'confirms real cancellation and locks model controls after the first turn',
    async ({ page, request }) => {
      const problems = observeBrowserProblems(page);
      const title = `取消验收 ${Date.now()}`;
      const sessionId = await createIsolatedSession(request, title);

      try {
      await page.goto('/');
      await selectSessionItem(page, title, true);
      await page
        .getByLabel('上传数据文件', { exact: true })
        .setInputFiles(path.join(projectRoot, 'test-data/e2e/three-workflows-v2.xlsx'));
      await page
        .getByLabel('输入建筑能源分析需求')
        .fill('解析这份建筑能源工作簿，并报告可验证的输入摘要；时区 Asia/Shanghai。');
      await page.getByRole('button', { name: '发送消息' }).click();

      await expect(page.locator('.task-plan-card')).toBeVisible({ timeout: 60_000 });
      await expect(page.getByRole('button', { name: /模型设置：/ })).toBeDisabled();
      await expect(page.getByRole('button', { name: '取消任务' })).toBeVisible();
      await page.getByRole('button', { name: '取消任务' }).click();
      await expect(page.getByText('已取消').first()).toBeVisible({ timeout: 60_000 });
      await expect(page.getByRole('button', { name: '取消任务' })).toHaveCount(0);
      await expect(page.locator('.plan-node.status-running')).toHaveCount(0);
      expectNoBrowserProblems(problems);
      await persistEvidence('real-skill-cancellation', {
        acceptance: 'passed',
        turn_active_before_cancel: true,
        final_turn_status: 'cancelled',
        browser_problems: problems,
      });
      } finally {
        await deleteIsolatedSession(request, sessionId);
      }
    },
  );

  const workflowTest = runWorkflows ? test : test.skip;
  const workflowCases = [
    {
      name: 'processing-to-forecast',
      prompt:
        '解析并处理上传数据，然后仅完成未来 24 小时负荷预测。目标点位是 HE1.C|1226000，时区 Asia/Shanghai；不要运行数据质量分支。只展示校验通过的真实结果和 Artifact。',
      artifactTypes: [
        'DatasetBundle',
        'ProcessingBundle',
        'ModelBundle',
        'EvaluationBundle',
        'ForecastBundle',
      ],
      skills: [
        'building-energy-data-parsing',
        'building-energy-data-processing',
        'building-energy-load-forecasting',
      ],
      resultHeading: '权威指标',
    },
    {
      name: 'processing-to-quality',
      prompt:
        '解析上传数据，然后仅完成只读数据质量评估。目标点位是 HE1.C|1226000，时区 Asia/Shanghai；不要运行预测分支。只展示校验通过的真实结果和 Artifact。',
      artifactTypes: ['DatasetBundle', 'QualityAssessmentBundle'],
      skills: ['building-energy-data-parsing', 'building-energy-data-quality'],
      resultHeading: '六维结果',
    },
    {
      name: 'integrated-parallel',
      prompt:
        '完成综合分析：解析数据后并行运行只读质量评估与处理/未来 24 小时负荷预测。目标点位是 HE1.C|1226000，时区 Asia/Shanghai。只展示校验通过的真实结果和 Artifact。',
      artifactTypes: [
        'DatasetBundle',
        'ProcessingBundle',
        'QualityAssessmentBundle',
        'ModelBundle',
        'EvaluationBundle',
        'ForecastBundle',
      ],
      skills: [
        'building-energy-data-parsing',
        'building-energy-data-processing',
        'building-energy-data-quality',
        'building-energy-load-forecasting',
      ],
      resultHeading: '六维结果',
      secondaryResultHeading: '权威指标',
    },
  ] as const;

  for (const workflow of workflowCases) {
    workflowTest(
      `runs ${workflow.name} to consistent validated artifacts`,
      async ({ page, request }) => {
        test.setTimeout(45 * 60 * 1_000);
        const problems = observeBrowserProblems(page);
        let sessionId: string | undefined;
        const title = `工作流验收 ${workflow.name} ${Date.now()}`;

        try {
          sessionId = await createIsolatedSession(request, title);
          const doctorResponse = await request.get('/api/v1/doctor');
          const doctor = (await doctorResponse.json()) as {
            checks?: Array<{
              name: string;
              status: string;
              capability_summary?: string;
              recovery_command?: string;
            }>;
          };
          const sandbox = doctor.checks?.find((check) => check.name === 'codex-sandbox');
          if (sandbox?.status !== 'ready') {
            if (workflow.name === 'integrated-parallel') {
              await page.setViewportSize({ width: 1200, height: 900 });
              await page.goto('/');
              await selectSessionItem(page, title, true);
              const executionScreenshot = await captureEvidenceScreenshot(
                page,
                'phase7-execution-dependency-missing-1200.png',
              );
              await page.setViewportSize({ width: 1080, height: 900 });
              const resultScreenshot = await captureEvidenceScreenshot(
                page,
                'phase7-result-details-dependency-missing-1080.png',
              );
              await persistEvidence(`workflow-${workflow.name}`, {
                acceptance: 'DEPENDENCY_MISSING',
                blocked_by: sandbox ?? { name: 'codex-sandbox', status: 'unknown' },
                screenshots: [executionScreenshot, resultScreenshot],
                note: '真实工作流未进入 TaskPlan/Artifact 终态；截图仅记录依赖缺失时的业务壳层，不代表执行态或结果详情成功。',
                browser_problems: problems,
              });
            }
            test.skip(
              true,
              `DEPENDENCY_MISSING: ${sandbox?.capability_summary ?? 'codex-sandbox 未就绪'}`,
            );
          }

          await page.setViewportSize({ width: 1200, height: 900 });
          await page.goto('/');
          await selectSessionItem(page, title, true);
          await page
            .getByLabel('上传数据文件', { exact: true })
            .setInputFiles(path.join(projectRoot, 'test-data/e2e/three-workflows-v2.xlsx'));
          await page.getByLabel('输入建筑能源分析需求').fill(workflow.prompt);
          await page.getByRole('button', { name: '发送消息', exact: true }).click();

          const latestPlan = page.locator('.task-plan-card').last();
          await expect(latestPlan).toBeVisible({ timeout: 30_000 });
          const executionScreenshot = await captureEvidenceScreenshot(
            page,
            `phase7-execution-${workflow.name}-1200.png`,
          );
          await expect(
            page.locator(
              '.task-plan-card[data-plan-status="partial"], .completed-plan-card',
            ).last(),
          ).toBeVisible({
            timeout: 40 * 60 * 1_000,
          });
          await expect(page.locator('.plan-node.status-running')).toHaveCount(0);
          await expect(page.locator('.plan-node.status-pending')).toHaveCount(0);

          await page.locator('.completed-plan-card > summary').last().click();
          for (const skillName of workflow.skills) {
            await expect(
              page.locator('.plan-node-name').filter({ hasText: displaySkillName(skillName) }).first(),
            ).toBeVisible();
          }
          await assertResultDetails(
            page,
            workflow,
            `phase7-result-details-${workflow.name}-1080.png`,
          );

          const detailResponse = await request.get(`/api/v1/sessions/${sessionId}`);
          expect(detailResponse.ok()).toBeTruthy();
          const detail = (await detailResponse.json()) as {
            session: { status: string };
            turns: Array<{ status: string }>;
            artifacts: Array<{ artifact_type: string; status: string }>;
            skill_jobs: Array<{ skill_name: string; status: string }>;
          };
          expect(['idle', 'completed', 'partial']).toContain(detail.session.status);
          expect(['completed', 'partial']).toContain(detail.turns.at(-1)?.status);
          for (const artifactType of workflow.artifactTypes) {
            expect(detail.artifacts).toContainEqual(
              expect.objectContaining({ artifact_type: artifactType, status: 'succeeded' }),
            );
          }
          expect(
            detail.skill_jobs.every((job) => ['succeeded', 'partial'].includes(job.status)),
          ).toBe(true);
          for (const skillName of workflow.skills) {
            expect(detail.skill_jobs).toContainEqual(
              expect.objectContaining({ skill_name: skillName, status: 'succeeded' }),
            );
          }
          expectNoBrowserProblems(problems);
          await persistEvidence(`workflow-${workflow.name}`, {
            acceptance: 'passed',
            session_status: detail.session.status,
            turn_statuses: detail.turns.map((turn) => turn.status),
            artifacts: detail.artifacts.map((artifact) => ({
              artifact_type: artifact.artifact_type,
              status: artifact.status,
            })),
            expected_skills: workflow.skills,
            skill_jobs: detail.skill_jobs,
            screenshots: [executionScreenshot, `phase7-result-details-${workflow.name}-1080.png`],
            browser_problems: problems,
          });
        } finally {
          if (sessionId) {
            const deleted = await request.delete(`/api/v1/sessions/${sessionId}`, {
              headers: { 'idempotency-key': `workflow-delete-${sessionId}` },
              data: { api_version: '1.0', confirm_session_id: sessionId },
            });
            expect(deleted.ok()).toBeTruthy();
          }
        }
      },
    );
  }

  const dynamicSkillTest = runDynamicSkill ? test : test.skip;
  dynamicSkillTest(
    'discovers and executes a newly installed project Skill without a backend branch',
    async ({ page, request }) => {
      test.setTimeout(10 * 60 * 1_000);
      const problems = observeBrowserProblems(page);
      let sessionId: string | undefined;
      const title = `动态 Skill 验收 ${Date.now()}`;

      try {
        sessionId = await createIsolatedSession(request, title);
        await page.goto('/');
        await selectSessionItem(page, title);
        await page
          .getByLabel('输入建筑能源分析需求')
          .fill(
            '请显式使用 building-energy-dynamic-proof 项目 Skill，生成动态 Skill 架构证明 Artifact；不要运行其他 Skill。',
          );
        await page.getByRole('button', { name: '发送消息', exact: true }).click();
        const latestTurn = page.locator('.turn-block').last();
        await expect(latestTurn.locator('.status-completed')).toBeVisible({ timeout: 8 * 60_000 });
        await expect(
          page.locator('.artifact-group-head').filter({ hasText: 'dynamic-skill-proof' }),
        ).toBeVisible();
        await expect(
          page.locator('.artifact-group-head').filter({ hasText: '分析步骤' }),
        ).toBeVisible();
        await expect(page.getByRole('link', { name: '下载 result.json' })).toBeVisible();
        await expect(page.locator('.plan-node.status-running')).toHaveCount(0);

        const detail = await request.get(`/api/v1/sessions/${sessionId}`);
        expect(detail.ok()).toBeTruthy();
        const detailBody = await detail.json();
        expect(detailBody.artifacts).toContainEqual(
          expect.objectContaining({ artifact_type: 'dynamic-skill-proof', status: 'succeeded' }),
        );
        expect(detailBody.skill_jobs).toContainEqual(
          expect.objectContaining({
            skill_name: 'building-energy-dynamic-proof',
            status: 'succeeded',
          }),
        );
        expectNoBrowserProblems(problems);
        await persistEvidence('dynamic-skill', {
          acceptance: 'passed',
          artifact_type: 'dynamic-skill-proof',
          skill_name: 'building-energy-dynamic-proof',
          browser_problems: problems,
        });
      } finally {
        if (sessionId) {
          const deleted = await request.delete(`/api/v1/sessions/${sessionId}`, {
            headers: { 'idempotency-key': `dynamic-delete-${sessionId}` },
            data: { api_version: '1.0', confirm_session_id: sessionId },
          });
          expect(deleted.ok()).toBeTruthy();
        }
      }
    },
  );
});
