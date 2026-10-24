import { chromium, type FullConfig } from "@playwright/test";
import { loginWithKey, stateFile } from "./fixtures";

/** Signs the owner in once and saves the session cookie for every spec (specs that test login use a fresh context). */
export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0].use.baseURL!;
  const browser = await chromium.launch();
  const page = await browser.newPage({ baseURL });
  await loginWithKey(page);
  await page.context().storageState({ path: stateFile });
  await browser.close();
}
