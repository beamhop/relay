// top-level code that never finishes: importing this module must not block plugin loading forever
await new Promise(() => {});

export default { name: "hang-import", version: "1.0.0", setup() {} };
