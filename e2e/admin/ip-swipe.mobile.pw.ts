import { api, apiOk, expect, swipe, test, uid } from "./seed-users";

// the desktop project matches every *.pw.ts: these gestures only make sense on the phone layout
test.skip(({ isMobile }) => !isMobile, "phone layout only");

test.describe("IP rules on a phone", () => {
  test("swipe left removes a rule after confirming (no inline Remove button)", async ({ page }) => {
    const ip = `198.19.${Math.floor(Math.random() * 256)}.${1 + Math.floor(Math.random() * 254)}`;
    await apiOk("POST", "/ip-rules", { cidr: ip, action: "block", reason: uid("m") });
    try {
      await page.goto("ip-rules");
      const rule = page.getByText(ip, { exact: true });
      await expect(rule).toBeVisible();
      await expect(page.getByRole("button", { name: "Remove" })).toHaveCount(0);
      await swipe(page, rule.locator("../.."), "left");
      await expect(page.getByRole("alertdialog").getByText(`Remove rule for ${ip}?`)).toBeVisible();
      await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).tap();
      await expect(page.getByText("Rule removed")).toBeVisible();
      await expect(rule).toHaveCount(0);
    } finally {
      await api("DELETE", `/ip-rules/${encodeURIComponent(ip)}`);
    }
  });
});
