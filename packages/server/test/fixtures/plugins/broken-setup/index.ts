export default {
  name: "broken",
  version: "0.0.1",
  setup(ctx: { hooks: { onWrite(fn: () => undefined): void } }) {
    ctx.hooks.onWrite(() => undefined);
    throw new Error("boom in setup");
  },
};
