import type { Page, Route } from "@playwright/test";
import { test, expect } from "./seed-content";
import { http, newUser, note, ownerApi, publish, sign, uid, withWs } from "./seed-content";
import { waitListed } from "./seed-users";

/**
 * The e2e relay loads the bundled plugins hello and spam-filter (harness/serve.ts), so the "real relay" specs drive
 * them for real: list, enable/disable (and its effect on hello's public route and on spam scoring), the spam-filter
 * settings form, hello's admin page, dashboard widget and user action. The admin API cannot install plugins with
 * awkward schemas, so the JSON-editor specs answer the plugin endpoints with route mocks shaped like the real
 * PluginInfo / settings responses. The page itself is always the real admin UI.
 */
const schema = (title: string) => ({
  type: "object",
  properties: {
    label: { type: "string", default: title },
    // array of objects: no form widget for it, so the field falls back to the raw JSON editor
    rules: { type: "array", items: { type: "object", properties: { match: { type: "string" }, weight: { type: "number" } } } },
  },
});
const PLUGINS = {
  "json-alpha": { values: { label: "alpha", rules: [{ match: "alpha-1", weight: 1 }] } },
  "json-beta": { values: { label: "beta", rules: [{ match: "beta-1", weight: 2 }, { match: "beta-2", weight: 3 }] } },
} as const;
type Name = keyof typeof PLUGINS;

async function mockPlugins(page: Page) {
  const writes: { name: string; body: unknown }[] = [];
  await page.route(/\/admin\/api\/plugins$/, (r: Route) =>
    r.fulfill({
      json: {
        items: (Object.keys(PLUGINS) as Name[]).map((name) => ({
          name, version: "1.0.0", description: `${name} test plugin`, source: "local", enabled: true, status: "running", settingsSchema: schema(name),
        })),
      },
    }),
  );
  await page.route(/\/admin\/api\/plugins\/([^/]+)\/settings$/, (r: Route) => {
    const name = decodeURIComponent(r.request().url().match(/plugins\/([^/]+)\/settings$/)![1]) as Name;
    const m = r.request().method();
    if (m === "GET") return r.fulfill({ json: { values: PLUGINS[name].values, schema: schema(name) } });
    writes.push({ name, body: r.request().postDataJSON() });
    return r.fulfill({ json: { values: (r.request().postDataJSON() as { values: unknown }).values, schema: schema(name) } });
  });
  return writes;
}

const pretty = (v: unknown) => JSON.stringify(v, null, 2);
const jsonBox = (page: Page) => page.locator("textarea.font-mono");

interface PluginInfo { name: string; version: string; source: string; enabled: boolean; status: string; description: string }
const listPlugins = async () => {
  const r = await ownerApi<{ items: PluginInfo[] }>("GET", "/plugins");
  expect(r.status).toBe(200);
  return r.body.items;
};
const pluginInfo = async (name: string) => (await listPlugins()).find((p) => p.name === name)!;
const ensureEnabled = async (name: string) => {
  if (!(await pluginInfo(name)).enabled) expect((await ownerApi("POST", `/plugins/${name}/enable`)).status).toBe(200);
};
const spamSettings = async () => (await ownerApi<{ values: Record<string, unknown> }>("GET", "/plugins/spam-filter/settings")).body.values;
const helloStats = async () => (await ownerApi<{ seen: number; rejected: number; recent: { pubkey: string }[] }>("GET", "/plugins/x/hello/stats")).body;
const ping = async () => {
  const r = await fetch(`${http()}/plugins/hello/ping`);
  return { status: r.status, text: await r.text() };
};
/** 5 links from a brand-new account: link flood (0.6) + new account posting links (0.4) = the default threshold 1 */
const spammy = () => {
  const id = uid();
  return note(`spam ${id} ${["a", "b", "c", "d", "e"].map((h) => `https://${h}.${id}.example/x`).join(" ")}`, { sk: newUser().sk });
};
const tryPublish = (ev: ReturnType<typeof note>) => withWs((ws) => ws.publish(ev));
const pluginCard = (page: Page, name: string) => page.locator('[data-slot="card"]').filter({ has: page.getByText(name, { exact: true }) });
const sidebar = (page: Page) => page.locator('[data-slot="sidebar"]');

test.describe("plugins (real relay)", () => {
  test.afterEach(async () => {
    await ensureEnabled("hello");
    await ensureEnabled("spam-filter");
  });

  test("the list shows hello and spam-filter with version, state, source and hello's page link", async ({ page }) => {
    const api = await listPlugins();
    await page.goto("plugins");
    await expect(page.getByRole("heading", { level: 1, name: "Plugins" })).toBeVisible();
    await expect(page.getByText("No plugins installed")).toHaveCount(0);
    for (const name of ["hello", "spam-filter"]) {
      const info = api.find((p) => p.name === name)!;
      expect(info, name).toMatchObject({ version: "0.1.0", enabled: true, status: "running" });
      const card = pluginCard(page, name);
      await expect(card).toHaveCount(1);
      await expect(card.getByText(`v${info.version}`, { exact: true })).toBeVisible();
      await expect(card.getByText("running", { exact: true })).toBeVisible();
      await expect(card.getByText(info.source, { exact: true })).toBeVisible();
      await expect(card.getByText(info.description)).toBeVisible();
      await expect(card.getByRole("switch", { name: "Disable plugin" })).toHaveAttribute("data-state", "checked");
    }
    // only hello ships an admin UI with a page
    await expect(pluginCard(page, "hello").getByRole("link", { name: "Hello", exact: true })).toHaveAttribute("href", /\/admin\/p\/hello\/hello$/);
    await expect(pluginCard(page, "spam-filter").getByRole("link", { name: "Hello", exact: true })).toHaveCount(0);
    await expect(sidebar(page).getByRole("link", { name: "Hello", exact: true })).toBeVisible();
  });

  test("disabling hello stops its HTTP route and unloads its UI; enabling brings both back", async ({ page }) => {
    expect(await ping()).toEqual({ status: 200, text: "pong" });
    await page.goto("plugins");
    const card = pluginCard(page, "hello");
    await expect(sidebar(page).getByRole("link", { name: "Hello", exact: true })).toBeVisible();

    await card.getByRole("switch", { name: "Disable plugin" }).click();
    await expect(card.getByRole("switch", { name: "Enable plugin" })).toHaveAttribute("data-state", "unchecked");
    await expect(card.getByText("disabled", { exact: true })).toBeVisible();
    expect(await pluginInfo("hello")).toMatchObject({ enabled: false, status: "disabled" });
    expect((await ping()).status).toBe(404);
    await expect(sidebar(page).getByRole("link", { name: "Hello", exact: true })).toHaveCount(0);
    await expect(card.getByRole("link", { name: "Hello", exact: true })).toHaveCount(0);

    await card.getByRole("switch", { name: "Enable plugin" }).click();
    await expect(card.getByRole("switch", { name: "Disable plugin" })).toHaveAttribute("data-state", "checked");
    await expect(card.getByText("running", { exact: true })).toBeVisible();
    expect(await pluginInfo("hello")).toMatchObject({ enabled: true, status: "running" });
    expect(await ping()).toEqual({ status: 200, text: "pong" });
    await expect(sidebar(page).getByRole("link", { name: "Hello", exact: true })).toBeVisible();
  });

  test("disabling spam-filter on its detail page lets spam through; enabling blocks it again", async ({ page }) => {
    const blocked = await tryPublish(spammy());
    expect(blocked.ok, blocked.message).toBe(false);
    expect(blocked.message).toMatch(/looks like spam/);

    await page.goto("plugins/spam-filter");
    const sw = page.getByRole("switch").first();
    await expect(page.getByText("Enabled", { exact: true })).toBeVisible();
    await expect(sw).toHaveAttribute("data-state", "checked");
    await sw.click();
    await expect(sw).toHaveAttribute("data-state", "unchecked");
    await expect(page.locator('[data-slot="card-title"]').getByText("disabled", { exact: true })).toBeVisible();
    expect(await pluginInfo("spam-filter")).toMatchObject({ enabled: false, status: "disabled" });
    const through = await tryPublish(spammy());
    expect(through.ok, through.message).toBe(true);

    await sw.click();
    await expect(sw).toHaveAttribute("data-state", "checked");
    await expect(page.locator('[data-slot="card-title"]').getByText("running", { exact: true })).toBeVisible();
    expect(await pluginInfo("spam-filter")).toMatchObject({ enabled: true, status: "running" });
    expect((await tryPublish(spammy())).ok).toBe(false);
  });

  test.describe("spam-filter settings form", () => {
    let original: Record<string, unknown>;
    test.beforeEach(async () => {
      original = await spamSettings();
    });
    test.afterEach(async () => {
      expect((await ownerApi("PATCH", "/plugins/spam-filter/settings", { values: original })).status).toBe(200);
    });

    test("renders the schema's fields with the stored values", async ({ page }) => {
      await page.goto("plugins/spam-filter");
      await expect(page.getByText("Score at which an event is considered spam")).toBeVisible();
      await expect(page.getByLabel("Threshold", { exact: true })).toHaveValue(String(original.threshold));
      await expect(page.getByLabel("Max Links", { exact: true })).toHaveValue(String(original.maxLinks));
      await expect(page.getByRole("combobox", { name: "Action" })).toHaveText(String(original.action));
      await expect(page.getByRole("switch", { name: /Exempt Admins/ })).toHaveAttribute("data-state", original.exemptAdmins ? "checked" : "unchecked");
      const kinds = original.kinds as number[];
      await expect(page.getByRole("button", { name: /^Remove \d+$/ })).toHaveCount(kinds.length);
      for (const k of kinds) await expect(page.getByRole("button", { name: `Remove ${k}`, exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Save settings" })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Discard" })).toHaveCount(0);
    });

    test("Save stores the edit, persists across a reload and changes the scoring", async ({ page }) => {
      await page.goto("plugins/spam-filter");
      const threshold = page.getByLabel("Threshold", { exact: true });
      await expect(threshold).toHaveValue(String(original.threshold));
      await threshold.fill("5");
      await page.getByRole("combobox", { name: "Action" }).click();
      await page.getByRole("option", { name: "shadow" }).click();
      await page.getByRole("button", { name: "Save settings" }).click();
      await expect(page.getByText("Plugin settings saved")).toBeVisible();
      await expect(page.getByRole("button", { name: "Discard" })).toHaveCount(0);
      expect(await spamSettings()).toEqual({ ...original, threshold: 5, action: "shadow" });
      // a score of 1 is now below the threshold
      const r = await tryPublish(spammy());
      expect(r.ok, r.message).toBe(true);

      await page.reload();
      await expect(page.getByLabel("Threshold", { exact: true })).toHaveValue("5");
      await expect(page.getByRole("combobox", { name: "Action" })).toHaveText("shadow");
      await expect(page.getByRole("button", { name: "Save settings" })).toBeDisabled();
    });

    test("Discard drops the unsaved edit without a request", async ({ page }) => {
      let writes = 0;
      page.on("request", (r) => r.url().includes("/plugins/spam-filter/settings") && r.method() !== "GET" && writes++);
      await page.goto("plugins/spam-filter");
      const threshold = page.getByLabel("Threshold", { exact: true });
      const maxLinks = page.getByLabel("Max Links", { exact: true });
      await expect(threshold).toHaveValue(String(original.threshold));
      await threshold.fill("7");
      await maxLinks.fill("99");
      await expect(page.getByRole("button", { name: "Save settings" })).toBeEnabled();
      await page.getByRole("button", { name: "Discard" }).click();
      await expect(threshold).toHaveValue(String(original.threshold));
      await expect(maxLinks).toHaveValue(String(original.maxLinks));
      await expect(page.getByRole("button", { name: "Discard" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Save settings" })).toBeDisabled();
      await page.reload();
      await expect(threshold).toHaveValue(String(original.threshold));
      expect(writes).toBe(0);
      expect(await spamSettings()).toEqual(original);
    });
  });

  test("hello's admin page shows the server's counters and its rejections; Reset clears them", async ({ page }) => {
    const u = newUser();
    const r = await tryPublish(sign(u.sk, { kind: 1, content: `contains forbidden-word ${uid()}` }));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/forbidden word/);
    const stats = await helloStats();
    expect(stats.rejected).toBeGreaterThan(0);
    expect(stats.recent.some((x) => x.pubkey === u.pubkey)).toBe(true);

    await page.goto("plugins");
    await sidebar(page).getByRole("link", { name: "Hello", exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/p\/hello\/hello$/);
    await expect(page.getByRole("heading", { level: 2, name: "Hello plugin" })).toBeVisible();
    await expect(page.getByText(`rejected: ${stats.rejected}`, { exact: true })).toBeVisible();
    await expect(page.getByText(/^seen: \d+$/)).toBeVisible();
    await expect(page.getByRole("listitem").filter({ hasText: u.pubkey.slice(0, 12) })).toContainText('contains "forbidden-word"');

    await page.getByRole("button", { name: "Reset counters" }).click();
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Counters reset" })).toBeVisible();
    await expect(page.getByText("rejected: 0", { exact: true })).toBeVisible();
    await expect(page.getByText("No rejections yet.")).toBeVisible();
    expect(await helloStats()).toMatchObject({ rejected: 0, recent: [] });
  });

  test("an unregistered page under /p/hello/ says so", async ({ page }) => {
    await page.goto("p/hello/nope");
    await expect(page.getByText("Plugin page not found")).toBeVisible();
    await expect(page.getByText("No page “/nope” is registered by hello.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Plugin details" })).toHaveAttribute("href", /\/admin\/plugins\/hello$/);
  });

  test("hello's dashboard widget shows the rejected count", async ({ page }) => {
    expect((await tryPublish(sign(newUser().sk, { kind: 1, content: `forbidden-word ${uid()}` }))).ok).toBe(false);
    const { rejected } = await helloStats();
    await page.goto("./");
    const widget = page.locator('[data-slot="card"]').filter({ has: page.locator('[data-slot="card-title"]', { hasText: /^Hello plugin$/ }) });
    await expect(widget.locator('[data-slot="card-description"]')).toHaveText("hello");
    await expect(widget.getByText("events blocked by hello")).toBeVisible();
    await expect(widget.locator('[data-slot="card-content"]')).toContainText(new RegExp(`^${rejected}\\s*events blocked by hello`));
  });

  test("hello's user action runs from the users list row menu and the user detail menu", async ({ page }) => {
    const u = newUser();
    const name = `hello-target ${uid()}`;
    await publish(sign(u.sk, { kind: 0, content: JSON.stringify({ name }) }));
    const greeting = page.locator("[data-sonner-toast]").filter({ hasText: `Hello ${u.pubkey.slice(0, 8)}…!` });

    await waitListed(u.pubkey);
    await page.goto(`users?search=${u.pubkey}`);
    const row = page.locator("tbody tr").filter({ hasText: name });
    await row.getByRole("button", { name: "Actions" }).click();
    await expect(page.getByRole("menu").getByText("Plugins", { exact: true })).toBeVisible();
    await page.getByRole("menuitem", { name: "Say hello (example)" }).click();
    await expect(greeting).toBeVisible();

    await page.goto(`users/${u.pubkey}`);
    await expect(greeting).toHaveCount(0);
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Say hello (example)" }).click();
    // a full navigation dropped the first toast: this one comes from the detail page's menu
    await expect(greeting).toBeVisible();
  });

  test("an unknown plugin page says it was not found", async ({ page }) => {
    await page.goto("plugins/no-such-plugin");
    await expect(page.getByText("Plugin “no-such-plugin” not found")).toBeVisible();
    await expect(page.getByRole("link", { name: "Plugins" }).last()).toBeVisible();
  });
});

test.describe("plugin JSON settings editor", () => {
  // routes mock API calls: keep the PWA service worker out, or requests it has claimed bypass page.route (seed-users fail500)
  test.use({ serviceWorkers: "block" });
  test("Discard resets the textarea text, also after an invalid edit", async ({ page }) => {
    const writes = await mockPlugins(page);
    await page.goto("plugins/json-alpha");
    const box = jsonBox(page);
    await expect(box).toHaveValue(pretty(PLUGINS["json-alpha"].values.rules));
    await expect(page.getByRole("button", { name: "Save settings" })).toBeDisabled();

    await box.fill(JSON.stringify([{ match: "changed", weight: 9 }]));
    await expect(page.getByRole("button", { name: "Discard" })).toBeVisible();
    await box.fill("[{ broken");
    await expect(page.getByText(/JSON|Expected|Unexpected/).last()).toBeVisible();
    await page.getByRole("button", { name: "Discard" }).click();
    await expect(box).toHaveValue(pretty(PLUGINS["json-alpha"].values.rules));
    await expect(box).not.toHaveAttribute("aria-invalid", "true");
    await expect(page.getByRole("button", { name: "Discard" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save settings" })).toBeDisabled();
    expect(writes).toEqual([]);
  });

  test("invalid JSON blocks Save: no request is sent", async ({ page }) => {
    const writes = await mockPlugins(page);
    let sent = 0;
    page.on("request", (r) => /\/plugins\/[^/]+\/settings$/.test(r.url()) && ["PATCH", "PUT", "POST"].includes(r.method()) && sent++);
    await page.goto("plugins/json-alpha");
    const box = jsonBox(page);
    await expect(box).toHaveValue(pretty(PLUGINS["json-alpha"].values.rules));
    // a valid edit enables Save, then the text turns invalid
    await box.fill(JSON.stringify([{ match: "valid-first" }]));
    await box.fill('[{"match": "oops",]');
    await expect(box).toHaveAttribute("aria-invalid", "true");
    await page.getByRole("button", { name: "Save settings" }).click();
    expect(await box.evaluate((el: HTMLTextAreaElement) => el.validationMessage)).toMatch(/Invalid JSON/);
    await page.waitForTimeout(300);
    expect(sent).toBe(0);
    expect(writes).toEqual([]);
    await expect(page.getByText("Plugin settings saved")).toHaveCount(0);
  });

  test("a valid edit saves the parsed value", async ({ page }) => {
    const writes = await mockPlugins(page);
    await page.goto("plugins/json-alpha");
    const box = jsonBox(page);
    await expect(box).toHaveValue(pretty(PLUGINS["json-alpha"].values.rules));
    const rules = [{ match: "saved", weight: 5 }];
    await box.fill(JSON.stringify(rules));
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByText("Plugin settings saved")).toBeVisible();
    expect(writes).toEqual([{ name: "json-alpha", body: { values: { label: "alpha", rules } } }]);
  });

  test("navigating between two plugins shows each one's JSON", async ({ page }) => {
    await mockPlugins(page);
    await page.goto("plugins");
    await page.getByRole("link", { name: /json-alpha/ }).first().click();
    const box = jsonBox(page);
    await expect(box).toHaveValue(pretty(PLUGINS["json-alpha"].values.rules));
    // an unsaved edit on alpha must not leak into beta
    await box.fill(JSON.stringify([{ match: "draft-alpha" }]));

    await page.getByRole("link", { name: "Plugins" }).last().click();
    await page.getByRole("link", { name: /json-beta/ }).first().click();
    await expect(page.getByText("json-beta test plugin")).toBeVisible();
    await expect(box).toHaveValue(pretty(PLUGINS["json-beta"].values.rules));
    await expect(page.getByRole("textbox", { name: "Label" })).toHaveValue("beta");

    await page.goBack();
    await page.goBack();
    await expect(page).toHaveURL(/plugins\/json-alpha$/);
    await expect(box).toHaveValue(pretty(PLUGINS["json-alpha"].values.rules));
    await page.goForward();
    await page.goForward();
    await expect(page).toHaveURL(/plugins\/json-beta$/);
    await expect(box).toHaveValue(pretty(PLUGINS["json-beta"].values.rules));
  });
});
