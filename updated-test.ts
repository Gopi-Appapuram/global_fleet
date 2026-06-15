import { test, Page } from '@playwright/test';

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

type Handle = {
  x: number;
  y: number;
};
type NodeHandles = {
  top: Handle;
  bottom: Handle;
  left: Handle;
  right: Handle;
};
type CanvasNode = {
  id: number;
  type: string;
  name: string;
  uiName: string;
  hoverX: number;
  hoverY: number;
  handles: NodeHandles;
};
type Seed = {
  type: string;
  hoverX: number;
  hoverY: number;
  minSX: number;
  maxSX: number;
  minSY: number;
  maxSY: number;
};
type Cluster = {
  sx: number;
  sy: number;
  w: number;
  h: number;
  cnt: number;
};
type CanvasConnector = {
  connectNodes: (from: string | number, to: string | number, fromEdge?: string, toEdge?: string) => Promise<boolean>;
  redetectNodes: () => Promise<CanvasNode[]>;
};

// ═══════════════════════════════════════════════════════════════════
// CANVAS CONNECTOR
// ═══════════════════════════════════════════════════════════════════

async function createCanvasConnector(page: Page): Promise<CanvasConnector> {
  let nodes: CanvasNode[] = [];
  let initialized = false;

  // ── Live canvas rect ──────────────────────────────────────────────
  async function getCanvasRect() {
    return page.evaluate(() => {
      const c = document.querySelector('canvas') as HTMLCanvasElement;
      const r = c.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height, cw: c.width, ch: c.height };
    });
  }

  // ── Ensure horizontal layout ──────────────────────────────────────
  // The "Change layout" button is a toggle:
  //   • When VERTICAL layout is active   → button shows horizontal icon (path starts "M24,18")  → click to switch
  //   • When HORIZONTAL layout is active → button shows vertical icon   (path starts "M30,15")  → already correct
  async function ensureHorizontalLayout(): Promise<void> {
    const isHorizontal = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button[title="Change layout"]'));
      for (const btn of buttons) {
        const path = btn.querySelector('svg path')?.getAttribute('d') || '';
        if (path.startsWith('M30,15')) return true;  // vertical icon shown → already in horizontal mode
        if (path.startsWith('M24,18')) return false; // horizontal icon shown → currently in vertical mode
      }
      return null; // button not found
    });

    if (isHorizontal === null) {
      console.log('   ⚠️  Layout button not found — skipping layout check');
      return;
    }
    if (isHorizontal) {
      console.log('   ✅ Already in horizontal layout');
      return;
    }

    console.log('   🔄 Switching to horizontal layout...');
    await page.click('button[title="Change layout"]');
    await page.waitForTimeout(800);
    console.log('   ✅ Switched to horizontal layout');
  }

  // ── Click "Fit to screen" / center button if available ───────────
  // Many canvas tools expose a fit/center button; clicking it avoids
  // manual panning and guarantees all nodes are visible at once.
  async function tryCenterCanvas(): Promise<boolean> {
    // Common selectors for fit-to-view / center buttons
    const selectors = [
      'button[title="Fit to screen"]',
      'button[title="Fit view"]',
      'button[title="Fit to view"]',
      'button[title="Center"]',
      'button[aria-label="Fit to screen"]',
      'button[aria-label="Fit view"]',
      '[data-testid="fit-view-button"]',
      '[data-testid="center-button"]',
    ];

    for (const sel of selectors) {
      const found = await page.$(sel);
      if (found) {
        console.log(`   🎯 Found center button (${sel}) — clicking to fit all nodes into view`);
        await page.click(sel);
        await page.waitForTimeout(600);
        return true;
      }
    }

    // Fallback: try keyboard shortcut Ctrl+Shift+H (common in flow editors)
    const beforeSeeds = await findSeeds();
    await page.keyboard.press('Control+Shift+H');
    await page.waitForTimeout(500);
    const afterSeeds = await findSeeds();
    if (afterSeeds.length > beforeSeeds.length) {
      console.log('   🎯 Ctrl+Shift+H brought more nodes into view');
      return true;
    }

    return false;
  }

  // ── Click+hold, drag, release ─────────────────────────────────────
  async function pan(dragX: number, dragY: number): Promise<void> {
    const cr = await getCanvasRect();
    const startX = cr.left + 20;
    const startY = cr.top + cr.height * 0.85;

    await page.mouse.move(startX, startY);
    await page.waitForTimeout(100);
    await page.mouse.down();
    await page.waitForTimeout(100);

    const steps = 25;
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(startX + (dragX * i) / steps, startY + (dragY * i) / steps);
      await page.waitForTimeout(16);
    }

    await page.mouse.up();
    await page.waitForTimeout(300);
  }

  // ── Bring all nodes into view via center button or pan ────────────
  async function bringAllNodesIntoView(expectedCount: number): Promise<void> {
    if ((await findSeeds()).length >= expectedCount) return;

    console.log(`   🔍 ${(await findSeeds()).length}/${expectedCount} seeds — attempting to bring all nodes into view...`);

    // First attempt: use the fit/center button (no mouse handling needed)
    const centered = await tryCenterCanvas();
    if (centered) {
      const count = (await findSeeds()).length;
      console.log(`   🎯 After centering: ${count}/${expectedCount} seeds visible`);
      if (count >= expectedCount) {
        console.log(`   ✅ All ${expectedCount} nodes in view via center button`);
        return;
      }
    }

    // Fallback: manual pan sequence
    console.log(`   🖱️  Falling back to manual pan...`);
    const cr = await getCanvasRect();

    const panSequence: [number, number, string][] = [
      [cr.width * 0.4,  0,              'right ×0.4'],
      [cr.width * 0.6,  0,              'right ×0.6'],
      [cr.width * 0.8,  0,              'right ×0.8'],
      [0,               cr.height * 0.4,'down  ×0.4'],
      [0,               cr.height * 0.6,'down  ×0.6'],
      [-cr.width * 0.4, 0,              'left  ×0.4'],
      [-cr.width * 0.8, 0,              'left  ×0.8'],
      [0,              -cr.height * 0.4,'up    ×0.4'],
    ];

    for (const [dx, dy, label] of panSequence) {
      await pan(dx, dy);
      const count = (await findSeeds()).length;
      console.log(`   🖱️  Pan ${label} → ${count}/${expectedCount} seeds visible`);
      if (count >= expectedCount) {
        console.log(`   ✅ All ${expectedCount} nodes in view`);
        return;
      }
    }

    console.log(`   ⚠️  Found ${(await findSeeds()).length}/${expectedCount} nodes after panning`);
  }

  // ── Read name from currently-open side panel ──────────────────────
  async function readOpenPanelName(): Promise<string> {
    return page.evaluate(() => {
      const allEls = Array.from(document.querySelectorAll('label, span, div, p'));
      for (const el of allEls) {
        const text = (el as HTMLElement).innerText?.trim();
        if (!text?.match(/^subagent\s*name\s*\*?$/i)) continue;
        let container = el.parentElement;
        for (let depth = 0; depth < 6; depth++) {
          if (!container) break;
          const inputs = Array.from(
            container.querySelectorAll('input[type="text"], input:not([type])')
          ) as HTMLInputElement[];
          for (const inp of inputs) {
            const val = inp.value?.trim();
            if (val && val.length > 0 && val.length < 60 && !val.startsWith('/') && !val.includes('http')) return val;
          }
          container = container.parentElement;
        }
      }
      return '';
    });
  }

  // ── Click a node → open panel → read name ────────────────────────
  async function clickNodeAndReadName(hoverX: number, hoverY: number, type: string): Promise<string> {
    if (type === 'Start') return 'Start';
    await page.mouse.click(hoverX, hoverY);
    await page.waitForTimeout(800);
    const name = await readOpenPanelName();
    const cr = await getCanvasRect();
    await page.mouse.move(cr.left + 10, cr.top + 10);
    await page.waitForTimeout(200);
    return name || '';
  }

  // ── Find node seeds via pixel color scan ─────────────────────────
  async function findSeeds(): Promise<Seed[]> {
    return page.evaluate(() => {
      const canvas = document.querySelector('canvas') as HTMLCanvasElement;
      const ctx = canvas.getContext('2d')!;
      const cr = canvas.getBoundingClientRect();
      const scaleX = canvas.width / cr.width;
      const scaleY = canvas.height / cr.height;

      const isPurple = (r: number, g: number, b: number, a: number) =>
        a > 100 && Math.abs(r - 143) < 30 && Math.abs(g - 72) < 30 && Math.abs(b - 210) < 30;
      const isTeal = (r: number, g: number, b: number, a: number) =>
        a > 100 && r < 150 && g > 140 && b > 140 && g > r && b > r;

      const pixels: any[] = [];
      for (let sy = 0; sy < canvas.height; sy += 50) {
        const h = Math.min(50, canvas.height - sy);
        const d = ctx.getImageData(0, sy, canvas.width, h).data;
        for (let y = 0; y < h; y++)
          for (let x = 0; x < canvas.width; x++) {
            const i = (y * canvas.width + x) * 4;
            const r = d[i],
              g = d[i + 1],
              b = d[i + 2],
              a = d[i + 3];
            if (isPurple(r, g, b, a) || isTeal(r, g, b, a))
              pixels.push({
                x,
                y: sy + y,
                sx: cr.left + x / scaleX,
                sy: cr.top + (sy + y) / scaleY,
                type: isTeal(r, g, b, a) ? 'Start' : 'Subagent',
              });
          }
      }

      const used = new Set<string>(),
        clusters: any[] = [];
      for (const p of pixels) {
        const key = `${p.x},${p.y}`;
        if (used.has(key)) continue;
        const q = [p];
        used.add(key);
        let minSX = p.sx,
          maxSX = p.sx,
          minSY = p.sy,
          maxSY = p.sy;
        let sc = p.type === 'Start' ? 1 : 0,
          pc = p.type === 'Subagent' ? 1 : 0;
        while (q.length) {
          const c = q.shift()!;
          for (const np of pixels) {
            const nk = `${np.x},${np.y}`;
            if (!used.has(nk) && Math.abs(np.x - c.x) <= 80 && Math.abs(np.y - c.y) <= 80) {
              used.add(nk);
              q.push(np);
              minSX = Math.min(minSX, np.sx);
              maxSX = Math.max(maxSX, np.sx);
              minSY = Math.min(minSY, np.sy);
              maxSY = Math.max(maxSY, np.sy);
              if (np.type === 'Start') sc++;
              else pc++;
            }
          }
        }
        clusters.push({
          type: sc > pc ? 'Start' : 'Subagent',
          hoverX: (minSX + maxSX) / 2,
          hoverY: (minSY + maxSY) / 2,
          minSX,
          maxSX,
          minSY,
          maxSY,
        });
      }

      const deduped: any[] = [],
        usedD = new Set<number>();
      for (let i = 0; i < clusters.length; i++) {
        if (usedD.has(i)) continue;
        let n = { ...clusters[i] };
        for (let j = i + 1; j < clusters.length; j++) {
          if (usedD.has(j)) continue;
          if (
            Math.abs(clusters[i].hoverX - clusters[j].hoverX) < 150 &&
            Math.abs(clusters[i].hoverY - clusters[j].hoverY) < 100
          ) {
            n.hoverX = (n.hoverX + clusters[j].hoverX) / 2;
            n.hoverY = (n.hoverY + clusters[j].hoverY) / 2;
            n.minSX = Math.min(n.minSX, clusters[j].minSX);
            n.maxSX = Math.max(n.maxSX, clusters[j].maxSX);
            n.minSY = Math.min(n.minSY, clusters[j].minSY);
            n.maxSY = Math.max(n.maxSY, clusters[j].maxSY);
            if (clusters[j].type === 'Start') n.type = 'Start';
            usedD.add(j);
          }
        }
        deduped.push(n);
      }
      deduped.sort((a, b) => (a.type === 'Start' ? -1 : b.type === 'Start' ? 1 : a.hoverY - b.hoverY));
      return deduped;
    });
  }

  // ── Find handle circles via hover pixel-diff ──────────────────────
  async function findHandles(seed: Seed, maxDist = 200): Promise<Cluster[]> {
    const cr = await getCanvasRect();
    const scaleX = cr.cw / cr.width;
    const scaleY = cr.ch / cr.height;

    const pad = 250;
    const rx = Math.max(0, Math.round((seed.hoverX - cr.left - pad) * scaleX));
    const ry = Math.max(0, Math.round((seed.hoverY - cr.top - pad) * scaleY));
    const rw = Math.min(Math.round(pad * 2 * scaleX), cr.cw - rx);
    const rh = Math.min(Math.round(pad * 2 * scaleY), cr.ch - ry);

    const snap = async () =>
      page.evaluate(
        ({ rx, ry, rw, rh }) =>
          Array.from(
            (document.querySelector('canvas') as HTMLCanvasElement).getContext('2d')!.getImageData(rx, ry, rw, rh).data
          ),
        { rx, ry, rw, rh }
      );

    await page.mouse.move(cr.left + 10, cr.top + 10);
    await page.waitForTimeout(200);
    const before = await snap();
    await page.mouse.move(seed.hoverX, seed.hoverY, { steps: 8 });
    await page.waitForTimeout(500);
    const after = await snap();

    return page.evaluate(
      ({ before, after, rx, ry, rw, rh, cr, scaleX, scaleY, hoverX, hoverY, maxDist }) => {
        const changed: any[] = [];
        for (let i = 0; i < before.length; i += 4)
          if (
            Math.abs(before[i] - after[i]) +
              Math.abs(before[i + 1] - after[i + 1]) +
              Math.abs(before[i + 2] - after[i + 2]) >
            60
          )
            changed.push({ x: rx + ((i / 4) % rw), y: ry + Math.floor(i / 4 / rw) });

        const used = new Set<string>(),
          clusters: any[] = [];
        for (const p of changed) {
          const key = `${p.x},${p.y}`;
          if (used.has(key)) continue;
          const q = [p];
          used.add(key);
          let minX = p.x,
            maxX = p.x,
            minY = p.y,
            maxY = p.y,
            cnt = 0;
          while (q.length) {
            const c = q.shift()!;
            cnt++;
            for (const np of changed) {
              const nk = `${np.x},${np.y}`;
              if (!used.has(nk) && Math.abs(np.x - c.x) <= 12 && Math.abs(np.y - c.y) <= 12) {
                used.add(nk);
                q.push(np);
                minX = Math.min(minX, np.x);
                maxX = Math.max(maxX, np.x);
                minY = Math.min(minY, np.y);
                maxY = Math.max(maxY, np.y);
              }
            }
          }
          const w = maxX - minX,
            h = maxY - minY;
          if (w >= 4 && w <= 40 && h >= 4 && h <= 40 && cnt >= 8 && cnt <= 400) {
            const sx = cr.left + (minX + maxX) / 2 / scaleX;
            const sy = cr.top + (minY + maxY) / 2 / scaleY;
            const dist = Math.sqrt((sx - hoverX) ** 2 + (sy - hoverY) ** 2);
            if (dist <= maxDist) clusters.push({ sx, sy, w, h, cnt });
          }
        }
        return clusters;
      },
      { before, after, rx, ry, rw, rh, cr, scaleX, scaleY, hoverX: seed.hoverX, hoverY: seed.hoverY, maxDist }
    );
  }

  // ── Match seed to closest known node ─────────────────────────────
  function matchToKnown(seed: Seed, candidates: CanvasNode[], threshold = 200): CanvasNode | null {
    let best: CanvasNode | null = null,
      bestDist = Infinity;
    for (const n of candidates) {
      const d = Math.hypot(n.hoverX - seed.hoverX, n.hoverY - seed.hoverY);
      if (d < bestDist) {
        bestDist = d;
        best = n;
      }
    }
    return bestDist <= threshold ? best : null;
  }

  // ── Core detectNodes ──────────────────────────────────────────────
  async function detectNodes(previousNodes: CanvasNode[] = []): Promise<CanvasNode[]> {
    const isRedetect = previousNodes.length > 0;

    console.log(isRedetect ? '\n🔄 Re-detecting canvas nodes (smart mode)...' : '\n🔍 Detecting canvas nodes...');

    // ✅ Step 1: Ensure horizontal layout before scanning
    await ensureHorizontalLayout();

    // ✅ Step 2: Bring all nodes into view (center button first, pan fallback)
    await bringAllNodesIntoView(isRedetect ? previousNodes.length : 1);

    const cr0 = await getCanvasRect();
    await page.mouse.move(cr0.left + 10, cr0.top + 10);
    await page.waitForTimeout(300);

    const seeds = await findSeeds();
    const openPanelName = await readOpenPanelName();
    nodes = [];
    initialized = false;
    let subIdx = 0;
    const matchedKnownIds = new Set<number>();

    for (const seed of seeds) {
      const internalName = seed.type === 'Start' ? 'Start' : subIdx === 0 ? 'Subagent' : `Subagent_${subIdx + 1}`;

      let uiName: string,
        isNew = false;

      if (seed.type === 'Start') {
        uiName = 'Start';
      } else if (!isRedetect) {
        uiName = await clickNodeAndReadName(seed.hoverX, seed.hoverY, seed.type);
        if (!uiName) uiName = internalName;
        await bringAllNodesIntoView(seeds.length);
      } else {
        const unmatched = previousNodes.filter((n) => !matchedKnownIds.has(n.id));
        const matched = matchToKnown(seed, unmatched);

        if (matched) {
          matchedKnownIds.add(matched.id);
          uiName = openPanelName && openPanelName === matched.uiName ? openPanelName : matched.uiName;
          console.log(`   🔁 "${uiName}" — position updated, name reused`);
        } else {
          isNew = true;
          console.log(`   🆕 New node near (${seed.hoverX.toFixed(0)},${seed.hoverY.toFixed(0)}) — reading name...`);
          uiName = await clickNodeAndReadName(seed.hoverX, seed.hoverY, seed.type);
          if (!uiName) uiName = internalName;
          await bringAllNodesIntoView(previousNodes.length + 1);
        }
      }

      if (seed.type === 'Subagent') subIdx++;

      let clusters: Cluster[] = [];
      for (const offset of [0, 15, -15]) {
        seed.hoverX += offset;
        clusters = await findHandles(seed);
        if (clusters.length >= 4) break;
      }

      if (clusters.length >= 2) {
        const get = (e: string): Cluster => {
          switch (e) {
            case 'top':
              return clusters.reduce((a, b) => (a.sy < b.sy ? a : b));
            case 'bottom':
              return clusters.reduce((a, b) => (a.sy > b.sy ? a : b));
            case 'left':
              return clusters.reduce((a, b) => (a.sx < b.sx ? a : b));
            default:
              return clusters.reduce((a, b) => (a.sx > b.sx ? a : b));
          }
        };
        nodes.push({
          id: nodes.length,
          type: seed.type,
          name: internalName,
          uiName,
          hoverX: seed.hoverX,
          hoverY: seed.hoverY,
          handles: {
            top:    { x: get('top').sx,    y: get('top').sy    },
            bottom: { x: get('bottom').sx, y: get('bottom').sy },
            left:   { x: get('left').sx,   y: get('left').sy   },
            right:  { x: get('right').sx,  y: get('right').sy  },
          },
        });
        console.log(`   ${isNew ? '🆕' : '✅'} [${nodes.length - 1}] "${uiName}" [${seed.type}]`);
      } else {
        console.log(`   ⚠️  Could not detect handles for "${uiName}"`);
      }

      const safeCr = await getCanvasRect();
      await page.mouse.move(safeCr.left + 10, safeCr.top + 10);
      await page.waitForTimeout(150);
    }

    initialized = true;
    return nodes;
  }

  async function redetectNodes(): Promise<CanvasNode[]> {
    return detectNodes([...nodes]);
  }

  async function connectNodes(
    from: string | number,
    to: string | number,
    fromEdge = 'bottom',
    toEdge = 'top'
  ): Promise<boolean> {
    if (!initialized) {
      console.log('⚡ Auto-initializing...');
      await detectNodes([]);
    }
    if (nodes.length === 0) {
      console.error('❌ No nodes detected');
      return false;
    }

    const resolve = (ref: string | number): CanvasNode | undefined => {
      if (typeof ref === 'number') return nodes[ref];
      const lower = ref.toLowerCase();
      return (
        nodes.find((n) => n.uiName.toLowerCase() === lower) ||
        nodes.find((n) => n.name.toLowerCase() === lower) ||
        nodes.find((n) => n.uiName.toLowerCase().includes(lower)) ||
        nodes.find((n) => n.name.toLowerCase().includes(lower)) ||
        nodes.find((n) => n.type.toLowerCase() === lower)
      );
    };

    const fn = resolve(from),
      tn = resolve(to);
    if (!fn) {
      console.error(`❌ Source "${from}" not found. Available: ${nodes.map((n) => `"${n.uiName}"`).join(' | ')}`);
      return false;
    }
    if (!tn) {
      console.error(`❌ Target "${to}" not found. Available: ${nodes.map((n) => `"${n.uiName}"`).join(' | ')}`);
      return false;
    }
    if (fn.id === tn.id) {
      console.error(`❌ Same node: "${fn.uiName}"`);
      return false;
    }

    const fromH = fn.handles[fromEdge as keyof NodeHandles];
    const toH = tn.handles[toEdge as keyof NodeHandles];
    if (!fromH) {
      console.error(`❌ Invalid fromEdge "${fromEdge}"`);
      return false;
    }
    if (!toH) {
      console.error(`❌ Invalid toEdge "${toEdge}"`);
      return false;
    }

    console.log(`\n🔗 "${fn.uiName}".${fromEdge} → "${tn.uiName}".${toEdge}`);
    console.log(`   FROM: (${fromH.x.toFixed(0)},${fromH.y.toFixed(0)}) → TO: (${toH.x.toFixed(0)},${toH.y.toFixed(0)})`);

    await page.mouse.move(fn.hoverX, fn.hoverY, { steps: 8 });
    await page.waitForTimeout(400);
    await page.mouse.move(fromH.x, fromH.y, { steps: 8 });
    await page.waitForTimeout(400);
    await page.mouse.down();
    await page.waitForTimeout(200);
    for (let i = 1; i <= 60; i++) {
      await page.mouse.move(fromH.x + ((toH.x - fromH.x) * i) / 60, fromH.y + ((toH.y - fromH.y) * i) / 60);
      await page.waitForTimeout(8);
    }
    await page.mouse.up();
    await page.waitForTimeout(600);
    console.log(`   ✅ "${fn.uiName}" → "${tn.uiName}" connected!`);

    console.log(`   🔄 Auto re-detecting positions...`);
    await detectNodes([...nodes]);

    return true;
  }

  return { connectNodes, redetectNodes };
}

// ═══════════════════════════════════════════════════════════════════
// TEST
// ═══════════════════════════════════════════════════════════════════

test('Connect canvas nodes', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.goto('https://consoleqa.solpnp.ooguy.com');
  await page.waitForTimeout(1000);
  await page.fill('#username', 'wauser');
  await page.fill('#password', 'Hclsolutions00');
  await page.click('#kc-login');
  await page.waitForTimeout(1000);

  await page.goto('https://consoleqa.solpnp.ooguy.com/ui/unoagenticaibuilder/agent-creation');
  await page.waitForTimeout(1500);

  console.log('⏳ Waiting 60 s — add your initial nodes (e.g. Start, GOPI, TEST)...');
  await page.waitForTimeout(60000);

  const { connectNodes, redetectNodes } = await createCanvasConnector(page);

  await connectNodes('Start', 'GOPI');
  await connectNodes('GOPI', 'TEST');

  console.log('\n⏳ Waiting 30 s — add a NEW subagent node now if you want...');
  await page.waitForTimeout(30000);

  console.log('\n🔄 Checking for new nodes...');
  await redetectNodes();

  // await connectNodes('TEST', 'NEW_AGENT_NAME');

  await page.screenshot({ path: 'final.png' });
});
