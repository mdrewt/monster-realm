import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';
import {
  expectNear,
  expectSample,
  sampleProbe,
  sampleRect,
  sampleStyle,
  withRootFontSize,
} from './uiKit';

// ui-tactics.spec.ts — uif-11 (M-ui-foundation): the tactical screens on the UI kit, measured in
// Chromium (UIF11.1, UIF11.2, UIF11.3, UIF11.4, UIF11.6). UIF11.5 (no behaviour change) is the
// existing B17 / aria / tactics-wild assertions re-run by the gate, not a case here.
//
// EVIDENCE LABEL: real modules + real CSS + a FAKE rules port, on a FIXTURE PAGE. A tactical battle
// needs a live wasm rules engine and a published db with a wild pack; neither is the subject. The page
// is the real index.html with main.ts route-aborted (ui-monsters.spec.ts UIF6.4 / ui-inventory.spec.ts
// UIF8.1 precedent); a page-side STRING (Playwright rewrites `import()` inside a function) imports the
// REAL TacticsBattle, DeployPanel, ResultsPanel, clock painter and installResizeHandler from the Vite
// dev server, and hands the shell a plain-JS fake of tacticsBattle.test.ts's recording rules port (only
// what render, the command menu and a skill aim ask of it). `--mr-ui-scale` is written by the REAL
// installResizeHandler as the window changes: this file never writes it.
//
// ORACLE RULE (uiKit.ts doctrine). Expected values are LITERALS from the wf-1 token table
// (M-ui-foundation-wireframes.md, "Token table (WF1.5)"), never read back from the stylesheet. At a
// x1 root of 16px: body 14px, small 12px, header 16px, space-1 4px, space-2 8px; --mr-frame-fg #e0e0e0,
// --mr-frame-bg #1e1e2e, state ok #34d399, warn #f59e0b, error #f87171; one nav row at root 32px is
// 52.8px (0.125rem x 2 + 0.875rem x 1.6). UIF11.1 and UIF11.3 compare measurements with each other
// (scale ratio; the shared `.mr-nav-item` probe) plus those literals.
//
// No fixed sleeps: layout is synchronous after every op, and the window / root scale polls.

const VIEWPORT = { width: 1280, height: 720 } as const;
const BIG = { width: 1920, height: 1080 } as const;

/** wf-1 token colours as Chromium serialises them (computed `rgb(...)`). */
const FRAME_FG = 'rgb(224, 224, 224)';
const FRAME_BG = 'rgb(30, 30, 46)';
const STATE_OK = 'rgb(52, 211, 153)';
const STATE_WARN = 'rgb(245, 158, 11)';
const STATE_ERROR = 'rgb(248, 113, 113)';

// ---------------------------------------------------------------------------------------------------
// The fixture page. Plain JS (a string, never a function). No backtick, no dollar-brace, no backslash.
//
// THE FIXTURE WORLD: a 7x5 wild battle. Units: own 1 (1,1) 10/10 [HP high], own 2 (3,2) 4/10 [mid],
// wild 3 (5,1) 1/10 [low], wild 4 (5,3) 10/10. Unit 1 is the live unit (AP 5), so Recruit and Flee are
// greyed by the full-budget rule and Item by "not available". Eight skills (the Skills sub-list is the
// longest menu). Six ticker lines.
// ---------------------------------------------------------------------------------------------------

const UIF11_MOUNT = `(async () => {
  const [battleMod, deployMod, resultsMod, resizeMod, clockMod, resolverMod] = await Promise.all([
    import('/src/tactics/tacticsBattle.ts'),
    import('/src/tactics/deployPanel.ts'),
    import('/src/tactics/results.ts'),
    import('/src/render/resizeWiring.ts'),
    import('/src/tactics/clock.ts'),
    import('/src/ui/i18n/resolver.ts'),
  ]);
  const screenEl = document.querySelector('#game-screen');
  if (screenEl === null) throw new Error('#game-screen is missing');
  let app = document.getElementById('app');
  if (app === null) {
    app = document.createElement('div');
    app.id = 'app';
    screenEl.appendChild(app);
  }
  resizeMod.installResizeHandler({ resize() {} }, window);

  // ---- the fake rules port (tacticsBattle.test.ts fakeRules(), minimal answers) ----
  const FRESH = { ap: 7, strides_used: 0, attacks: 0, last: null };
  const REMAINING = { ap: 3, strides_used: 1, attacks: 0, last: { Move: { strides: 1, taxed: false } } };
  const COSTS = [5, 11, 0];
  const geo = (rmin, rmax, origin, shape, radius) => ({
    range_min: rmin, range_max: rmax, origin, shape, radius, ff_filter: 'Enemies',
  });
  const skillOf = (id, tier, power, accuracy, geometry) => ({
    skill_id: id, tier, affinity: 'Plant', power, accuracy, applies_status: null, geometry,
  });
  const heavy = (id) => skillOf(id, 'Heavy', 53, 79, geo(1, 2, 'TargetUnit', 'Single', 0));
  const SKILLS = [skillOf(11, 'Light', 31, 89, geo(0, 0, 'Caster', 'Burst', 1))];
  for (let id = 12; id <= 18; id += 1) SKILLS.push(heavy(id));
  const joinRow = (row) => ({
    id: row.id, side: row.side, slot: row.slot,
    kit: {
      species_id: row.species_id, affinity: 'Plant', level: row.level, stats: row.stats,
      base_speed: 43, class: 'Walk', skills: SKILLS,
    },
    pos: row.pos, cur_hp: row.cur_hp, status: row.status, budget: row.budget,
    guard: row.guard, first_stand: row.first_stand, state: row.state,
  });
  const hitTrace = (hpAfter) => ({
    hit: true, d0: 61, d1: 67, d2: 71, d3: 73, effectiveness: 'Neutral', applied: 79,
    hp_after: hpAfter, stood_ground: false,
  });
  const FORECAST = {
    hit_pct: 83, stab: false, flank: false, guard: false, effectiveness: 'Neutral',
    min: hitTrace(23), max: hitTrace(2), kills_min: false, kills_max: false,
    first_stand_saves: false, status: null, status_blocked: false,
    flank_factor: [5, 4], guard_factor: [3, 4], type_factor: [1, 1],
  };
  const shellTargets = (board, caster, skillId, aim) => {
    const me = board.units.find((u) => u.id === caster);
    if (me === undefined || me.state !== 'Active') return { Err: { UnknownCaster: caster } };
    const foes = board.units.filter((u) => u.side !== me.side && u.state === 'Active');
    if (skillId === 11) {
      return aim.x === me.pos.x && aim.y === me.pos.y
        ? { Ok: foes.map((u) => u.id) }
        : { Err: 'AimNotCaster' };
    }
    const on = foes.find((u) => u.pos.x === aim.x && u.pos.y === aim.y);
    return on === undefined ? { Err: 'NoTargetUnit' } : { Ok: [on.id] };
  };
  const rules = {
    map: () => ({ width: 7, height: 5, tiles: [], spawn_a: [], spawn_b: [] }),
    freshBudget: () => FRESH,
    unit: (row) => joinRow(row),
    targets: (board, caster, skillId, aim) => shellTargets(board, caster, skillId, aim),
    path: (board, mover, dest) => ({ Ok: { steps: [dest], cost: 3 } }),
    disengage: () => ({ Ok: false }),
    flank: () => false,
    forecast: () => FORECAST,
    recruitOdds: () => ({ Ok: { pct: 41, base: 8, bait: 0, weakened: 33 } }),
    aiPlan: () => ['EndTurn'],
    recruitTargets: () => [],
    isExhausted: () => false,
    plan: (start, entries) => ({
      Ok: {
        costs: entries.map((_, i) => (i < COSTS.length ? COSTS[i] : 17)),
        total: entries.length === 0 ? 0 : 19,
        remaining: entries.length === 0 ? start : REMAINING,
        guard_on_end: false,
      },
    }),
    overlays: (board, q) => ({
      reach1: q.selected !== null ? [{ x: 2, y: 1 }] : [],
      reach2: q.selected !== null ? [{ x: 3, y: 1 }] : [],
      range: [], aoe: [], danger: [], shield: [], intents: [],
    }),
  };

  // ---- the view model ----
  const mkUnit = (o) => Object.assign({
    side: 'A', mine: true, ai: false, speciesId: 1, speciesName: 'Sprigg', level: 5,
    affinity: 'Plant', x: 0, y: 0, curHp: 10, maxHp: 10, status: null, ap: 5, guard: false,
    firstStand: false, role: null, stance: null, state: 'Active',
  }, o);
  const foeUnit = (o) => mkUnit(Object.assign({ side: 'B', mine: false, ai: true }, o));
  const UNITS = [
    mkUnit({ unitId: 1, x: 1, y: 1, speciesName: 'Sprigg' }),
    mkUnit({ unitId: 2, x: 3, y: 2, speciesName: 'Cindertail', curHp: 4 }),
    foeUnit({ unitId: 3, x: 5, y: 1, speciesName: 'Mossback', curHp: 1 }),
    foeUnit({ unitId: 4, x: 5, y: 3, speciesName: 'Flameling' }),
  ];
  const slots = { A: 0, B: 0 };
  let wilds = 0;
  const rowsOfUnits = UNITS.map((u) => {
    const slot = slots[u.side];
    slots[u.side] = slot + 1;
    let wildIndex = null;
    if (u.ai) { wildIndex = wilds; wilds += 1; }
    return {
      id: u.unitId, side: u.side, slot, species_id: u.speciesId, level: u.level,
      stats: { hp: u.maxHp, attack: 10, defense: 10, speed: 10, sp_attack: 10, sp_defense: 10 },
      pos: { x: u.x, y: u.y }, cur_hp: u.curHp, status: null,
      budget: { ap: u.ap, strides_used: 0, attacks: 0, last: null },
      guard: u.guard, first_stand: u.firstStand, state: u.state, stance: u.stance, wild_index: wildIndex,
    };
  });
  const vm = {
    battleId: 1n, kind: 'wild', width: 7, height: 5, units: UNITS, activeUnitId: 1, round: 1,
    initiative: [1, 3, 2, 4], turnIdx: 0, nextInitiative: [1, 3, 2, 4], surgeStartRound: 9,
    wildRoundCap: 31, targetUnitId: null,
    board: { kind: 'Wild', map_id: 1, units: rowsOfUnits },
    readyPlans: new Map(), baits: [], partyFull: false,
  };
  const deps = {
    now: () => 0,
    reduceMotion: () => true,
    names: {
      mySide: 'A',
      unit: (id) => 'Unit ' + id,
      skill: (id) => 'Skill ' + id,
      item: (id) => 'Item ' + id,
    },
    rules: () => rules,
    onSubmitQueue() {},
    onCancelQueue() {},
    onForfeit() {},
  };
  const shell = new battleMod.TacticsBattle(app, deps);
  shell.show();
  shell.render(vm);
  shell.ingest([1, 2, 3, 4, 5, 6].map((n) => ({ tag: 'RoundEnded', value: { round: n } })));

  const deploy = new deployMod.DeployPanel(app, { onDeploy: () => new Promise(() => {}) });
  let deployId = 1;
  const deployFresh = () => {
    deployId += 1;
    deploy.render(deployMod.deployVM({
      mode: 'wild', battleId: BigInt(deployId), remembered: [], slotCount: 2,
      party: [
        { monsterId: 1n, name: 'Kip', level: 5, hp: 10, maxHp: 10 },
        { monsterId: 2n, name: 'Ember', level: 6, hp: 8, maxHp: 12 },
      ],
      wilds: [
        { speciesId: 1, name: 'Mossback', level: 4 },
        { speciesId: 2, name: 'Flameling', level: 4 },
      ],
    }));
    return true;
  };
  deployFresh();
  const results = new resultsMod.ResultsPanel(app, { onContinue() {} });
  results.render({
    battleId: 1n, outcome: 'won', recruits: [], currency: 123n, rating: null, endHow: null,
    monsters: [{ unitId: 1, name: 'Kip', xp: 53, essence: 7 }],
  });

  // ---- the hooks the spec drives (every press goes through the shell's public op API) ----
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const sel = () => {
    const r = q('.tactics-battle .tactics-menu-row[aria-selected="true"]');
    return r === null ? null : r.getAttribute('data-row');
  };
  const rows = () => qa('.tactics-battle .tactics-menu .tactics-menu-row').map((r) => r.getAttribute('data-row'));
  const menuOpen = () => q('.tactics-battle .tactics-menu') !== null;
  const op = (kind, dir) => shell.applyBattleOp(dir === undefined ? { kind } : { kind, dir });
  const idle = () => {
    for (let i = 0; i < 12; i += 1) {
      if (!menuOpen() && q('.tactics-battle .tactics-forecast') === null) return true;
      op('back');
    }
    return false;
  };
  const toTile = (x, y) => {
    for (let i = 0; i < 24; i += 1) {
      const at = shell.cursor;
      if (at === null) return false;
      if (at.x === x && at.y === y) return true;
      const dir = at.x < x ? 'Right' : at.x > x ? 'Left' : at.y < y ? 'Down' : 'Up';
      op('move', dir);
    }
    return false;
  };
  const openMenu = () => {
    if (!idle()) return false;
    if (!toTile(1, 1)) return false;
    op('activate');
    return menuOpen();
  };
  const menuTo = (id) => {
    for (let i = 0; i < 20; i += 1) {
      if (sel() === id) return true;
      op('move', 'Down');
    }
    return sel() === id;
  };
  const openSkills = () => {
    if (!openMenu() || !menuTo('skills')) return [];
    op('activate');
    return rows();
  };
  const aim = () => {
    if (!openMenu() || !menuTo('skills')) return false;
    op('activate');
    if (!menuTo('skill:11')) return false;
    op('activate');
    return q('.tactics-battle .tactics-dock .tactics-forecast') !== null;
  };
  const rect = (s) => {
    const el = q(s);
    if (el === null) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
  };
  const rowRect = (el) => {
    const r = el.getBoundingClientRect();
    return { id: el.getAttribute('data-row'), top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height };
  };
  const measure = () => {
    const menu = q('.tactics-battle .tactics-menu');
    let probeH = null;
    if (menu !== null) {
      const p = document.createElement('div');
      p.className = 'mr-nav-item';
      p.textContent = 'probe';
      menu.appendChild(p);
      probeH = p.getBoundingClientRect().height;
      p.remove();
    }
    const ticker = q('.tactics-battle .tactics-ticker');
    let lineHeight = Number.NaN;
    let tickerContent = Number.NaN;
    if (ticker !== null) {
      const cs = getComputedStyle(ticker);
      lineHeight = Number.parseFloat(cs.lineHeight);
      if (!Number.isFinite(lineHeight)) lineHeight = Number.parseFloat(cs.fontSize) * 1.2;
      tickerContent = ticker.clientHeight - Number.parseFloat(cs.paddingTop) - Number.parseFloat(cs.paddingBottom);
    }
    const cur = q('.tactics-battle .tactics-menu-row[aria-selected="true"]');
    return {
      frame: rect('.tactics-battle'),
      board: rect('.tactics-battle .tactics-board'),
      ticker: rect('.tactics-battle .tactics-ticker'),
      tickerLines: ticker === null ? 0 : ticker.children.length,
      lineHeight,
      tickerContent,
      dock: rect('.tactics-battle .tactics-dock'),
      turnbar: rect('.tactics-battle .tactics-turnbar'),
      rootScrollTop: q('.tactics-battle').scrollTop,
      probeH,
      rows: qa('.tactics-battle .tactics-menu .tactics-menu-row').map(rowRect),
      cursor: cur === null ? null : rowRect(cur),
    };
  };
  const reasonInfo = (id) => {
    const row = q('.tactics-battle .tactics-menu-row[data-row="' + id + '"]');
    if (row === null) return null;
    const r = row.querySelector('.tactics-reason');
    if (r === null) return { text: '', w: 0, h: 0, inside: false, visibility: '', display: '', opacity: '' };
    const rb = r.getBoundingClientRect();
    const wb = row.getBoundingClientRect();
    const cs = getComputedStyle(r);
    return {
      text: (r.textContent || '').trim(), w: rb.width, h: rb.height,
      inside: rb.left >= wb.left - 0.5 && rb.right <= wb.right + 0.5 && rb.top >= wb.top - 0.5 && rb.bottom <= wb.bottom + 0.5,
      visibility: cs.visibility, display: cs.display, opacity: cs.opacity,
    };
  };
  const labelLeft = (id) => {
    const el = q('.tactics-battle .tactics-menu-row[data-row="' + id + '"] .tactics-menu-label');
    return el === null ? null : el.getBoundingClientRect().left;
  };
  const greyed = () => qa('.tactics-battle .tactics-menu-row[aria-disabled="true"]').map((r) => r.getAttribute('data-row'));
  const ring = (band) => {
    const tb = q('.tactics-battle .tactics-turnbar');
    const pl = q('.tactics-battle .tactics-players');
    clockMod.renderClock(tb, pl, band === null ? null : {
      ring: { unitId: 1, side: 'A', secondsLeft: 20, fraction: 0.5, band },
      players: [],
    });
    return q('.tactics-battle .tactics-clock-ring') !== null;
  };
  const showRoot = (selector, on) => {
    const el = q(selector);
    if (el === null) return false;
    el.style.display = on ? 'flex' : 'none';
    return true;
  };
  let round = 1;
  window.__uif11 = {
    menuOpen, sel, rows, idle, openMenu, menuTo, openSkills, aim, measure, reasonInfo, labelLeft,
    greyed, ring,
    op: (kind, dir) => op(kind, dir),
    setLocale: (l) => resolverMod.setLocale(l),
    repaint: () => { round += 1; shell.render(Object.assign({}, vm, { round })); },
    deployFresh,
    spanGaps: (selector) => {
      const row = q(selector);
      if (row === null) return null;
      const kids = Array.from(row.children);
      const gaps = [];
      for (let i = 1; i < kids.length; i += 1) {
        gaps.push(kids[i].getBoundingClientRect().left - kids[i - 1].getBoundingClientRect().right);
      }
      return { count: kids.length, gaps };
    },
    deployShow: (on) => showRoot('.tactics-deploy', on),
    deployOp: (kind, dir) => deploy.applyBattleOp(dir === undefined ? { kind } : { kind, dir }),
    resultsShow: (on) => showRoot('.tactics-results', on),
  };
  return true;
})()`;

interface RectLike {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}
interface RowRect {
  id: string | null;
  top: number;
  bottom: number;
  left: number;
  right: number;
  height: number;
}
interface Measure {
  frame: RectLike;
  board: RectLike;
  ticker: RectLike;
  tickerLines: number;
  lineHeight: number;
  /** The ticker's content-box height (clientHeight minus vertical padding). */
  tickerContent: number;
  dock: RectLike;
  turnbar: RectLike;
  rootScrollTop: number;
  probeH: number | null;
  rows: RowRect[];
  cursor: RowRect | null;
}
interface ReasonInfo {
  text: string;
  w: number;
  h: number;
  inside: boolean;
  visibility: string;
  display: string;
  opacity: string;
}

const px = (v: string | undefined): number => Number.parseFloat(v ?? '');

test.describe
  .serial('UIF11 — the tactical screens on the UI kit (fixture page: real modules, real CSS, fake rules)', () => {
    let browser: Browser;
    let ctx: BrowserContext;
    let page: Page;

    /** Evaluates a page-side expression string and returns its (awaited) value. */
    const ev = async <T>(expr: string): Promise<T> => (await page.evaluate(expr)) as T;

    /** Resizes the window and waits for the REAL resize handler to write the root scale. */
    async function setWindow(
      win: { width: number; height: number },
      rootPx: number,
    ): Promise<void> {
      await page.setViewportSize(win);
      await expect
        .poll(() => ev<string>('getComputedStyle(document.documentElement).fontSize'), {
          message: `the root font-size follows the window ${win.width}x${win.height}`,
        })
        .toBe(`${rootPx}px`);
    }

    test.beforeAll(async () => {
      test.setTimeout(60_000);
      browser = await chromium.launch();
      ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
      await ctx.route('**/src/main.ts*', (route) => route.abort());
      page = await ctx.newPage();
      await page.goto('/');
      await page.waitForLoadState('load');
      expect(
        await page.evaluate(() => typeof (window as unknown as { __game?: unknown }).__game),
        'main.ts did not run',
      ).toBe('undefined');
      await page.evaluate(UIF11_MOUNT);
      await expect(
        page.locator('.tactics-battle .tactics-board'),
        'the fixture battle shows',
      ).toBeVisible();
    });

    test.afterEach(async () => {
      // Whatever a case left open, the next one starts from a closed menu, hidden deploy / results
      // panels, no clock ring, English and the x1 window.
      await ev('window.__uif11.setLocale("en")');
      await ev('window.__uif11.deployFresh()');
      await ev('window.__uif11.deployShow(false)');
      await ev('window.__uif11.resultsShow(false)');
      await ev('window.__uif11.ring(null)');
      await ev('window.__uif11.idle()');
      await page.setViewportSize(VIEWPORT);
    });

    test.afterAll(async () => {
      await browser.close();
    });

    test('UIF11.1 at 1280x720 then 1920x1080 a turn-bar chip, a HUD info box, a menu row, the ticker and the forecast panel compute font-size and padding x1.5, the board grows, and the root has no inline font-size', async () => {
      // WRONG IMPL KILLED: any of those parts left on px (font-size 11/12px, padding 4px 6px, ...): its
      // computed size is IDENTICAL at both windows, so the 1.5 ratio fails; a battle-only scale (zoom,
      // transform: scale, a second --mr-ui-scale read) that double-scales one part and leaves another
      // alone (some ratios would be 2.25); a root that pins its own inline font-size (the body token
      // times the scale would not hold); a fixture that never reached the real resize handler (the
      // root stays 16px and every ratio is 1). Every sampled value is non-zero at x1 so 0 x 1.5 = 0
      // cannot pass.
      const PROPS = ['font-size', 'padding-left', 'padding-top'] as const;
      const MENU_PARTS: ReadonlyArray<readonly [string, string]> = [
        ['a turn-bar chip', '.tactics-battle .tactics-turnbar .tactics-chip'],
        ['a HUD info box', '.tactics-battle .tactics-info--own'],
        ['a menu row', '.tactics-battle .tactics-menu-row'],
        ['the ticker', '.tactics-battle .tactics-ticker'],
      ];
      const AIM_PARTS: ReadonlyArray<readonly [string, string]> = [
        ['the forecast panel', '.tactics-battle .tactics-dock .tactics-forecast'],
      ];
      const measureAt = async (
        win: { width: number; height: number },
        rootPx: number,
      ): Promise<{
        values: Map<string, Record<string, string>>;
        board: { width: number; height: number };
        rootInline: string;
        rootFont: number;
        scale: number;
      }> => {
        await setWindow(win, rootPx);
        const values = new Map<string, Record<string, string>>();
        expect(await ev<boolean>('window.__uif11.openMenu()'), 'the command menu opens').toBe(true);
        for (const [name, selector] of MENU_PARTS) {
          values.set(name, await sampleStyle(page, selector, PROPS));
        }
        expect(
          await ev<boolean>('window.__uif11.aim()'),
          'a skill aim shows the forecast panel',
        ).toBe(true);
        for (const [name, selector] of AIM_PARTS) {
          values.set(name, await sampleStyle(page, selector, PROPS));
        }
        const board = await sampleRect(page, '.tactics-battle .tactics-board');
        const rootInline = await ev<string>(
          'document.querySelector(".tactics-battle").style.fontSize',
        );
        const rootStyle = await sampleStyle(page, '.tactics-battle', ['font-size']);
        const scale = Number(
          await ev<string>('document.documentElement.style.getPropertyValue("--mr-ui-scale")'),
        );
        return {
          values,
          board: { width: board.width, height: board.height },
          rootInline,
          rootFont: px(rootStyle['font-size']),
          scale,
        };
      };

      const one = await measureAt(VIEWPORT, 16);
      const big = await measureAt(BIG, 24);
      expect(one.scale, 'the real handler wrote scale 1 at 1280x720').toBe(1);
      expect(big.scale, 'the real handler wrote scale 1.5 at 1920x1080').toBe(1.5);
      for (const [name] of [...MENU_PARTS, ...AIM_PARTS]) {
        const a = one.values.get(name) as Record<string, string>;
        const b = big.values.get(name) as Record<string, string>;
        for (const prop of PROPS) {
          const at1 = px(a[prop]);
          expect(at1, `${name} ${prop} at x1 is a real, non-zero length`).toBeGreaterThan(0);
          expectNear(px(b[prop]), at1 * 1.5, 0.5, `${name} ${prop}: x1.5 of ${at1}px`);
        }
      }
      expect(big.board.width, 'the board grows with the window').toBeGreaterThan(one.board.width);
      expect(big.board.height, 'and in height').toBeGreaterThan(one.board.height);
      expect(one.rootInline, 'the tactical root writes no inline font-size (x1)').toBe('');
      expect(big.rootInline, 'and none at x1.5').toBe('');
      expectNear(one.rootFont, 14, 0.5, 'the root font-size is the body token at x1');
      expectNear(big.rootFont, 21, 0.5, 'and the body token times the scale at x1.5');
    });

    test('UIF11.2 at x1 the deploy panel, the board dock and command menu, and the results panel compute the wf-1 token sizes and colours, the HP bands and the clock bands keep green / amber / red as ok / warn / error', async () => {
      // WRONG IMPL KILLED: a menu row left at 13px, a reason at 11px, the results Continue button on
      // the UA 13.333px font (a button does not inherit font-size), the deploy Prev button likewise,
      // a root colour #eee instead of the frame-fg token, the deploy status in a literal #e6b450 instead
      // of the warn token; the HP bands left on #4c4 / #ec3 / #e44 or assigned in the wrong order; the
      // clock bands left on #3c9 / #fc6 / #f66 or re-pointed (a green low band); the three bands
      // collapsed to one colour (each ring must contain ITS colour and not the other two).
      await setWindow(VIEWPORT, 16);

      // ---- the deploy panel: confirm screen, then the editor, then the in-flight status ----
      expect(await ev<boolean>('window.__uif11.deployShow(true)'), 'the deploy root is there').toBe(
        true,
      );
      expectSample(
        await sampleStyle(page, '.tactics-deploy', ['font-size', 'color', 'background-color']),
        { 'font-size': '14px', color: FRAME_FG, 'background-color': FRAME_BG },
        'the deploy root: body font on the frame tokens',
      );
      expectSample(
        await sampleStyle(page, '.tactics-deploy .tactics-menu-row', ['font-size']),
        { 'font-size': '14px' },
        'a deploy menu row is the body size',
      );
      await ev('window.__uif11.deployOp("move", "Down")');
      await ev('window.__uif11.deployOp("activate")');
      expectSample(
        await sampleStyle(page, '.tactics-deploy .tactics-deploy-prev', ['font-size']),
        { 'font-size': '14px' },
        'the editor Previous button is the body size, not the UA button font',
      );
      await ev('window.__uif11.deployOp("back")');
      await ev('window.__uif11.deployOp("move", "Up")');
      await ev('window.__uif11.deployOp("activate")');
      expectSample(
        await sampleStyle(page, '.tactics-deploy .tactics-deploy-status', ['color']),
        { color: STATE_WARN },
        'the Deploying status is the warn token',
      );
      await ev('window.__uif11.deployShow(false)');

      // ---- the board: root colour, dock buttons, command menu, reasons ----
      expect(await ev<boolean>('window.__uif11.openMenu()'), 'the command menu opens').toBe(true);
      expectSample(
        await sampleStyle(page, '.tactics-battle', ['color']),
        { color: FRAME_FG },
        'the tactical root text is the frame-fg token',
      );
      expectSample(
        await sampleStyle(page, '.tactics-battle .tactics-menu-row[data-row="move"]', [
          'font-size',
        ]),
        { 'font-size': '14px' },
        'a command row is the body size',
      );
      const greyed = await ev<string[]>('window.__uif11.greyed()');
      expect(greyed.length, 'fixture: at least one greyed row carries a reason').toBeGreaterThan(0);
      expectSample(
        await sampleStyle(
          page,
          '.tactics-battle .tactics-menu-row[aria-disabled="true"] .tactics-reason',
          ['font-size'],
        ),
        { 'font-size': '12px' },
        'a reason is the small size',
      );
      expectSample(
        await sampleStyle(page, '.tactics-battle .tactics-menu', ['padding-top', 'padding-left']),
        { 'padding-top': '4px', 'padding-left': '4px' },
        'the command menu is padded by space-1',
      );
      expectSample(
        await sampleStyle(page, '.tactics-battle .tactics-dock-buttons button', ['font-size']),
        { 'font-size': '12px' },
        'a dock button is the small size',
      );

      // ---- the HP bands ----
      for (const [band, colour] of [
        ['high', STATE_OK],
        ['mid', STATE_WARN],
        ['low', STATE_ERROR],
      ] as const) {
        expectSample(
          await sampleStyle(page, `.tactics-battle .tactics-hp--${band} .tactics-hp-fill`, [
            'background-color',
          ]),
          { 'background-color': colour },
          `HP ${band} fill`,
        );
      }

      // ---- the clock bands, painted by the real clock painter onto the current chip ----
      const BANDS: ReadonlyArray<readonly [string, string]> = [
        ['ok', STATE_OK],
        ['amber', STATE_WARN],
        ['red', STATE_ERROR],
      ];
      for (const [band, colour] of BANDS) {
        expect(
          await ev<boolean>(`window.__uif11.ring("${band}")`),
          `the ${band} ring is painted`,
        ).toBe(true);
        const ring = await sampleStyle(page, '.tactics-battle .tactics-clock-ring', [
          'background-image',
        ]);
        const image = ring['background-image'] ?? '';
        expect(image, `the ${band} ring is filled with its band colour`).toContain(colour);
        for (const [other, otherColour] of BANDS) {
          if (other !== band) {
            expect(image, `the ${band} ring is not the ${other} colour`).not.toContain(otherColour);
          }
        }
      }
      await ev('window.__uif11.ring(null)');

      // ---- the results panel ----
      expect(
        await ev<boolean>('window.__uif11.resultsShow(true)'),
        'the results root is there',
      ).toBe(true);
      expectSample(
        await sampleStyle(page, '.tactics-results', ['font-size', 'color', 'background-color']),
        { 'font-size': '14px', color: FRAME_FG, 'background-color': FRAME_BG },
        'the results root: body font on the frame tokens',
      );
      expectSample(
        await sampleStyle(page, '.tactics-results .tactics-results-continue', ['font-size']),
        { 'font-size': '14px' },
        'the Continue button is the body size, not the UA 13.333px',
      );
    });

    test('UIF11.3 with the menu open the cursor row, a greyed row and a greyed cursor row compute the SAME padding, fill, colour, outline and arrow as the shared .mr-nav-item probes, the reason stays visible, and the label does not move between cursor and non-cursor', async () => {
      // WRONG IMPL KILLED: a tactical-only copy of the treatment (today's `#44445a` fill with a white
      // border and 2px 6px padding: padding, fill and outline all differ from the probe); a cursor row
      // with no arrow, or an arrow that adds net width (the label shifts right when the cursor lands);
      // the shared disabled colour not applying to a greyed row; the active+disabled pair missing or
      // matched by the wrong specificity (the greyed cursor row would show the active colour or the
      // plain disabled one); `justify-content: space-between` or a hidden / clipped / empty reason (a
      // greyed row that no longer says why); a probe-free comparison against hand-typed numbers.
      await setWindow(VIEWPORT, 16);
      expect(await ev<boolean>('window.__uif11.openMenu()'), 'the command menu opens').toBe(true);
      const PROBE_PARENT = '.tactics-battle .tactics-menu';
      const BOX = [
        'padding',
        'background-color',
        'color',
        'outline-style',
        'outline-width',
        'outline-color',
        'outline-offset',
      ] as const;
      const ARROW = ['content', 'margin-left'] as const;
      const probe = (className: string, props: readonly string[], pseudo?: '::before') =>
        sampleProbe(page, { className, parent: PROBE_PARENT }, props, pseudo);

      // The cursor row (Move, first) against an active probe, box and arrow.
      expect(await ev<string | null>('window.__uif11.sel()'), 'the cursor starts on Move').toBe(
        'move',
      );
      const cursor = '.tactics-battle .tactics-menu-row[aria-selected="true"]';
      expectSample(
        await sampleStyle(page, cursor, BOX),
        await probe('mr-nav-item is-active', BOX),
        'the cursor row equals a .mr-nav-item.is-active probe',
      );
      const arrowProbe = await probe('mr-nav-item is-active', ARROW, '::before');
      expect(arrowProbe.content, 'fixture: the active probe draws the arrow').not.toBe('none');
      expectSample(
        await sampleStyle(page, cursor, ARROW, '::before'),
        arrowProbe,
        'the cursor row draws the same arrow',
      );

      // An enabled non-cursor row (Skills) against a plain probe.
      expectSample(
        await sampleStyle(page, '.tactics-battle .tactics-menu-row[data-row="skills"]', BOX),
        await probe('mr-nav-item', BOX),
        'an enabled non-cursor row equals a plain .mr-nav-item probe',
      );

      // A greyed non-cursor row against a disabled probe, and its reason.
      const greyedRows = await ev<string[]>('window.__uif11.greyed()');
      expect(greyedRows.length, 'fixture: several rows are greyed').toBeGreaterThan(1);
      const greyId = greyedRows[0] as string;
      expectSample(
        await sampleStyle(
          page,
          `.tactics-battle .tactics-menu-row[data-row="${greyId}"]:not([aria-selected="true"])`,
          BOX,
        ),
        await probe('mr-nav-item is-disabled', BOX),
        `the greyed non-cursor row (${greyId}) equals a .mr-nav-item.is-disabled probe`,
      );
      const reason = await ev<ReasonInfo>(`window.__uif11.reasonInfo("${greyId}")`);
      expect(reason.text.length, 'the greyed row keeps a non-empty reason').toBeGreaterThan(0);
      expect(reason.display, 'the reason is displayed').not.toBe('none');
      expect(reason.visibility, 'the reason is visible').toBe('visible');
      expect(Number(reason.opacity), 'the reason is opaque').toBeGreaterThan(0);
      expect(reason.w, 'the reason has a width').toBeGreaterThan(0);
      expect(reason.h, 'the reason has a height').toBeGreaterThan(0);
      expect(reason.inside, 'the reason sits inside its row').toBe(true);

      // The label does not move between cursor and non-cursor (the arrow adds no net width).
      const withCursor = await ev<number>('window.__uif11.labelLeft("move")');
      await ev('window.__uif11.op("move", "Down")');
      expect(await ev<string | null>('window.__uif11.sel()'), 'the cursor left Move').toBe(
        'skills',
      );
      const withoutCursor = await ev<number>('window.__uif11.labelLeft("move")');
      expectNear(withCursor, withoutCursor, 0.5, 'the Move label x with and without the cursor');

      // The cursor on a greyed row against an active+disabled probe; its reason stays visible.
      expect(
        await ev<boolean>(`window.__uif11.menuTo("${greyId}")`),
        'the cursor reaches a greyed row',
      ).toBe(true);
      expectSample(
        await sampleStyle(page, cursor, BOX),
        await probe('mr-nav-item is-active is-disabled', BOX),
        'the greyed cursor row equals a .mr-nav-item.is-active.is-disabled probe',
      );
      const onCursor = await ev<ReasonInfo>(`window.__uif11.reasonInfo("${greyId}")`);
      expect(onCursor.text.length, 'the greyed cursor row keeps its reason').toBeGreaterThan(0);
      expect(onCursor.w * onCursor.h, 'and it is painted (non-zero area)').toBeGreaterThan(0);
      expect(onCursor.inside, 'and inside the row').toBe(true);
    });

    test('UIF11.3 the deploy menu uses the same treatment: the editor cursor row equals the active probe, a non-cursor row the plain probe, and a row holding a monster keeps its spans apart', async () => {
      // WRONG IMPL KILLED: a deploy-only copy of the treatment (`.tactics-deploy [aria-selected="true"]
      // { background: #44445a }`): padding, fill, colour, outline and arrow would differ from the
      // shared probe; a deploy row left on the old padding; a row whose child spans run together
      // ("Slot 1Kip Lv.5HP 10/10": the real defect a reviewer found once the row's
      // `justify-content: space-between` went), measured as the gap between consecutive child rects
      // (at least 4px at x1; the shipped rule gives 8px).
      await setWindow(VIEWPORT, 16);
      await ev('window.__uif11.deployFresh()');
      expect(await ev<boolean>('window.__uif11.deployShow(true)'), 'the deploy root is there').toBe(
        true,
      );
      // Confirm screen -> the formation editor, whose slot rows each hold a monster.
      await ev('window.__uif11.deployOp("move", "Down")');
      await ev('window.__uif11.deployOp("activate")');
      const PARENT = '.tactics-deploy .tactics-menu';
      const BOX = [
        'padding',
        'background-color',
        'color',
        'outline-style',
        'outline-width',
        'outline-color',
        'outline-offset',
      ] as const;
      const probe = (className: string, props: readonly string[], pseudo?: '::before') =>
        sampleProbe(page, { className, parent: PARENT }, props, pseudo);
      const cursor = '.tactics-deploy .tactics-menu-row[aria-selected="true"]';
      expect(
        await ev<string | null>(
          `(document.querySelector('${cursor}') || { getAttribute: () => null }).getAttribute("data-row")`,
        ),
        'the editor cursor is on slot 0',
      ).toBe('slot-0');
      expectSample(
        await sampleStyle(page, cursor, BOX),
        await probe('mr-nav-item is-active', BOX),
        'the deploy cursor row equals a .mr-nav-item.is-active probe',
      );
      const arrow = await probe('mr-nav-item is-active', ['content', 'margin-left'], '::before');
      expect(arrow.content, 'fixture: the active probe draws the arrow').not.toBe('none');
      expectSample(
        await sampleStyle(page, cursor, ['content', 'margin-left'], '::before'),
        arrow,
        'the deploy cursor row draws the same arrow',
      );
      expectSample(
        await sampleStyle(page, '.tactics-deploy .tactics-menu-row[aria-selected="false"]', [
          'padding',
        ]),
        await probe('mr-nav-item', ['padding']),
        'a non-cursor deploy row has the plain .mr-nav-item padding',
      );
      const gaps = await ev<{ count: number; gaps: number[] } | null>(
        `window.__uif11.spanGaps('${cursor}')`,
      );
      expect(gaps, 'the cursor row is measured').not.toBeNull();
      const g = gaps as { count: number; gaps: number[] };
      expect(g.count, 'fixture: label, name, level and HP spans').toBeGreaterThanOrEqual(4);
      g.gaps.forEach((gap, i) => {
        expect(gap, `span ${i} -> ${i + 1} do not touch (gap ${gap}px)`).toBeGreaterThanOrEqual(4);
      });
    });

    test('UIF11.4 the item row reads Items, no Bag appears anywhere in the tactical shell, and after switching to French and repainting it reads Objets with no Sac', async () => {
      // WRONG IMPL KILLED: the row still reading "Item" or "Bag" (catalog unchanged); English changed
      // and French left on "Sac" (a French boot keeps the old name); the word fixed in a title or
      // aria-label while the visible label keeps the old copy (the label span text is read, and every
      // aria-label / title / text node of the shell is scanned for the old word); a French repaint that
      // keeps the English row (the locale is read at paint).
      await setWindow(VIEWPORT, 16);
      const labelOf = (): Promise<string> =>
        ev<string>(
          '(document.querySelector(\'.tactics-battle .tactics-menu-row[data-row="item"] .tactics-menu-label\') || { textContent: "(no item row)" }).textContent.trim()',
        );
      const shellText = (): Promise<string> =>
        ev<string>(
          '(() => { const root = document.querySelector(".tactics-battle"); const bits = [root.textContent || ""]; for (const e of Array.from(root.querySelectorAll("*"))) { bits.push(e.getAttribute("aria-label") || "", e.getAttribute("title") || ""); } return bits.join(" "); })()',
        );
      expect(await ev<boolean>('window.__uif11.openMenu()'), 'the command menu opens').toBe(true);
      expect(await labelOf(), 'en: the item row').toBe('Items');
      const enText = await shellText();
      expect(enText.length, 'anti-vacuity: the shell text was read').toBeGreaterThan(40);
      expect(/\bbag\b/i.test(enText), `no "Bag" anywhere in the English shell: ${enText}`).toBe(
        false,
      );

      await ev('window.__uif11.setLocale("fr")');
      await ev('window.__uif11.repaint()');
      if (!(await ev<boolean>('window.__uif11.menuOpen()'))) {
        expect(await ev<boolean>('window.__uif11.openMenu()'), 'the menu reopens in French').toBe(
          true,
        );
      }
      expect(await labelOf(), 'fr: the item row').toBe('Objets');
      const frText = await shellText();
      expect(/\bsac\b/i.test(frText), `no "Sac" anywhere in the French shell: ${frText}`).toBe(
        false,
      );
    });

    test('UIF11.6 at 1280x720 with the root doubled the board keeps 30% of the frame, the ticker shrinks to at least one line, every command row is one nav-row tall, and the cursor row stays inside the frame and the dock, for the root menu and the longest sub-list', async () => {
      // WRONG IMPL KILLED: a board that shrinks with the text until the field is a sliver (no 30%
      // floor); a ticker that never yields (it still shows more than one line when the board is
      // already below its preferred 70%: the priority oracle), or one that collapses below one line
      // (the log is unreadable); a cursor row kept in view by scrolling the clipped ROOT (the turn bar
      // moves and the root's scrollTop changes: only the dock may scroll); a command row taller or shorter than the shared nav row (a 1px border, a
      // px padding, a different line-height or font-size: 52.8px at a 32px root); a dock that grows
      // past the frame so the cursor row leaves it; a long sub-list (Skills) whose last row is
      // scrolled out of the dock with no scroll-into-view; a layout fixed only at x1.
      await setWindow(VIEWPORT, 16);
      // (b) The ticker YIELDS: with the menu closed at x1 it shows well over one line, so its floor
      // with the menu open is a shrink and not its steady size. Priority oracle, no px compared across
      // root sizes.
      expect(await ev<boolean>('window.__uif11.idle()'), 'the menu is closed').toBe(true);
      const closed1 = await ev<Measure>('window.__uif11.measure()');
      expect(
        closed1.tickerContent / closed1.lineHeight,
        'x1, menu closed: the ticker shows more than one line (it has something to give up)',
      ).toBeGreaterThan(1.5);
      expect(await ev<boolean>('window.__uif11.openMenu()'), 'the command menu opens').toBe(true);
      const at1 = await ev<Measure>('window.__uif11.measure()');
      expect(at1.tickerLines, 'fixture: the ticker holds several lines').toBeGreaterThan(2);
      expect(at1.rows.length, 'fixture: the root menu has its rows').toBeGreaterThanOrEqual(6);

      // The frame's 2px border (both sides) is outside the percentage base of the field's floor, so the
      // 30% floor measures 0.30 x frame - 1.2px: a named 2px tolerance, nothing looser.
      const BORDER_SLACK = 2;
      const expectFrameLayout = (m: Measure, label: string): void => {
        expect(m.board.height, `${label}: the board keeps 30% of the frame`).toBeGreaterThanOrEqual(
          0.3 * m.frame.height - BORDER_SLACK,
        );
        expect(m.cursor, `${label}: a cursor row is marked`).not.toBeNull();
        const cur = m.cursor as RowRect;
        expect(cur.top, `${label}: the cursor row top is inside the frame`).toBeGreaterThanOrEqual(
          m.frame.top - 0.5,
        );
        expect(
          cur.bottom,
          `${label}: the cursor row bottom is inside the frame`,
        ).toBeLessThanOrEqual(m.frame.bottom + 0.5);
        expect(cur.top, `${label}: the cursor row top is inside the dock`).toBeGreaterThanOrEqual(
          m.dock.top - 0.5,
        );
        expect(
          cur.bottom,
          `${label}: the cursor row bottom is inside the dock`,
        ).toBeLessThanOrEqual(m.dock.bottom + 0.5);
        expect(m.dock.bottom, `${label}: the dock ends inside the frame`).toBeLessThanOrEqual(
          m.frame.bottom + 0.5,
        );
      };

      // (c) The ticker yields FIRST: whenever the board is below its preferred 70% of the frame (it
      // has yielded), the ticker must already be at its one-line floor. A board that gives up height
      // while the ticker keeps two or more lines is the cheat. The premise is asserted, not assumed.
      const expectTickerFirst = (m: Measure, label: string): void => {
        expect(
          m.board.height,
          `${label}: premise: the board is below its preferred 70% of the frame`,
        ).toBeLessThan(0.7 * m.frame.height - 4);
        expect(
          m.tickerContent,
          `${label}: the ticker is at its one-line floor (content ${m.tickerContent}, line ${m.lineHeight})`,
        ).toBeLessThanOrEqual(m.lineHeight + 0.5);
        expect(m.tickerContent, `${label}: and no less than one line`).toBeGreaterThanOrEqual(
          m.lineHeight - 0.5,
        );
      };
      expectTickerFirst(at1, 'x1, root menu open');

      await withRootFontSize(page, 32, async () => {
        const m = await ev<Measure>('window.__uif11.measure()');
        expectFrameLayout(m, 'root menu, doubled');
        expect(
          m.ticker.height,
          'the ticker keeps at least one line of its text',
        ).toBeGreaterThanOrEqual(m.lineHeight - 0.5);
        expectTickerFirst(m, 'root menu, doubled');
        expect(m.probeH, 'the nav-row probe is measured').not.toBeNull();
        const probeH = m.probeH as number;
        expectNear(probeH, 52.8, 0.5, 'a .mr-nav-item at a 32px root is 52.8px');
        expect(m.rows.length, 'every command row is measured').toBeGreaterThanOrEqual(6);
        for (const row of m.rows) {
          expectNear(row.height, probeH, 0.5, `the ${row.id} row is one nav row tall`);
        }
      });

      // The longest list: the Skills sub-list, cursor moved to its LAST row.
      await setWindow(VIEWPORT, 16);
      const skillRows = await ev<string[]>('window.__uif11.openSkills()');
      expect(
        skillRows.length,
        'fixture: Skills is the longest menu (8 skills)',
      ).toBeGreaterThanOrEqual(8);
      const last = skillRows[skillRows.length - 1] as string;
      await withRootFontSize(page, 32, async () => {
        const before = await ev<Measure>('window.__uif11.measure()');
        expect(
          await ev<boolean>(`window.__uif11.menuTo("${last}")`),
          'the cursor reaches the last skill row',
        ).toBe(true);
        const m = await ev<Measure>('window.__uif11.measure()');
        expect((m.cursor as RowRect | null)?.id, 'the cursor is on the last row').toBe(last);
        expectFrameLayout(m, 'Skills sub-list, doubled, cursor on the last row');
        expectTickerFirst(m, 'Skills sub-list, doubled');
        // Only the dock may scroll to keep the cursor row in view: the turn bar never moves and the
        // clipped root never scrolls.
        expectNear(m.turnbar.top, before.turnbar.top, 0.5, 'the turn bar top did not move');
        expectNear(
          m.turnbar.bottom,
          before.turnbar.bottom,
          0.5,
          'the turn bar bottom did not move',
        );
        expect(m.rootScrollTop, 'the tactical root did not scroll').toBe(before.rootScrollTop);
      });
    });
  });
